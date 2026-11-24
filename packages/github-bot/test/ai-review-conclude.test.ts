import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import type { BotReviewPayload } from "../src/types";
import type * as GitHubAuth from "../src/github-auth";
import type * as GitHubChecks from "../src/github-checks";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn(),
  postReaction: vi.fn(),
  postIssueComment: vi.fn(),
  checkSenderPermission: vi.fn(),
  listPullRequestReviews: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubChecks>()),
  createCheckRun: vi.fn(),
  updateCheckRun: vi.fn(),
  getCompareDiff: vi.fn(),
  listOpenPullsWithHead: vi.fn(),
  findSuiteReviewRun: vi.fn(),
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import { concludeStuckCheck, handleBotReviewChanged } from "../src/ai-review-check";
import { getPullRequest, listPullRequestReviews } from "../src/github-auth";
import { createCheckRun, listOpenPullsWithHead, updateCheckRun } from "../src/github-checks";
import { getGitHubConfig } from "../src/utils/integration-config";
import {
  attempt,
  ATTEMPT_KEY,
  BASE,
  botReview,
  createEnv,
  createLogger,
  DIFF_HASH,
  HEAD,
  KEY_A,
  KEY_B,
  livePull,
  marker,
  OLD_HEAD,
  repository,
  resetGateMocks,
  review,
  twoReviewerKeys,
  useConfig,
  verdict,
  VERDICT_KEY,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

const APPROVE_SUMMARY = "- Claude Haiku 4.5: approve ([review](https://github.test/review/1))";
const lastState = () => vi.mocked(updateCheckRun).mock.calls.at(-1)?.[2];
const evaluate = (env: ReturnType<typeof createEnv>["env"], payload = botReview) =>
  handleBotReviewChanged(env, createLogger(), payload, "trace");

describe("bot review submitted", () => {
  it("passes the check when the single reviewer approves, and remembers the verdict", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    const result = await evaluate(env);

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_approved" });
    expect(updateCheckRun).toHaveBeenCalledWith(expect.anything(), 7, {
      status: "completed",
      conclusion: "success",
      output: { title: "Approved", summary: APPROVE_SUMMARY },
      reviewAction: false,
    });
    expect(json(VERDICT_KEY)).toEqual({
      sha: HEAD,
      reviewedSha: HEAD,
      baseRef: "main",
      baseSha: BASE,
      diffHash: DIFF_HASH,
      approved: true,
      summary: APPROVE_SUMMARY,
      attemptId: attempt().id,
    });
    expect(json(ATTEMPT_KEY).concludedAt).toEqual(expect.any(String));
  });

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes findings in %s mode as %s", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    const result = await evaluate(env);

    expect(result).toMatchObject({ handler_action: "check_not_approved" });
    expect(lastState()).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "Changes requested" },
    });
    const summary = lastState()?.output.summary ?? "";
    expect(summary).toContain("- Claude Haiku 4.5: changes requested");
    expect(summary).toContain("`@test-bot override <commit> <reason>`");
    expect(summary.includes("Shadow mode")).toBe(mergeGate === "shadow");
    expect(json(VERDICT_KEY)).toMatchObject({ approved: false });
    // A failed verdict needs no check that the pull request is alone on its commit.
    expect(listOpenPullsWithHead).not.toHaveBeenCalled();
  });

  it.each([
    ["the approve marker as its last line", `Verdict: approve\n${ADVISORY_APPROVE_MARKER}`, true],
    [
      "the attempt marker after the approve marker",
      `Verdict: approve\n${ADVISORY_APPROVE_MARKER}\n${marker(KEY_A)}\n`,
      true,
    ],
    ["no approve marker", "Verdict: approve", false],
    ["the approve marker quoted", `Not yet.\n> ${ADVISORY_APPROVE_MARKER}`, false],
    ["the approve marker inside a sentence", `I will not add ${ADVISORY_APPROVE_MARKER}`, false],
    [
      "the approve marker followed by more text",
      `${ADVISORY_APPROVE_MARKER}\nActually, request changes.`,
      false,
    ],
  ])("reads a comment-only review with %s", async (_name, text, approves) => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "COMMENTED", body: `${marker(KEY_A)}\n${text}` }),
    ]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    await evaluate(env);

    expect(lastState()).toMatchObject({ conclusion: approves ? "success" : "failure" });
  });

  it("never reads a changes-requested review as an approval", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({
        state: "CHANGES_REQUESTED",
        body: `${marker(KEY_A)}\n${ADVISORY_APPROVE_MARKER}`,
      }),
    ]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    await evaluate(env);

    expect(lastState()).toMatchObject({ conclusion: "failure" });
  });

  it("waits until every reviewer of the attempt has posted, then names each", async () => {
    const first = review({ body: `approve\n${marker(KEY_A)}\n${ADVISORY_APPROVE_MARKER}` });
    vi.mocked(listPullRequestReviews).mockResolvedValue([first]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt({ reviewers: twoReviewerKeys }));

    expect(await evaluate(env)).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
    expect(updateCheckRun).not.toHaveBeenCalled();

    vi.mocked(listPullRequestReviews).mockResolvedValue([
      first,
      review({ state: "CHANGES_REQUESTED", body: marker(KEY_B), url: "https://github.test/r/2" }),
    ]);
    await evaluate(env);

    expect(lastState()).toMatchObject({ conclusion: "failure" });
    expect(lastState()?.output.summary).toContain(
      `${APPROVE_SUMMARY}\n- GPT 5.6 Sol: changes requested ([review](https://github.test/r/2))`
    );
  });

  it("does not count reviews without a marker of the attempt on a line of its own", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", body: "Approved from a comment session." }),
      review({ state: "APPROVED", body: marker(KEY_A, "another-attempt") }),
      review({ state: "APPROVED", body: `The reviewer will write ${marker(KEY_A)} here.` }),
      review({ state: "APPROVED", login: "carol" }),
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    expect(await evaluate(env)).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("counts only each reviewer's first review, so a copied marker changes nothing", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "CHANGES_REQUESTED" }),
      review({ state: "APPROVED", url: "https://github.test/review/forged" }),
    ]);
    const { env, seed } = createEnv();

    // One reviewer's marker twice does not stand in for the second reviewer.
    seed(ATTEMPT_KEY, attempt({ reviewers: twoReviewerKeys }));
    expect(await evaluate(env)).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });

    seed(ATTEMPT_KEY, attempt());
    await evaluate(env);
    expect(lastState()).toMatchObject({ conclusion: "failure" });
    expect(lastState()?.output.summary).not.toContain("forged");
  });

  it("ignores a bot review when no attempt is on its commit or its check run is not made yet", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, seed } = createEnv();

    const none = await evaluate(env);
    seed(ATTEMPT_KEY, attempt({ headSha: OLD_HEAD }));
    const otherCommit = await evaluate(env);
    seed(ATTEMPT_KEY, attempt({ prNumber: 43 }));
    const otherPull = await evaluate(env);
    seed(ATTEMPT_KEY, attempt({ checkRunId: null }));
    const noCheck = await evaluate(env);

    const skip = (skip_reason: string) => ({ outcome: "skipped", skip_reason });
    expect([none, otherCommit, otherPull, noCheck]).toEqual([
      skip("no_review_attempt"),
      skip("no_review_attempt"),
      skip("no_review_attempt"),
      skip("check_not_created"),
    ]);
    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes the reviewed commit's own check run when it is no longer the head", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    vi.mocked(listOpenPullsWithHead).mockResolvedValue([]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt({ headSha: OLD_HEAD, checkRunId: 3 }));
    const payload: BotReviewPayload = {
      ...botReview,
      review: { ...botReview.review, commit_id: OLD_HEAD },
    };

    await evaluate(env, payload);

    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      3,
      expect.objectContaining({ conclusion: "success" })
    );
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD, reviewedSha: OLD_HEAD });
  });

  it("skips while the gate is off and for reviews by anyone else", async () => {
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());
    const human = { ...botReview, review: { ...botReview.review, user: { login: "carol" } } };
    expect(await evaluate(env, human)).toEqual({
      outcome: "skipped",
      skip_reason: "review_not_by_bot",
    });

    useConfig({ mergeGate: "off" });
    expect(await evaluate(env)).toEqual({ outcome: "skipped", skip_reason: "merge_gate_off" });
    expect(listPullRequestReviews).not.toHaveBeenCalled();
  });

  it("fails the delivery when GitHub cannot be read or the check cannot be written", async () => {
    const { env, seed, json } = createEnv();
    seed(ATTEMPT_KEY, attempt());
    vi.mocked(listPullRequestReviews).mockResolvedValue(null);
    await expect(evaluate(env)).rejects.toThrow("Reviews unreadable");

    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(updateCheckRun).mockResolvedValue(false);
    await expect(evaluate(env)).rejects.toThrow("could not be written");
    expect(json(ATTEMPT_KEY).concludedAt).toBeNull();
    expect(json(VERDICT_KEY)).toBeNull();
  });
});

