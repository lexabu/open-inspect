import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import type {
  CheckRunPayload,
  Env,
  IssueCommentPayload,
  PullRequestOpenedPayload,
  PullRequestSynchronizePayload,
  ReviewRequestedPayload,
  ReviewSubmittedPayload,
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";
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
  findCheckRun: vi.fn(),
  getCompareDiff: vi.fn(),
}));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import {
  concludeStuckCheck,
  handleBotReviewSubmitted,
  handlePullRequestSynchronized,
  normalizeDiff,
  parseOverrideCommand,
  STUCK_REVIEW_MS,
} from "../src/ai-review-check";
import {
  handleCheckRunReviewRequested,
  handleIssueComment,
  handlePullRequestOpened,
  handleReviewRequested,
} from "../src/handlers";
import {
  checkSenderPermission,
  generateInstallationToken,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
  postReaction,
  type PullRequestReview,
} from "../src/github-auth";
import { createCheckRun, findCheckRun, getCompareDiff, updateCheckRun } from "../src/github-checks";
import { getGitHubConfig } from "../src/utils/integration-config";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);
const BOT = "test-bot[bot]";
const VERDICT_KEY = "ai-review:verdict:acme/widgets#42";
const PENDING_KEY = "ai-review:pending:acme/widgets#42";
const RUN_START = "2026-11-23T10:00:00.000Z";

const baseConfig: ResolvedGitHubConfig = {
  model: "anthropic/claude-haiku-4-5",
  harness: "opencode",
  reasoningEffort: null,
  reviewers: null,
  commentOnlyReviews: false,
  mergeGate: "required",
  autoReviewOnOpen: true,
  enabledRepos: null,
  allowedTriggerUsers: null,
  codeReviewInstructions: null,
  commentActionInstructions: null,
};

const twoReviewers = [
  { model: "anthropic/claude-haiku-4-5", harness: "opencode" as const },
  { model: "openai/gpt-5.6-sol", harness: "opencode" as const },
];

const repository = { id: 99, owner: { login: "acme" }, name: "widgets", private: false };
const alice = { login: "alice", id: 1001, avatar_url: "https://avatars.test/1001" };
const bob = { login: "bob", id: 1002, avatar_url: "https://avatars.test/1002" };
const pullRequest = {
  number: 42,
  title: "Add caching",
  body: "Adds Redis caching",
  user: { login: "alice" },
  head: { ref: "feature/cache", sha: HEAD },
  base: { ref: "main", sha: BASE },
};

const opened: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: { ...pullRequest, draft: false },
  repository,
  sender: alice,
};

const synchronized: PullRequestSynchronizePayload = {
  action: "synchronize",
  pull_request: { ...pullRequest, draft: false, state: "open" },
  repository,
  sender: alice,
};

const botReview: ReviewSubmittedPayload = {
  action: "submitted",
  review: { commit_id: HEAD, user: { login: BOT } },
  pull_request: pullRequest,
  repository,
  sender: { login: BOT, id: 5, avatar_url: "https://avatars.test/5" },
};

const rerequested: CheckRunPayload = {
  action: "rerequested",
  check_run: {
    name: "AI Review",
    head_sha: HEAD,
    app: { id: 12345 },
    pull_requests: [{ number: 42 }],
  },
  repository,
  sender: bob,
};

function overrideComment(body: string, sender = bob): IssueCommentPayload {
  return {
    action: "created",
    issue: { number: 42, title: "Add caching", pull_request: { url: "https://api.test/pulls/42" } },
    comment: { id: 100, body, user: { login: sender.login } },
    repository,
    sender,
  };
}

