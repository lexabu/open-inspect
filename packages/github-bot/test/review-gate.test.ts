import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestOpenedPayload, ReviewRequestedPayload } from "../src/types";
import type * as GitHubAuth from "../src/github-auth";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn(),
  postReaction: vi.fn(),
  postIssueComment: vi.fn(),
  checkSenderPermission: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", () => ({ findSuiteReviewRun: vi.fn() }));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import {
  handleCheckRunReviewRequested,
  handleCheckSuiteRerequested,
  handlePullRequestOpened,
  handleReviewRequested,
} from "../src/handlers";
import { handlePullRequestChanged } from "../src/review-gate";
import { checkSenderPermission, getPullRequest } from "../src/github-auth";
import { findSuiteReviewRun } from "../src/github-checks";
import {
  alice,
  BASE,
  BOT,
  createEnv,
  createLogger,
  HAIKU,
  HEAD,
  livePull,
  OLD_HEAD,
  opened,
  pullRequest,
  repository,
  rerequested,
  resetGateMocks,
  SOL,
  suiteRerequested,
  synchronized,
  twoReviewers,
  useConfig,
} from "./review-gate-fixtures";

beforeEach(resetGateMocks);

type TestEnv = ReturnType<typeof createEnv>["env"];
const skip = (skip_reason: string) => ({ outcome: "skipped", skip_reason });
const VERDICT_SECTION = "## Verdict for the AI Review check";

describe("starting a gated review", () => {
  it("hands the review to the control plane instead of starting a session the sender owns", async () => {
    const { env, gateCalls, sessionsStarted } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({
      outcome: "processed",
      sessions: [{ session_id: "gate-session-1", message_id: "gate-message-1", model: HAIKU }],
      handler_action: "auto_review",
    });
    expect(sessionsStarted()).toBe(0);
    const [request] = gateCalls("reviews");
    expect(request).toEqual({
      repository: { owner: "acme", name: "widgets" },
      pullNumber: 42,
      headSha: HEAD,
      // The base the prompt below names, for the control plane to record as reviewed.
      base: { ref: "main", sha: BASE },
      reviewers: [
        {
          model: HAIKU,
          harness: "opencode",
          reasoningEffort: null,
          title: "GitHub: Review PR #42",
          prompt: expect.stringContaining(`compare/${BASE}...${HEAD}`),
        },
      ],
    });
    expect(request.reviewers[0].prompt).toContain(`"commit_id": "${HEAD}"`);
    // The verdict instructions, with the session's nonce, are added by the control plane.
    expect(request.reviewers[0].prompt).not.toContain(VERDICT_SECTION);
  });

  it("sends one reviewer per configured model, each told it reviews alone", async () => {
    useConfig({ reviewers: twoReviewers });
    const { env, gateCalls } = createEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    const { reviewers } = gateCalls("reviews")[0];
    expect(reviewers.map((reviewer: { model: string }) => reviewer.model)).toEqual([HAIKU, SOL]);
    expect(reviewers.map((reviewer: { title: string }) => reviewer.title)).toEqual([
      "GitHub: Review PR #42 (Claude Haiku 4.5)",
      "GitHub: Review PR #42 (GPT 5.6 Sol)",
    ]);
    for (const reviewer of reviewers) {
      expect(reviewer.prompt).toContain("## Independent Reviewer");
    }
  });

  it("starts an ordinary session, with no verdict to report, while the gate is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, gateCalls, sessionsStarted, ownPrompts } = createEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(sessionsStarted()).toBe(1);
    expect(gateCalls("reviews")).toEqual([]);
    expect(gateCalls("pull-changes")).toEqual([]);
    expect(ownPrompts()[0]).not.toContain(VERDICT_SECTION);
  });

  it.each([
    ["auto-review is off", { autoReviewOnOpen: false }, "auto_review_disabled"],
    ["the opener may not trigger the bot", { allowedTriggerUsers: [] }, "sender_not_allowed"],
  ])("tells the gate when %s, so the head still gets a check", async (_name, config, reason) => {
    useConfig(config);
    const { env, gateCalls } = createEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual(skip(reason));
    expect(gateCalls("reviews")).toEqual([]);
    expect(gateCalls("pull-changes")).toEqual([
      {
        repository: { owner: "acme", name: "widgets" },
        pullNumber: 42,
        change: "review_not_started",
        headSha: HEAD,
        detail: reason,
      },
    ]);
  });

  it("tells the gate when the review fails to start, and still fails the delivery", async () => {
    const { env, gateCalls } = createEnv({ reviews: new Response("boom", { status: 500 }) });

    await expect(handlePullRequestOpened(env, createLogger(), opened, "trace")).rejects.toThrow(
      "Review gate reviews failed: 500"
    );

    expect(gateCalls("pull-changes")[0]).toMatchObject({
      change: "review_not_started",
      detail: "session start failed",
    });
  });

  it.each(["review_in_progress", "stale_head", "stale_base", "draft_pr"] as const)(
    "passes on the control plane's %s",
    async (reason) => {
      const { env, gateCalls } = createEnv({ reviews: { outcome: "skipped", reason } });

      const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

      expect(result).toEqual(skip(reason));
      // A review already running on the head has its check; anything else is reported.
      expect(gateCalls("pull-changes")).toHaveLength(reason === "review_in_progress" ? 0 : 1);
    }
  );

  it("posts nothing for a draft, or for a repository the bot is not enabled on", async () => {
    const draft = createEnv();
    const draftPayload = { ...opened, pull_request: { ...opened.pull_request, draft: true } };
    expect(await handlePullRequestOpened(draft.env, createLogger(), draftPayload, "trace")).toEqual(
      skip("draft_pr")
    );
    expect(draft.controlPlaneFetch).not.toHaveBeenCalled();

    useConfig({ enabledRepos: ["acme/other"] });
    const disabled = createEnv();
    expect(await handlePullRequestOpened(disabled.env, createLogger(), opened, "trace")).toEqual(
      skip("repo_not_enabled")
    );
    expect(disabled.gateCalls("pull-changes")).toEqual([]);
  });

  it("reviews a pull request leaving draft only when the gate is on", async () => {
    const ready: PullRequestOpenedPayload = { ...opened, action: "ready_for_review" };
    const on = createEnv();
    await handlePullRequestOpened(on.env, createLogger(), ready, "trace");
    expect(on.gateCalls("reviews")).toHaveLength(1);

    useConfig({ mergeGate: "off" });
    const off = createEnv();
    expect(await handlePullRequestOpened(off.env, createLogger(), ready, "trace")).toEqual(
      skip("merge_gate_off")
    );
    expect(off.sessionsStarted()).toBe(0);
  });

  it("gates a requested review, and leaves the check alone when the request is refused", async () => {
    const requested: ReviewRequestedPayload = {
      action: "review_requested",
      pull_request: pullRequest,
      requested_reviewer: { login: BOT },
      repository,
      sender: alice,
    };
    const first = createEnv();
    const result = await handleReviewRequested(first.env, createLogger(), requested, "trace");
    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(first.gateCalls("reviews")).toHaveLength(1);
    expect(first.sessionsStarted()).toBe(0);

    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const refused = createEnv();
    await handleReviewRequested(refused.env, createLogger(), requested, "trace");
    expect(refused.gateCalls("reviews")).toEqual([]);
    expect(refused.gateCalls("pull-changes")).toEqual([]);
  });
});

