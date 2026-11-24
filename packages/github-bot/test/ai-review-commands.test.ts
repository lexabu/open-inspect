import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckRunPayload } from "../src/types";
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

import { handleBotReviewChanged } from "../src/ai-review-check";
import { parseOverrideCommand } from "../src/ai-review-override";
import {
  handleCheckRunReviewRequested,
  handleCheckSuiteRerequested,
  handleIssueComment,
} from "../src/handlers";
import {
  checkSenderPermission,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
  postReaction,
} from "../src/github-auth";
import {
  createCheckRun,
  findSuiteReviewRun,
  listOpenPullsWithHead,
  updateCheckRun,
} from "../src/github-checks";
import {
  alice,
  attempt,
  ATTEMPT_KEY,
  BASE,
  bob,
  BOT,
  botReview,
  createEnv,
  createLogger,
  HEAD,
  livePull,
  OLD_HEAD,
  overrideComment,
  prompts,
  rerequested,
  resetGateMocks,
  review,
  suiteRerequested,
  useConfig,
  VERDICT_KEY,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

type TestEnv = ReturnType<typeof createEnv>["env"];
const skip = (skip_reason: string) => ({ outcome: "skipped", skip_reason });

describe("check re-run", () => {
  const click = (env: TestEnv, payload: CheckRunPayload = rerequested) =>
    handleCheckRunReviewRequested(env, createLogger(), payload, "trace");

  it.each([
    ["the Re-run button", rerequested],
    [
      "the Review now button",
      { ...rerequested, action: "requested_action", requested_action: { identifier: "review" } },
    ],
  ] as [string, CheckRunPayload][])("reviews the head for %s", async (_name, payload) => {
    const { env, controlPlaneFetch, json } = createEnv();

    const result = await click(env, payload);

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    const session = controlPlaneFetch.mock.calls.find(([url]) => url.endsWith("/sessions"));
    const [, init] = session as unknown as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ scmLogin: "bob" });
    expect(prompts(controlPlaneFetch)[0]).toContain("## Pre-merge Review");
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "bob",
      expect.any(String)
    );
    expect(vi.mocked(createCheckRun).mock.calls[0][2]).toMatchObject({ status: "in_progress" });
    expect(json(ATTEMPT_KEY)).toMatchObject({ headSha: HEAD, baseSha: BASE, checkRunId: 7 });
  });

  it("finds the pull request from the check's external id, with or without an attempt", async () => {
    const { env, sessionsStarted } = createEnv();
    const withAttempt = {
      ...rerequested,
      check_run: {
        ...rerequested.check_run,
        external_id: "open-inspect:pr=42;attempt=11111111-1111-4111-8111-111111111111",
      },
    };

    expect(await click(env, withAttempt)).toMatchObject({ outcome: "processed" });
    expect(getPullRequest).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/42",
      expect.any(String)
    );
    expect(sessionsStarted()).toBe(1);
  });

  it.each([
    ["not_ai_review_check", { check_run: { ...rerequested.check_run, name: "e2e" } }],
    ["not_ai_review_check", { check_run: { ...rerequested.check_run, app: { id: 999 } } }],
    [
      "unsupported_check_action",
      { action: "requested_action" as const, requested_action: { identifier: "other" } },
    ],
    ["check_without_pull_request", { check_run: { ...rerequested.check_run, external_id: null } }],
    [
      "check_without_pull_request",
      { check_run: { ...rerequested.check_run, external_id: "someone-else:pr=42" } },
    ],
    ["check_not_on_head", { check_run: { ...rerequested.check_run, head_sha: OLD_HEAD } }],
  ])("skips with %s", async (skip_reason, change) => {
    const { env, sessionsStarted } = createEnv();

    expect(await click(env, { ...rerequested, ...change })).toEqual(skip(skip_reason));
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["pr_not_open", { state: "closed" }, {}],
    ["draft_pr", { draft: true }, {}],
    ["merge_gate_off", {}, { mergeGate: "off" as const }],
  ])("skips with %s, read from the live pull request", async (skip_reason, live, config) => {
    useConfig(config);
    vi.mocked(getPullRequest).mockResolvedValue({ ...livePull, ...live });
    const { env, sessionsStarted } = createEnv();

    expect(await click(env)).toEqual(skip(skip_reason));
    expect(sessionsStarted()).toBe(0);
  });

  it("leaves the check as it was when the requester may not start a review", async () => {
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const { env, sessionsStarted, json } = createEnv();

    expect(await click(env)).toEqual(skip("sender_insufficient_permission"));
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(json(ATTEMPT_KEY)).toBeNull();
  });
});