describe("an approval passes only its own pull request", () => {
  it.each([
    ["another open pull request has the same head commit", [42, 57], "#57"],
    ["GitHub cannot say which pull requests are on the commit", null, "Could not confirm"],
  ])("asks for a review instead when %s", async (_name, pulls, text) => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(listOpenPullsWithHead).mockResolvedValue(pulls);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    const result = await evaluate(env);

    expect(result).toMatchObject({ handler_action: "check_needs_review" });
    expect(lastState()).toMatchObject({ conclusion: "action_required", reviewAction: true });
    expect(lastState()?.output.summary).toContain(text);
    expect(json(VERDICT_KEY)).toBeNull();
  });

  it("asks for a review instead when the base branch changed during the review", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(getPullRequest).mockResolvedValue({
      ...livePull,
      base: { ref: "release", sha: BASE },
    });
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    await evaluate(env);

    expect(lastState()).toMatchObject({ conclusion: "action_required" });
    expect(lastState()?.output.summary).toContain("from `main` to `release`");
    expect(json(VERDICT_KEY)).toBeNull();
  });
});

describe("reviews that change after the check concluded", () => {
  const dismissed: BotReviewPayload = { ...botReview, action: "dismissed" };
  const concluded = () => attempt({ concludedAt: "2026-11-23T10:06:00.000Z" });

  it("takes the pass back when the bot's approving review is dismissed", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "DISMISSED" })]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, concluded());
    seed(VERDICT_KEY, verdict());

    const result = await evaluate(env, dismissed);

    expect(result).toMatchObject({ handler_action: "check_not_approved" });
    expect(lastState()).toMatchObject({ conclusion: "failure", reviewAction: true });
    expect(lastState()?.output.summary).toContain("- Claude Haiku 4.5: dismissed");
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: false });
  });

  it("does not let a later review with the same marker replace a dismissed one", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "DISMISSED" }),
      review({ state: "APPROVED", url: "https://github.test/review/again" }),
    ]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, concluded());
    seed(VERDICT_KEY, verdict());

    await evaluate(env, dismissed);

    expect(lastState()).toMatchObject({ conclusion: "failure" });
  });

  it("takes back a verdict that was carried forward to a later head", async () => {
    const carriedTo = "e".repeat(40);
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "DISMISSED" })]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, concluded());
    seed(VERDICT_KEY, verdict({ sha: carriedTo }));

    await evaluate(env, dismissed);

    expect(json(VERDICT_KEY)).toMatchObject({ sha: carriedTo, reviewedSha: HEAD, approved: false });
    const [, run, state] = vi.mocked(createCheckRun).mock.calls[0];
    expect(run).toMatchObject({ headSha: carriedTo, externalId: "open-inspect:pr=42" });
    expect(state).toMatchObject({
      conclusion: "failure",
      output: { title: "Not approved (carried forward)" },
    });
  });

  it("leaves an override alone: it has no attempt to conclude", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "DISMISSED" })]);
    const { env, json, seed } = createEnv();
    seed(VERDICT_KEY, verdict({ attemptId: null }));

    expect(await evaluate(env, dismissed)).toEqual({
      outcome: "skipped",
      skip_reason: "no_review_attempt",
    });
    expect(json(VERDICT_KEY)).toMatchObject({ approved: true });
  });

  it("writes nothing when another bot review on the commit changes no verdict", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED" }),
      review({ state: "CHANGES_REQUESTED", body: "From a comment session." }),
    ]);
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, concluded());
    seed(VERDICT_KEY, verdict());

    expect(await evaluate(env)).toEqual({ outcome: "skipped", skip_reason: "verdict_unchanged" });
    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes from a review that posts after the attempt was closed as unfinished", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, json, seed } = createEnv();
    seed(ATTEMPT_KEY, concluded());

    await evaluate(env);

    expect(lastState()).toMatchObject({ conclusion: "success" });
    expect(json(VERDICT_KEY)).toMatchObject({ approved: true });
  });
});