describe("check re-run", () => {
  const click = (env: TestEnv, payload = rerequested) =>
    handleCheckRunReviewRequested(env, createLogger(), payload, "trace");

  it.each([
    ["the Re-run button", rerequested],
    [
      "the Review now button",
      {
        ...rerequested,
        action: "requested_action" as const,
        requested_action: { identifier: "review" },
      },
    ],
  ])("asks the gate for a review of the head for %s", async (_name, payload) => {
    const { env, gateCalls } = createEnv();

    const result = await click(env, payload);

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    const [request] = gateCalls("reviews");
    // Head and base are the live pull request's, read just before.
    expect(request).toMatchObject({
      pullNumber: 42,
      headSha: HEAD,
      base: { ref: "main", sha: BASE },
    });
    expect(request.reviewers[0].prompt).toContain("## Pre-merge Review");
    expect(checkSenderPermission).toHaveBeenCalledWith(
      "installation-token",
      "acme",
      "widgets",
      "bob",
      expect.any(String)
    );
  });

  it("finds the pull request from the check's external id, with or without an attempt", async () => {
    const { env, gateCalls } = createEnv();
    const withAttempt = {
      ...rerequested,
      check_run: { ...rerequested.check_run, external_id: "open-inspect:pr=42;attempt=abc123" },
    };

    await click(env, withAttempt);

    expect(getPullRequest).toHaveBeenCalledWith(
      "installation-token",
      "https://api.github.com/repos/acme/widgets/pulls/42",
      expect.any(String)
    );
    expect(gateCalls("reviews")).toHaveLength(1);
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
    const { env, gateCalls } = createEnv();

    expect(await click(env, { ...rerequested, ...change })).toEqual(skip(skip_reason));
    expect(gateCalls("reviews")).toEqual([]);
  });

  it.each([
    ["pr_not_open", { state: "closed" }, {}],
    ["draft_pr", { draft: true }, {}],
    ["merge_gate_off", {}, { mergeGate: "off" as const }],
  ])("skips with %s, read from the live pull request", async (skip_reason, live, config) => {
    useConfig(config);
    vi.mocked(getPullRequest).mockResolvedValue({ ...livePull, ...live });
    const { env, gateCalls, sessionsStarted } = createEnv();

    expect(await click(env)).toEqual(skip(skip_reason));
    expect(gateCalls("reviews")).toEqual([]);
    expect(sessionsStarted()).toBe(0);
  });

  it("starts nothing, and reports nothing, when the requester may not start a review", async () => {
    vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: false });
    const { env, gateCalls } = createEnv();

    expect(await click(env)).toEqual(skip("sender_insufficient_permission"));
    expect(gateCalls("reviews")).toEqual([]);
    expect(gateCalls("pull-changes")).toEqual([]);
  });

  it("leaves a second click to the control plane, which admits one attempt per head", async () => {
    const { env } = createEnv({ reviews: { outcome: "skipped", reason: "review_in_progress" } });

    expect(await click(env)).toEqual(skip("review_in_progress"));
  });
});