describe("check suite re-run", () => {
  const rerunAll = (env: TestEnv, payload = suiteRerequested) =>
    handleCheckSuiteRerequested(env, createLogger(), payload, "trace");

  it("reviews the head when the suite holds the AI Review run", async () => {
    const { env, sessionsStarted, json } = createEnv();

    const result = await rerunAll(env);

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(findSuiteReviewRun).toHaveBeenCalledWith(expect.anything(), 900);
    expect(sessionsStarted()).toBe(1);
    expect(json(ATTEMPT_KEY)).toMatchObject({ headSha: HEAD });
  });

  it("starts one attempt when GitHub sends the suite and the run for one click", async () => {
    const { env, sessionsStarted } = createEnv();

    await rerunAll(env);
    const second = await handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    expect(second).toEqual(skip("review_in_progress"));
    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).toHaveBeenCalledOnce();
  });

  it.each([
    ["not_ai_review_check", { app: { id: 999 } }, { externalId: "open-inspect:pr=42" }, {}],
    ["check_without_pull_request", {}, { externalId: null }, {}],
    ["check_not_on_head", { head_sha: OLD_HEAD }, { externalId: "open-inspect:pr=42" }, {}],
    ["merge_gate_off", {}, { externalId: "open-inspect:pr=42" }, { mergeGate: "off" as const }],
  ])("skips with %s", async (skip_reason, suite, run, config) => {
    useConfig(config);
    vi.mocked(findSuiteReviewRun).mockResolvedValue(run);
    const { env, sessionsStarted } = createEnv();
    const payload = {
      ...suiteRerequested,
      check_suite: { ...suiteRerequested.check_suite, ...suite },
    };

    expect(await rerunAll(env, payload)).toEqual(skip(skip_reason));
    expect(sessionsStarted()).toBe(0);
  });

  it("fails the delivery when the suite cannot be read", async () => {
    vi.mocked(findSuiteReviewRun).mockResolvedValue(null);
    const { env } = createEnv();

    await expect(rerunAll(env)).rejects.toThrow("Check suite 900 unreadable");
  });
});

describe("override command", () => {
  const parse = (body: string) => parseOverrideCommand(body, BOT);

  it("reads a line of its own that names a commit and gives a reason", () => {
    expect(parse("@test-bot override aaaaaaa reviewer is wrong about the cache")).toEqual({
      commit: "aaaaaaa",
      reason: "reviewer is wrong about the cache",
    });
    expect(
      parse("Talked to Sam.\n\n  @test-bot[bot] override AAAAAAA1 hotfix  \n\nThanks")
    ).toEqual({
      commit: "aaaaaaa1",
      reason: "hotfix",
    });
    expect(parse("@test-bot override aaaaaaa")).toEqual({ commit: "aaaaaaa", reason: "" });
  });

  it.each([
    ["a request in prose", "@test-bot override the retry limit for this client"],
    ["no commit", "@test-bot override because the reviewer is flaky"],
    ["a commit prefix that is too short", "@test-bot override aaaaaa too short"],
    ["text before the mention", "please @test-bot override aaaaaaa hotfix"],
    ["a longer word", "@test-bot overrides aaaaaaa hotfix"],
    ["another bot's handle", "@test-bot-other override aaaaaaa hotfix"],
    ["a fenced example", "Use:\n```\n@test-bot override aaaaaaa hotfix\n```"],
    ["no mention at all", "override aaaaaaa hotfix"],
  ])("does not read %s as an override", (_name, body) => {
    expect(parse(body)).toBeNull();
  });
});

