import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import type {
  PullRequestChangedPayload,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
} from "../src/types";
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
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import {
  concludeStuckCheck,
  handleBotReviewSubmitted,
  handlePullRequestChanged,
  normalizeDiff,
  STUCK_REVIEW_MS,
} from "../src/ai-review-check";
import { handlePullRequestOpened, handleReviewRequested } from "../src/handlers";
import { checkSenderPermission, listPullRequestReviews } from "../src/github-auth";
import { createCheckRun, getCompareDiff, updateCheckRun } from "../src/github-checks";
import { getGitHubConfig } from "../src/utils/integration-config";
import {
  alice,
  BASE,
  BOT,
  botReview,
  createEnv,
  createLogger,
  defaultControlPlane,
  HEAD,
  marker,
  OLD_HEAD,
  opened,
  prompts,
  pullRequest,
  repository,
  resetGateMocks,
  review,
  run,
  RUN_DIFF_HASH,
  RUN_KEY,
  RUN_START,
  sha256Hex,
  synchronized,
  TOKEN_A,
  TOKEN_B,
  twoReviewers,
  useConfig,
  VERDICT_KEY,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

describe("opening review", () => {
  it("shows the check in progress and gives the reviewer a marker for its review", async () => {
    const { env, json, controlPlaneFetch } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "auto_review" });
    expect(createCheckRun).toHaveBeenCalledOnce();
    const [client, sha, startedAt, state] = vi.mocked(createCheckRun).mock.calls[0];
    expect(client.repoUrl).toBe("https://api.github.com/repos/acme/widgets");
    expect(sha).toBe(HEAD);
    expect(state).toMatchObject({ status: "in_progress" });
    const recorded = json(RUN_KEY);
    expect(recorded).toEqual({
      sha: HEAD,
      startedAt,
      checkRunId: 7,
      tokens: [expect.any(String)],
      expected: 1,
      diffHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(getCompareDiff).toHaveBeenCalledWith(expect.anything(), BASE, HEAD);
    expect(prompts(controlPlaneFetch)).toEqual([
      expect.stringContaining(`on a line of its own:\n   ${marker(recorded.tokens[0])}`),
    ]);
  });

  it("gives each of several reviewers its own marker", async () => {
    useConfig({ reviewers: twoReviewers });
    const { env, json, controlPlaneFetch } = createEnv();
    controlPlaneFetch.mockImplementation(async (url: string) =>
      url === "https://internal/model-preferences?strict=true"
        ? Response.json({ enabledModels: twoReviewers.map((reviewer) => reviewer.model) })
        : defaultControlPlane(url)
    );

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    const { tokens, expected } = json(RUN_KEY);
    expect(expected).toBe(2);
    expect(new Set(tokens).size).toBe(2);
    const sent = prompts(controlPlaneFetch);
    expect(sent).toHaveLength(2);
    for (const token of tokens) {
      expect(sent.filter((prompt) => prompt.includes(marker(token)))).toHaveLength(1);
    }
  });

  it("posts no check while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, sessionsStarted, controlPlaneFetch } = createEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(prompts(controlPlaneFetch)[0]).not.toContain("review-run=");
  });

  it("posts no check for a repository the bot is not enabled on", async () => {
    useConfig({ enabledRepos: ["acme/other"] });
    const { env } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "repo_not_enabled" });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)("asks for a review in %s mode when none started", async (mergeGate, conclusion) => {
    useConfig({ mergeGate, autoReviewOnOpen: false });
    const { env, json } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "auto_review_disabled" });
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      status: "completed",
      conclusion,
      reviewAction: true,
      output: { title: "Re-run the AI review before merging" },
    });
    expect(json(RUN_KEY)).toBeNull();
  });

  it("asks for a review when the session start fails, and still fails the delivery", async () => {
    const { env, controlPlaneFetch } = createEnv();
    controlPlaneFetch.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(handlePullRequestOpened(env, createLogger(), opened, "trace")).rejects.toThrow();

    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "action_required",
    });
  });

  it("logs a refused check write without failing a review that started", async () => {
    vi.mocked(createCheckRun).mockResolvedValue(null);
    const { env, json } = createEnv();
    const log = createLogger();

    const result = await handlePullRequestOpened(env, log, opened, "trace");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(log.error).toHaveBeenCalledWith("check.create_failed", expect.anything());
    expect(json(RUN_KEY)).toBeNull();
  });

  it("reviews a pull request leaving draft only when the gate is on", async () => {
    const ready: PullRequestOpenedPayload = { ...opened, action: "ready_for_review" };
    const { env, sessionsStarted } = createEnv();

    await handlePullRequestOpened(env, createLogger(), ready, "trace");
    expect(sessionsStarted()).toBe(1);
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({ status: "in_progress" });

    useConfig({ mergeGate: "off" });
    const off = createEnv();
    const result = await handlePullRequestOpened(off.env, createLogger(), ready, "trace");
    expect(result).toEqual({ outcome: "skipped", skip_reason: "merge_gate_off" });
    expect(off.sessionsStarted()).toBe(0);
  });

  it("shows a requested review in progress, and leaves the check alone when it is refused", async () => {
    const requested: ReviewRequestedPayload = {
      action: "review_requested",
      pull_request: pullRequest,
      requested_reviewer: { login: BOT },
      repository,
      sender: alice,
    };
    const { env } = createEnv();

    await handleReviewRequested(env, createLogger(), requested, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({ status: "in_progress" });

    vi.mocked(createCheckRun).mockClear();
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const result = await handleReviewRequested(env, createLogger(), requested, "trace");
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});

describe("bot review submitted", () => {
  it("passes the check when the single reviewer approves, and remembers the verdict", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, json, seed } = createEnv();
    seed(RUN_KEY, run());

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_approved" });
    expect(updateCheckRun).toHaveBeenCalledWith(expect.anything(), 7, {
      status: "completed",
      conclusion: "success",
      output: {
        title: "Approved",
        summary: "- AI review: approve ([review](https://github.test/review/1))",
      },
      reviewAction: false,
    });
    expect(json(VERDICT_KEY)).toEqual({
      sha: HEAD,
      reviewedSha: HEAD,
      approved: true,
      diffHash: RUN_DIFF_HASH,
      summary: "- AI review: approve ([review](https://github.test/review/1))",
    });
    expect(json(RUN_KEY)).toBeNull();
  });

  it("counts a comment-only review that carries the approve marker", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ body: `Verdict: approve\n${marker(TOKEN_A)}\n${ADVISORY_APPROVE_MARKER}` }),
    ]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run());

    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({ conclusion: "success" });
  });

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes findings in %s mode as %s", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);
    const { env, json, seed } = createEnv();
    seed(RUN_KEY, run());

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toMatchObject({ handler_action: "check_not_approved" });
    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "Changes requested" },
    });
    expect(state.output.summary).toContain("changes requested");
    expect(state.output.summary).toContain("`@test-bot override <reason>`");
    expect(state.output.summary.includes("Shadow mode")).toBe(mergeGate === "shadow");
    expect(json(VERDICT_KEY)).toMatchObject({ approved: false });
  });

  it("waits until every reviewer session of the run has posted", async () => {
    const first = review({
      body: `**Reviewer: Haiku**\napprove\n${marker(TOKEN_A)}\n${ADVISORY_APPROVE_MARKER}`,
    });
    vi.mocked(listPullRequestReviews).mockResolvedValue([first]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run({ tokens: [TOKEN_A, TOKEN_B], expected: 2 }));

    const waiting = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");
    expect(waiting).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
    expect(updateCheckRun).not.toHaveBeenCalled();

    vi.mocked(listPullRequestReviews).mockResolvedValue([
      first,
      review({
        body: `**Reviewer: Sol**\napprove\n${marker(TOKEN_B)}\n${ADVISORY_APPROVE_MARKER}`,
        url: "https://github.test/review/2",
      }),
    ]);
    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({
      conclusion: "success",
      output: {
        summary:
          "- Haiku: approve ([review](https://github.test/review/1))\n" +
          "- Sol: approve ([review](https://github.test/review/2))",
      },
    });
  });

  it("fails when any reviewer does not approve", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ body: `**Reviewer: Haiku**\n${marker(TOKEN_A)}\n${ADVISORY_APPROVE_MARKER}` }),
      review({ body: `**Reviewer: Sol**\nrequest changes\n${marker(TOKEN_B)}` }),
    ]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run({ tokens: [TOKEN_A, TOKEN_B], expected: 2 }));

    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({ conclusion: "failure" });
    expect(state.output.summary).toContain("- Sol: changes requested");
  });

  it("does not count reviews without a marker of the run", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", body: "Approved from a comment session." }),
      review({ state: "APPROVED", body: marker("some-other-run") }),
      review({ state: "DISMISSED" }),
      review({ state: "APPROVED", login: "carol" }),
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run());

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("counts only the first review for each marker, so a copied marker changes nothing", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "CHANGES_REQUESTED" }),
      review({ state: "APPROVED", url: "https://github.test/review/forged" }),
    ]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run({ tokens: [TOKEN_A, TOKEN_B], expected: 2 }));

    // One session's marker twice does not stand in for the second reviewer.
    expect(await handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).toEqual({
      outcome: "skipped",
      skip_reason: "awaiting_reviewers",
    });

    seed(RUN_KEY, run());
    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");
    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({ conclusion: "failure" });
    expect(state.output.summary).not.toContain("forged");
  });

  it("cannot pass a run in which a configured reviewer never started", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, seed } = createEnv();
    seed(RUN_KEY, run({ tokens: [TOKEN_A], expected: 2 }));

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
  });

  it("ignores a bot review when no run is in flight on its commit", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, seed } = createEnv();

    const none = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");
    seed(RUN_KEY, run({ sha: OLD_HEAD }));
    const other = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect([none, other]).toEqual([
      { outcome: "skipped", skip_reason: "no_review_run" },
      { outcome: "skipped", skip_reason: "no_review_run" },
    ]);
    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes the reviewed commit's own check run when it is no longer the head", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    const { env, json, seed } = createEnv();
    seed(RUN_KEY, run({ sha: OLD_HEAD, checkRunId: 3 }));

    await handleBotReviewSubmitted(
      env,
      createLogger(),
      { ...botReview, review: { ...botReview.review, commit_id: OLD_HEAD } },
      "trace"
    );

    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      3,
      expect.objectContaining({ conclusion: "success" })
    );
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD, diffHash: RUN_DIFF_HASH });
  });

  it("skips while the gate is off and for reviews by anyone else", async () => {
    const { env, seed } = createEnv();
    seed(RUN_KEY, run());
    const human = { ...botReview, review: { ...botReview.review, user: { login: "carol" } } };
    expect(await handleBotReviewSubmitted(env, createLogger(), human, "trace")).toEqual({
      outcome: "skipped",
      skip_reason: "review_not_by_bot",
    });

    useConfig({ mergeGate: "off" });
    expect(await handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).toEqual({
      outcome: "skipped",
      skip_reason: "merge_gate_off",
    });
    expect(listPullRequestReviews).not.toHaveBeenCalled();
  });

  it("fails the delivery when GitHub cannot be read or the check cannot be written", async () => {
    const { env, seed, json } = createEnv();
    seed(RUN_KEY, run());
    vi.mocked(listPullRequestReviews).mockResolvedValue(null);
    await expect(handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).rejects.toThrow(
      "Reviews unreadable"
    );

    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(updateCheckRun).mockResolvedValue(false);
    await expect(handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).rejects.toThrow(
      "could not be written"
    );
    expect(json(RUN_KEY)).not.toBeNull();
    expect(json(VERDICT_KEY)).toBeNull();
  });
});