function review(overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    login: BOT,
    commitId: HEAD,
    state: "COMMENTED",
    body: "Looks good.",
    url: "https://github.test/review/1",
    submittedAt: "2026-11-23T10:05:00.000Z",
    ...overrides,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

function createEnv() {
  const kv = new Map<string, string>();
  const controlPlaneFetch = vi.fn(async (url: string) => {
    if (url.startsWith("https://internal/github/route?")) {
      return Response.json({ teamId: null, via: "workspace" });
    }
    if (url.endsWith("/metadata")) return Response.json({ repo: "acme/widgets", metadata: null });
    if (url === "https://internal/sessions") {
      return Response.json({ sessionId: "session-1", status: "created" });
    }
    if (url.endsWith("/prompt")) return Response.json({ messageId: "message-1" });
    return new Response("Not found", { status: 404 });
  });
  const env = {
    GITHUB_KV: {
      get: async (key: string, type?: "json") => {
        const value = kv.get(key) ?? null;
        return type === "json" && value !== null ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    GITHUB_BOT_USERNAME: BOT,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
  const sessionsStarted = () =>
    controlPlaneFetch.mock.calls.filter(([url]) => url === "https://internal/sessions").length;
  const json = (key: string) => (kv.has(key) ? JSON.parse(String(kv.get(key))) : null);
  const seed = (key: string, value: unknown) => kv.set(key, JSON.stringify(value));
  return { env, controlPlaneFetch, sessionsStarted, json, seed };
}

function useConfig(overrides: Partial<ResolvedGitHubConfig> = {}) {
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...baseConfig, ...overrides });
}

function useCheck(status: string | null, startedAt: string | null = RUN_START) {
  vi.mocked(findCheckRun).mockResolvedValue({
    run: status === null ? null : { id: 7, status, startedAt },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useConfig();
  vi.mocked(generateInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(postIssueComment).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(listPullRequestReviews).mockResolvedValue([]);
  vi.mocked(getPullRequest).mockResolvedValue({ ...pullRequest, state: "open" });
  vi.mocked(createCheckRun).mockResolvedValue(7);
  vi.mocked(updateCheckRun).mockResolvedValue(true);
  vi.mocked(getCompareDiff).mockResolvedValue("diff --git a/x b/x\n+one\n");
  useCheck("in_progress");
});

describe("opening review", () => {
  it("shows the check in progress once the review sessions start", async () => {
    const { env, json } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toMatchObject({ outcome: "processed", handler_action: "auto_review" });
    expect(createCheckRun).toHaveBeenCalledOnce();
    const [client, sha, startedAt, state] = vi.mocked(createCheckRun).mock.calls[0];
    expect(client.repoUrl).toBe("https://api.github.com/repos/acme/widgets");
    expect(sha).toBe(HEAD);
    expect(state).toMatchObject({ status: "in_progress" });
    expect(json(PENDING_KEY)).toEqual({ sha: HEAD, startedAt });
  });

  it("posts no check while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, sessionsStarted } = createEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(sessionsStarted()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
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
    expect(json(PENDING_KEY)).toBeNull();
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
    expect(json(PENDING_KEY)).toBeNull();
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
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

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
    expect(json(VERDICT_KEY)).toMatchObject({
      sha: HEAD,
      reviewedSha: HEAD,
      approved: true,
      diffHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(json(PENDING_KEY)).toBeNull();
  });

  it("counts a comment-only review that carries the approve marker", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ body: `Verdict: approve\n${ADVISORY_APPROVE_MARKER}` }),
    ]);
    const { env } = createEnv();

    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({ conclusion: "success" });
  });

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes findings in %s mode as %s", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);
    const { env, json } = createEnv();

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

  it("waits until every configured reviewer has posted", async () => {
    useConfig({ reviewers: twoReviewers, commentOnlyReviews: true });
    const first = review({ body: `**Reviewer: Haiku**\napprove\n${ADVISORY_APPROVE_MARKER}` });
    vi.mocked(listPullRequestReviews).mockResolvedValue([first]);
    const { env } = createEnv();

    const waiting = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");
    expect(waiting).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
    expect(updateCheckRun).not.toHaveBeenCalled();

    vi.mocked(listPullRequestReviews).mockResolvedValue([
      first,
      review({
        body: `**Reviewer: Sol**\napprove\n${ADVISORY_APPROVE_MARKER}`,
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
    useConfig({ reviewers: twoReviewers });
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ body: `**Reviewer: Haiku**\n${ADVISORY_APPROVE_MARKER}` }),
      review({ body: "**Reviewer: Sol**\nrequest changes" }),
    ]);
    const { env } = createEnv();

    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({ conclusion: "failure" });
    expect(state.output.summary).toContain("- Sol: changes requested");
  });

  it("ignores reviews from before the run started, dismissed reviews and other authors", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", submittedAt: "2026-11-23T09:00:00.000Z" }),
      review({ state: "DISMISSED" }),
      review({ state: "APPROVED", login: "carol" }),
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    const { env } = createEnv();

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "awaiting_reviewers" });
  });

  it("concludes only the reviewed commit's check when it is no longer the head", async () => {
    vi.mocked(listPullRequestReviews).mockResolvedValue([
      review({ state: "APPROVED", commitId: OLD_HEAD }),
    ]);
    const { env, json } = createEnv();

    await handleBotReviewSubmitted(
      env,
      createLogger(),
      { ...botReview, review: { ...botReview.review, commit_id: OLD_HEAD } },
      "trace"
    );

    expect(findCheckRun).toHaveBeenCalledWith(expect.anything(), "12345", OLD_HEAD);
    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({ conclusion: "success" });
    expect(json(VERDICT_KEY)).toBeNull();
  });

  it("creates a concluded check when the commit has none", async () => {
    useCheck(null);
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    const { env } = createEnv();

    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({ conclusion: "success" });
  });

  it("skips while the gate is off and for reviews by anyone else", async () => {
    const { env } = createEnv();
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
    expect(findCheckRun).not.toHaveBeenCalled();
  });

  it("fails the delivery when GitHub cannot be read or the check cannot be written", async () => {
    const { env } = createEnv();
    vi.mocked(listPullRequestReviews).mockResolvedValue(null);
    await expect(handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).rejects.toThrow(
      "Reviews unreadable"
    );

    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(updateCheckRun).mockResolvedValue(false);
    await expect(handleBotReviewSubmitted(env, createLogger(), botReview, "trace")).rejects.toThrow(
      "could not be written"
    );
  });
});