describe("stuck check", () => {
  const stuck = (env: ReturnType<typeof createEnv>["env"]) =>
    concludeStuckCheck(env, createLogger(), repository, 42);

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes a silent review in %s mode as %s", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review()]);
    const { env, seed, json } = createEnv();
    seed(ATTEMPT_KEY, attempt({ reviewers: twoReviewerKeys }));

    await stuck(env);

    expect(updateCheckRun).toHaveBeenCalledWith(expect.anything(), 7, expect.anything());
    expect(lastState()).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "The AI review did not finish" },
    });
    expect(lastState()?.output.summary).toContain("1 of 2 reviews posted");
    expect(lastState()?.output.summary).toContain("Re-run this check");
    expect(json(ATTEMPT_KEY).concludedAt).toEqual(expect.any(String));
    expect(json(VERDICT_KEY)).toBeNull();
  });

  it("leaves a review alone inside the window, and an attempt that already concluded", async () => {
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt({ startedAt: new Date(Date.now() - 29 * 60 * 1000).toISOString() }));
    await stuck(env);

    seed(ATTEMPT_KEY, attempt({ concludedAt: "2020-01-01T00:40:00.000Z" }));
    await stuck(env);

    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("does nothing for a pull request with no attempt", async () => {
    const { env } = createEnv();

    await stuck(env);

    expect(getGitHubConfig).not.toHaveBeenCalled();
  });

  it("concludes from the reviews when they posted but their webhook was missed", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, seed, json } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    await stuck(env);

    expect(lastState()).toMatchObject({ conclusion: "success" });
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: true });
  });

  it.each([
    ["the gate was turned off", { mergeGate: "off" as const }, {}],
    ["its check run was never made", {}, { checkRunId: null }],
  ])("forgets an attempt when %s", async (_name, config, record) => {
    useConfig(config);
    const { env, seed, json } = createEnv();
    seed(ATTEMPT_KEY, attempt(record));

    await stuck(env);

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(json(ATTEMPT_KEY)).toBeNull();
  });
});