describe("new head or new base", () => {
  const verdictFor = async (diff: string, overrides: object = {}) => ({
    sha: OLD_HEAD,
    reviewedSha: OLD_HEAD,
    diffHash: await sha256Hex(normalizeDiff(diff)),
    approved: true,
    summary: "- AI review: approve",
    ...overrides,
  });

  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)("asks for a review of a new head in %s mode", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    const { env, sessionsStarted } = createEnv();

    const result = await handlePullRequestChanged(env, createLogger(), synchronized, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_needs_review" });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).toHaveBeenCalledWith(expect.anything(), HEAD, expect.any(String), {
      status: "completed",
      conclusion,
      output: {
        title: "Re-run the AI review before merging",
        summary: expect.stringContaining("Click **Review now**"),
      },
      reviewAction: true,
    });
  });

  it("carries the verdict forward when only the base moved", async () => {
    const { env, json, seed } = createEnv();
    seed(
      VERDICT_KEY,
      await verdictFor(
        "diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@ fn a()\n+one\n"
      )
    );
    vi.mocked(getCompareDiff).mockResolvedValue(
      "diff --git a/x b/x\nindex 333..444 100644\n--- a/x\n+++ b/x\n@@ -9,2 +9,3 @@ fn b()\n+one\n"
    );

    const result = await handlePullRequestChanged(env, createLogger(), synchronized, "trace");

    expect(result).toMatchObject({ handler_action: "check_carried_forward" });
    expect(getCompareDiff).toHaveBeenLastCalledWith(expect.anything(), BASE, HEAD);
    const state = vi.mocked(createCheckRun).mock.calls[0][3];
    expect(state).toMatchObject({
      conclusion: "success",
      reviewAction: false,
      output: { title: "Approved (carried forward)" },
    });
    expect(state.output.summary).toContain("Carried forward from commit `ccccccc`");
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, reviewedSha: OLD_HEAD });
  });

  it("carries a failed verdict forward as a failure", async () => {
    const { env, seed } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue("same");
    seed(VERDICT_KEY, await verdictFor("same", { approved: false }));

    await handlePullRequestChanged(env, createLogger(), synchronized, "trace");

    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "Not approved (carried forward)" },
    });
  });

  it("asks for a review when the pull request's own diff changed or cannot be read", async () => {
    const { env, seed, json } = createEnv();
    seed(VERDICT_KEY, await verdictFor("something else"));

    await handlePullRequestChanged(env, createLogger(), synchronized, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "action_required",
    });

    vi.mocked(getCompareDiff).mockResolvedValue(null);
    seed(VERDICT_KEY, await verdictFor("x", { diffHash: null }));
    const log = createLogger();
    await handlePullRequestChanged(env, log, synchronized, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[1][3]).toMatchObject({
      conclusion: "action_required",
    });
    expect(log.warn).toHaveBeenCalledWith("check.diff_unreadable", expect.anything());
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD });
  });

  it("asks for a review when a new base branch changes the diff of an approved head", async () => {
    const retargeted: PullRequestChangedPayload = { ...synchronized, action: "edited" };
    const { env, seed } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue("diff against the old base");
    seed(VERDICT_KEY, await verdictFor("diff against the old base", { sha: HEAD }));

    const same = await handlePullRequestChanged(env, createLogger(), retargeted, "trace");
    expect(same).toEqual({ outcome: "skipped", skip_reason: "diff_unchanged" });
    expect(createCheckRun).not.toHaveBeenCalled();

    vi.mocked(getCompareDiff).mockResolvedValue("a much larger diff against the new base");
    const changed = await handlePullRequestChanged(env, createLogger(), retargeted, "trace");
    expect(changed).toMatchObject({ handler_action: "check_needs_review" });
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "action_required",
    });
  });

  it.each([
    ["draft_pr", { draft: true }, {}],
    ["pr_not_open", { state: "closed" }, {}],
    ["merge_gate_off", {}, { mergeGate: "off" as const }],
  ])("skips with %s", async (skip_reason, change, config) => {
    useConfig(config);
    const { env } = createEnv();

    const result = await handlePullRequestChanged(
      env,
      createLogger(),
      { ...synchronized, pull_request: { ...synchronized.pull_request, ...change } },
      "trace"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason });
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("drops only blob ids and hunk positions from a diff", () => {
    expect(
      normalizeDiff(
        "diff --git a/x b/x\nindex 1..2 100644\n@@ -1,2 +3,4 @@ ctx\n-index me\n+@@ kept"
      )
    ).toBe("diff --git a/x b/x\n@@\n-index me\n+@@ kept");
  });
});