describe("synchronize", () => {
  it.each([
    ["required", "action_required"],
    ["shadow", "neutral"],
  ] as const)("asks for a review of a new head in %s mode", async (mergeGate, conclusion) => {
    useConfig({ mergeGate });
    const { env, sessionsStarted } = createEnv();

    const result = await handlePullRequestSynchronized(env, createLogger(), synchronized, "trace");

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
    const { env, json } = createEnv();
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "APPROVED" })]);
    vi.mocked(getCompareDiff).mockResolvedValue(
      "diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@ fn a()\n+one\n"
    );
    await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    const merged = "d".repeat(40);
    vi.mocked(getCompareDiff).mockResolvedValue(
      "diff --git a/x b/x\nindex 333..444 100644\n--- a/x\n+++ b/x\n@@ -9,2 +9,3 @@ fn b()\n+one\n"
    );
    const result = await handlePullRequestSynchronized(
      env,
      createLogger(),
      {
        ...synchronized,
        pull_request: { ...synchronized.pull_request, head: { ref: "f", sha: merged } },
      },
      "trace"
    );

    expect(result).toMatchObject({ handler_action: "check_carried_forward" });
    expect(getCompareDiff).toHaveBeenLastCalledWith(expect.anything(), BASE, merged);
    const state = vi.mocked(createCheckRun).mock.calls[0][3];
    expect(state).toMatchObject({
      conclusion: "success",
      reviewAction: false,
      output: { title: "Approved (carried forward)" },
    });
    expect(state.output.summary).toContain("Carried forward from commit `aaaaaaa`");
    expect(json(VERDICT_KEY)).toMatchObject({ sha: merged, reviewedSha: HEAD });
  });

  it("carries a failed verdict forward as a failure", async () => {
    const { env, seed } = createEnv();
    vi.mocked(getCompareDiff).mockResolvedValue("same");
    seed(VERDICT_KEY, {
      sha: OLD_HEAD,
      reviewedSha: OLD_HEAD,
      diffHash: await sha256Hex("same"),
      approved: false,
      summary: "- AI review: changes requested",
    });

    await handlePullRequestSynchronized(env, createLogger(), synchronized, "trace");

    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "failure",
      reviewAction: true,
      output: { title: "Not approved (carried forward)" },
    });
  });

  it("asks for a review when the pull request's own diff changed or cannot be read", async () => {
    const { env, seed, json } = createEnv();
    const verdict = {
      sha: OLD_HEAD,
      reviewedSha: OLD_HEAD,
      diffHash: "0".repeat(64),
      approved: true,
      summary: "- AI review: approve",
    };
    seed(VERDICT_KEY, verdict);

    await handlePullRequestSynchronized(env, createLogger(), synchronized, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[0][3]).toMatchObject({
      conclusion: "action_required",
    });

    vi.mocked(getCompareDiff).mockResolvedValue(null);
    seed(VERDICT_KEY, { ...verdict, diffHash: null });
    const log = createLogger();
    await handlePullRequestSynchronized(env, log, synchronized, "trace");
    expect(vi.mocked(createCheckRun).mock.calls[1][3]).toMatchObject({
      conclusion: "action_required",
    });
    expect(log.warn).toHaveBeenCalledWith("check.diff_unreadable", expect.anything());
    expect(json(VERDICT_KEY)).toMatchObject({ sha: OLD_HEAD });
  });

  it.each([
    ["draft_pr", { draft: true }, {}],
    ["pr_not_open", { state: "closed" }, {}],
    ["merge_gate_off", {}, { mergeGate: "off" as const }],
  ])("skips with %s", async (skip_reason, change, config) => {
    useConfig(config);
    const { env } = createEnv();

    const result = await handlePullRequestSynchronized(
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
    expect(json(PENDING_KEY)).toMatchObject({ sha: HEAD });
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
    const run = () => handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    await run();
    expect(await run()).toEqual({ outcome: "skipped", skip_reason: "review_in_progress" });
    expect(sessionsStarted()).toBe(1);

    vi.useFakeTimers({ now: Date.now() + STUCK_REVIEW_MS + 1_000 });
    expect(await run()).toMatchObject({ outcome: "processed" });
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

  it("replaces an override of the head with the new review", async () => {
    const { env, seed, json } = createEnv();
    seed(VERDICT_KEY, {
      sha: HEAD,
      reviewedSha: HEAD,
      diffHash: null,
      approved: true,
      summary: "overridden",
      overriddenBy: "bob",
    });

    await handleCheckRunReviewRequested(env, createLogger(), rerequested, "trace");

    expect(json(VERDICT_KEY)).toBeNull();
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
    useCheck("completed");
    const { env, sessionsStarted, json, seed } = createEnv();
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

    const result = await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot override reviewer is wrong about the cache"),
      "trace"
    );

    expect(result).toMatchObject({ outcome: "processed", handler_action: "check_overridden" });
    expect(sessionsStarted()).toBe(0);
    expect(updateCheckRun).toHaveBeenCalledWith(expect.anything(), 7, {
      status: "completed",
      conclusion: "success",
      output: {
        title: "Overridden by @bob",
        summary:
          "@bob overrode the AI Review check on commit `aaaaaaa`.\n\nReason: reviewer is wrong about the cache",
      },
      reviewAction: false,
    });
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: true, overriddenBy: "bob" });
    expect(json(PENDING_KEY)).toBeNull();
    expect(postReaction).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/issues/comments/100/reactions",
      "+1",
      expect.any(String)
    );
  });

  it("keeps the override when a review of that commit lands afterwards", async () => {
    const { env } = createEnv();
    await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot override ok"),
      "trace"
    );
    vi.mocked(updateCheckRun).mockClear();
    vi.mocked(listPullRequestReviews).mockResolvedValue([review({ state: "CHANGES_REQUESTED" })]);

    const result = await handleBotReviewSubmitted(env, createLogger(), botReview, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "check_overridden" });
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
      expect(updateCheckRun).not.toHaveBeenCalled();
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
      expect(updateCheckRun).not.toHaveBeenCalled();
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
    expect(updateCheckRun).not.toHaveBeenCalled();
  });
});

