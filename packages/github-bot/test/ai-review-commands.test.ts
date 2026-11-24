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
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import {
  handleBotReviewSubmitted,
  parseOverrideCommand,
  STUCK_REVIEW_MS,
} from "../src/ai-review-check";
import { handleCheckRunReviewRequested, handleIssueComment } from "../src/handlers";
import {
  checkSenderPermission,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
  postReaction,
} from "../src/github-auth";
import { createCheckRun, updateCheckRun } from "../src/github-checks";
import {
  alice,
  bob,
  botReview,
  createEnv,
  createLogger,
  HEAD,
  OLD_HEAD,
  overrideComment,
  pullRequest,
  rerequested,
  resetGateMocks,
  review,
  run,
  RUN_KEY,
  useConfig,
  VERDICT_KEY,
} from "./ai-review-fixtures";

beforeEach(resetGateMocks);

describe("check re-run", () => {
  it.each([
    ["the Re-run button", rerequested],
    [
      "the Review now button",
      { ...rerequested, action: "requested_action", requested_action: { identifier: "review" } },
    ],
  ] as [string, CheckRunPayload][])("reviews the head for %s", async (_name, payload) => {
    const { env, controlPlaneFetch, json } = createEnv();

    const result = await handleCheckRunReviewRequested(env, createLogger(), payload, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    const call = (pattern: RegExp) =>
      controlPlaneFetch.mock.calls.find(([url]) => pattern.test(url)) as unknown as [
        string,
        { body: string },
      ];
    expect(JSON.parse(call(/\/sessions$/)[1].body)).toMatchObject({ scmLogin: "bob" });
    expect(JSON.parse(call(/\/prompt$/)[1].body).content).toContain("## Pre-merge Review");
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "bob",
      expect.any(String)
    );
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({ status: "in_progress" });
    expect(json(RUN_KEY)).toMatchObject({ sha: HEAD, checkRunId: 7 });
  });

  it.each([
    ["not_ai_review_check", { check_run: { ...rerequested.check_run, name: "e2e" } }],
    ["not_ai_review_check", { check_run: { ...rerequested.check_run, app: { id: 999 } } }],
    [
      "unsupported_check_action",
      { action: "requested_action" as const, requested_action: { identifier: "other" } },
    ],
    ["check_without_pull_request", { check_run: { ...rerequested.check_run, pull_requests: [] } }],
    ["check_not_on_head", { check_run: { ...rerequested.check_run, head_sha: OLD_HEAD } }],
  ])("skips with %s", async (skip_reason, change) => {
    const { env, sessionsStarted } = createEnv();

    const result = await handleCheckRunReviewRequested(
      env,
      createLogger(),
      { ...rerequested, ...change },
      "trace"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("skips a closed pull request and a repository with the gate off", async () => {
    const { env } = createEnv();
    vi.mocked(getPullRequest).mockResolvedValue({ ...pullRequest, state: "closed" });
    expect(await handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace")).toEqual({
      outcome: "skipped",
      skip_reason: "pr_not_open",
    });

    useConfig({ mergeGate: "off" });
    expect(await handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace")).toEqual({
      outcome: "skipped",
      skip_reason: "merge_gate_off",
    });
  });

  it("starts one review for repeated clicks, until the first is taken to have died", async () => {
    const { env, sessionsStarted } = createEnv();
    const click = () => handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    await click();
    expect(await click()).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
    expect(sessionsStarted()).toBe(1);

    vi.useFakeTimers({ now: Date.now() + STUCK_REVIEW_MS + 1_000 });
    expect(await click()).toMatchObject({ outcome: "processed" });
    expect(sessionsStarted()).toBe(2);
  });

  it("leaves the check as it was when the requester may not start a review", async () => {
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const { env, sessionsStarted } = createEnv();

    const result = await handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "sender_insufficient_permission" });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});

describe("override", () => {
  it("parses only a comment that starts with the command", () => {
    expect(parseOverrideCommand("override flaky reviewer")).toEqual({ reason: "flaky reviewer" });
    expect(parseOverrideCommand("Override: hotfix\nsee thread")).toEqual({
      reason: "hotfix\nsee thread",
    });
    expect(parseOverrideCommand("override")).toEqual({ reason: "" });
    expect(parseOverrideCommand("overrides are bad")).toBeNull();
    expect(parseOverrideCommand("override-me")).toBeNull();
    expect(parseOverrideCommand("please override this")).toBeNull();
  });

  it("passes the head's check with the reason and the overrider, without a session", async () => {
    const { env, sessionsStarted, json, seed } = createEnv();
    seed(RUN_KEY, run());

    const result = await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot override reviewer is wrong about the cache"),
      "trace"
    );

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_overridden" });
    expect(sessionsStarted()).toBe(0);
    expect(createCheckRun).toHaveBeenCalledWith(expect.anything(), HEAD, expect.any(String), {
      status: "completed",
      conclusion: "success",
      output: {
        title: "Overridden by @bob",
        summary:
          "@bob overrode the AI Review check on commit `aaaaaaa`.\n\nReason: reviewer is wrong about the cache",
      },
      reviewAction: false,
    });
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: true });
    expect(json(RUN_KEY)).toBeNull();
    expect(postReaction).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "+1",
      expect.any(String)
    );
  });

  it("keeps the override when a review of that commit lands afterwards", async () => {
    const { env, seed } = createEnv();
    seed(RUN_KEY, run());
    await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot override ok"),
      "trace"
    );
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "no_review_run" });
    expect(updateCheckRun).not.toHaveBeenCalled();
  });

  it.each([
    ["override_missing_reason", "@test-bot override", bob, true, "needs a reason"],
    ["override_by_author", "@test-bot override mine", alice, true, "author"],
    ["override_not_authorized", "@test-bot override x", bob, false, "write access"],
  ])(
    "rejects with %s and a short reply",
    async (skip_reason, body, sender, hasPermission, reply) => {
      vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission });
      const { env, sessionsStarted } = createEnv();

      const result = await handleIssueComment(
        env,
        createLogger(),
        overrideComment(body, sender),
        "trace"
      );

      expect(result).toEqual({ outcome: "skipped", skip_reason });
      expect(postIssueComment).toHaveBeenCalledWith(
        "installation-token",
        "https://api.github.com/repos/acme/widgets/issues/42/comments",
        expect.stringContaining(reply),
        expect.any(String)
      );
      expect(sessionsStarted()).toBe(0);
      expect(createCheckRun).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["merge_gate_off", { mergeGate: "off" as const }, bob, { hasPermission: true }],
    ["override_not_authorized", {}, { ...bob, type: "Bot" }, { hasPermission: true }],
    ["permission_check_failed", {}, bob, { hasPermission: false, error: true }],
  ])(
    "skips with %s, without a reply or a session",
    async (skip_reason, config, sender, permission) => {
      useConfig(config);
      vi.mocked(checkSenderPermission).mockResolvedValue(permission);
      const { env, sessionsStarted } = createEnv();

      const result = await handleIssueComment(
        env,
        createLogger(),
        overrideComment("@test-bot override because", sender),
        "trace"
      );

      expect(result).toEqual({ outcome: "skipped", skip_reason });
      expect(postIssueComment).not.toHaveBeenCalled();
      expect(sessionsStarted()).toBe(0);
      expect(createCheckRun).not.toHaveBeenCalled();
    }
  );

  it("still starts a comment session for a mention that is not an override", async () => {
    const { env, sessionsStarted } = createEnv();

    await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot please override the default timeout"),
      "trace"
    );

    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
  });
});