describe("check suite re-run", () => {
  const rerunAll = (env: TestEnv, payload = suiteRerequested) =>
    handleCheckSuiteRerequested(env, createLogger(), payload, "trace");

  it("asks the gate for a review when the suite holds the AI Review run", async () => {
    const { env, gateCalls } = createEnv();

    const result = await rerunAll(env);

    expect(result).toMatchObject({ outcome: "processed", handler_action: "review" });
    expect(findSuiteReviewRun).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://api.github.com/repos/acme/widgets" }),
      900
    );
    expect(gateCalls("reviews")[0]).toMatchObject({ pullNumber: 42, headSha: HEAD });
  });

  it.each([
    ["not_ai_review_check", { app: { id: 999 } }, { externalId: "open-inspect:pr=42" }, {}],
    ["check_without_pull_request", {}, { externalId: null }, {}],
    ["check_not_on_head", { head_sha: OLD_HEAD }, { externalId: "open-inspect:pr=42" }, {}],
    ["merge_gate_off", {}, { externalId: "open-inspect:pr=42" }, { mergeGate: "off" as const }],
  ])("skips with %s", async (skip_reason, suite, run, config) => {
    useConfig(config);
    vi.mocked(findSuiteReviewRun).mockResolvedValue(run);
    const { env, gateCalls } = createEnv();
    const payload = {
      ...suiteRerequested,
      check_suite: { ...suiteRerequested.check_suite, ...suite },
    };

    expect(await rerunAll(env, payload)).toEqual(skip(skip_reason));
    expect(gateCalls("reviews")).toEqual([]);
  });

  it("fails the delivery when the suite cannot be read", async () => {
    vi.mocked(findSuiteReviewRun).mockResolvedValue(null);
    const { env } = createEnv();

    await expect(rerunAll(env)).rejects.toThrow("Check suite 900 unreadable");
  });
});

describe("a pull request that changed", () => {
  it.each([
    ["synchronize", "head"],
    ["edited", "base"],
    ["reopened", "reopened"],
  ] as const)("reports %s to the gate as a %s change", async (action, change) => {
    const { env, gateCalls } = createEnv();

    const result = await handlePullRequestChanged(
      env,
      createLogger(),
      { ...synchronized, action },
      "trace"
    );

    expect(result).toEqual({
      outcome: "processed",
      sessions: [],
      handler_action: "check_needs_review",
    });
    expect(gateCalls("pull-changes")).toEqual([
      { repository: { owner: "acme", name: "widgets" }, pullNumber: 42, change, headSha: HEAD },
    ]);
  });

  it("reports what the gate did with it", async () => {
    const carried = createEnv({ "pull-changes": { outcome: "carried_forward" } });
    expect(
      await handlePullRequestChanged(carried.env, createLogger(), synchronized, "trace")
    ).toMatchObject({ outcome: "processed", handler_action: "check_carried_forward" });

    const stale = createEnv({ "pull-changes": { outcome: "skipped", reason: "stale_head" } });
    expect(
      await handlePullRequestChanged(stale.env, createLogger(), synchronized, "trace")
    ).toEqual(skip("stale_head"));
  });

  it("does not call the gate while it is off", async () => {
    useConfig({ mergeGate: "off" });
    const { env, controlPlaneFetch } = createEnv();

    expect(await handlePullRequestChanged(env, createLogger(), synchronized, "trace")).toEqual(
      skip("merge_gate_off")
    );
    expect(controlPlaneFetch).not.toHaveBeenCalled();
  });
});