describe("override", () => {
  const comment = (env: TestEnv, body: string, sender = bob) =>
    handleIssueComment(env, createLogger(), overrideComment(body, sender), "trace");

  it("passes the head's check with the reason and the overrider, without a session", async () => {
    const { env, sessionsStarted, json, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());

    const result = await comment(
      env,
      "@test-bot override aaaaaaa reviewer is wrong about the cache"
    );

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_overridden" });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      { headSha: HEAD, startedAt: expect.any(String), externalId: "open-inspect:pr=42" },
      {
        status: "completed",
        conclusion: "success",
        output: {
          title: "Overridden by @bob",
          summary:
            "@bob overrode the AI Review check on commit `aaaaaaa`.\n\nReason: reviewer is wrong about the cache",
        },
        reviewAction: false,
      }
    );
    expect(json(VERDICT_KEY)).toMatchObject({
      sha: HEAD,
      baseRef: "main",
      approved: true,
      attemptId: null,
    });
    expect(json(ATTEMPT_KEY)).toBeNull();
    expect(postReaction).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "+1",
      expect.any(String)
    );
  });

  it("applies a comment once, however often it is delivered", async () => {
    const { env } = createEnv();

    await comment(env, "@test-bot override aaaaaaa ok");
    const again = await comment(env, "@test-bot override aaaaaaa ok");

    expect(again).toEqual(skip("override_already_applied"));
    expect(createCheckRun).toHaveBeenCalledOnce();
  });

  it("keeps the override when a review of that commit lands afterwards", async () => {
    const { env, seed } = createEnv();
    seed(ATTEMPT_KEY, attempt());
    await comment(env, "@test-bot override aaaaaaa ok");
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);

    const result = await handleBotReviewChanged(env, createLogger(), botReview, "trace");

    expect(result).toEqual(skip("no_review_attempt"));
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it("refuses a commit that is not the head, and says what the head is", async () => {
    const { env, sessionsStarted } = createEnv();

    const result = await comment(env, "@test-bot override ccccccc looked fine yesterday");

    expect(result).toEqual(skip("override_wrong_commit"));
    expect(postIssueComment).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/42/comments",
      expect.stringContaining("The head is `aaaaaaa`"),
      expect.any(String)
    );
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["override_missing_reason", "@test-bot override aaaaaaa", bob, true, [42], "needs a reason"],
    ["override_by_author", "@test-bot override aaaaaaa mine", alice, true, [42], "author"],
    ["override_not_authorized", "@test-bot override aaaaaaa x", bob, false, [42], "write access"],
    ["override_shared_head", "@test-bot override aaaaaaa x", bob, true, [42, 57], "#57"],
  ])(
    "rejects with %s and a short reply",
    async (skip_reason, body, sender, hasPermission, pulls, reply) => {
      vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission });
      vi.mocked(listOpenPullsWithHead).mockResolvedValue(pulls);
      const { env, sessionsStarted, json } = createEnv();

      expect(await comment(env, body, sender)).toEqual(skip(skip_reason));
      expect(postIssueComment).toHaveBeenCalledWith(
        "installation-token",
        "https://api.github.com/repos/acme/widgets/issues/42/comments",
        expect.stringContaining(reply),
        expect.any(String)
      );
      expect(sessionsStarted()).toBe(0);
      expect(createCheckRun).not.toHaveBeenCalled();
      expect(json(VERDICT_KEY)).toBeNull();
    }
  );

  it.each([
    ["override_not_authorized", { ...bob, type: "Bot" }, { hasPermission: true }],
    ["permission_check_failed", bob, { hasPermission: false, error: true }],
  ])("skips with %s, without a reply or a session", async (skip_reason, sender, permission) => {
    vi.mocked(checkSenderPermission).mockResolvedValue(permission);
    const { env, sessionsStarted } = createEnv();

    expect(await comment(env, "@test-bot override aaaaaaa because", sender)).toEqual(
      skip(skip_reason)
    );
    expect(postIssueComment).not.toHaveBeenCalled();
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("treats the comment as an ordinary mention while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, sessionsStarted, controlPlaneFetch } = createEnv();

    const result = await comment(env, "@test-bot override aaaaaaa hotfix");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(sessionsStarted()).toBe(1);
    expect(prompts(controlPlaneFetch)[0]).toContain("override aaaaaaa hotfix");
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("starts a comment session for a request in prose that begins with override", async () => {
    const { env, sessionsStarted } = createEnv();

    const result = await comment(env, "@test-bot override the retry limit for this client");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "comment" });
    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});