describe("stuck check", () => {
  const stuckSince = new Date(Date.parse(RUN_START) + STUCK_REVIEW_MS + 1_000);

  it.each([
    ["required", "failure"],
    ["shadow", "neutral"],
  ] as const)("concludes a silent review in %s mode as %s", async (mergeGate, conclusion) => {
    vi.useFakeTimers({ now: stuckSince });
    useConfig({ mergeGate, reviewers: twoReviewers });
    vi.mocked(listPullRequestReviews).mockResolvedValue([review()]);
    const { env, seed, json } = createEnv();
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

    await concludeStuckCheck(env, createLogger(), repository, 42);

    const state = vi.mocked(updateCheckRun).mock.calls[0][2];
    expect(state).toMatchObject({
      conclusion,
      reviewAction: true,
      output: { title: "The AI review did not finish" },
    });
    expect(state.output.summary).toContain("1 of 2 reviews posted");
    expect(state.output.summary).toContain("Re-run this check");
    expect(json(PENDING_KEY)).toBeNull();
    expect(json(VERDICT_KEY)).toBeNull();
  });

  it("leaves a review alone inside the window", async () => {
    vi.useFakeTimers({ now: new Date(Date.parse(RUN_START) + STUCK_REVIEW_MS - 1_000) });
    const { env, seed, json } = createEnv();
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(getGitHubConfig).not.toHaveBeenCalled();
    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(json(PENDING_KEY)).not.toBeNull();
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
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(vi.mocked(updateCheckRun).mock.calls[0][2]).toMatchObject({ conclusion: "success" });
    expect(json(VERDICT_KEY)).toMatchObject({ sha: HEAD, approved: true });
  });

  it.each([
    ["the check already concluded", {}, "completed"],
    ["the gate was turned off", { mergeGate: "off" as const }, "in_progress"],
  ])("forgets the review when %s", async (_name, config, status) => {
    vi.useFakeTimers({ now: stuckSince });
    useConfig(config);
    useCheck(status);
    const { env, seed, json } = createEnv();
    seed(PENDING_KEY, { sha: HEAD, startedAt: RUN_START });

    await concludeStuckCheck(env, createLogger(), repository, 42);

    expect(updateCheckRun).not.toHaveBeenCalled();
    expect(json(PENDING_KEY)).toBeNull();
  });
});