describe("stuck check", () => {
  const stuckSince = new Date(Date.parse(RUN_START) + STUCK_REVIEW_MS + 1_000);

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes a silent review in %s mode as %s", async (mergeGate, conclusion) => {
    vi.useFakeTimers({ now: stuckSince });
    useConfig({ mergeGate });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review()]);
    const { env, seed, json } = createEnv();
    seed(RUN_KEY, run({ tokens: [TOKEN_A, TOKEN_B], expected: 2 }));

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(updateCheckRun).toHaveBeenCalledWith(expect.anything(), 7, expect.anything());
    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "The AI review did not finish" },
    });
    expect(state.output.summary).toContain("1 of 2 reviews posted");
    expect(state.output.summary).toContain("Re-run this check");
    expect(json(RUN_KEY)).toBeNull();
    expect(json(VERDICT_KEY)).toBeNull();
  });

  it("leaves a review alone inside the window", async () => {
    vi.useFakeTimers({ now: new Date(Date.parse(RUN_START) + STUCK_REVIEW_MS - 1_000) });
    const { env, seed, json } = createEnv();
    seed(RUN_KEY, run());

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(json(RUN_KEY)).not.toBeNull();
  });

  it("does nothing for a pull request with no review in flight", async () => {
    const { env } = createEnv();

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(getGitHubConfig).not.toHaveBeenCalled();
  });

  it("concludes from the reviews when they posted but their webhook was missed", async () => {
    vi.useFakeTimers({ now: stuckSince });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env, seed, json } = createEnv();
    seed(RUN_KEY, run());

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({ conclusion: "success" });
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: true });
  });

  it("forgets the review when the gate was turned off", async () => {
    vi.useFakeTimers({ now: stuckSince });
    useConfig({ mergeGate: "off" });
    const { env, seed, json } = createEnv();
    seed(RUN_KEY, run());

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(json(RUN_KEY)).toBeNull();
  });
});
