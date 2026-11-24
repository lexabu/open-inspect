import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { Env } from "../src/types";
import type * as GitHubChecks from "../src/github-checks";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  postIssueComment: vi.fn().mockResolvedValue(true),
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

import app from "../src/index";
import {
  checkSenderPermission,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
} from "../src/github-auth";
import {
  createCheckRun,
  findSuiteReviewRun,
  getCompareDiff,
  listOpenPullsWithHead,
  updateCheckRun,
} from "../src/github-checks";

/** Generate a valid GitHub webhook signature for a given secret and body. */
async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

const SECRET = "test-webhook-secret";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: "json") => {
      const value = store.get(key) ?? null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function makeEnv() {
  const githubKv = createMockKV();
  return {
    GITHUB_KV: githubKv,
    AUTOFIX_QUEUE: {
      send: vi.fn(async () => undefined),
    },
    CONTROL_PLANE: {
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    },
    GITHUB_WEBHOOK_SECRET: SECRET,
    SERVICE_AUTH_SECRET: "test-internal-secret",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
  } as unknown as Env;
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}

async function flushWaitUntil(ctx: ReturnType<typeof makeCtx>, callIndex = 0): Promise<void> {
  await ctx.waitUntil.mock.calls[callIndex]?.[0];
}

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ATTEMPT_KEY = "ai-review:attempt:test/repo#42";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const MARKER = `<!-- open-inspect:review attempt=${ATTEMPT_ID} reviewer=key-a -->`;
const repository = { id: 99, owner: { login: "test" }, name: "repo", private: false };
const bob = { login: "bob", id: 1002, avatar_url: "https://avatars.test/1002", type: "User" };
const pullRequest = {
  number: 42,
  title: "Add caching",
  body: null,
  user: { login: "alice" },
  head: { ref: "feature/cache", sha: HEAD },
  base: { ref: "main", sha: BASE },
  draft: false,
  state: "open",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(listPullRequestReviews).mockResolvedValue([]);
  vi.mocked(getPullRequest).mockResolvedValue(pullRequest);
  vi.mocked(createCheckRun).mockResolvedValue(7);
  vi.mocked(updateCheckRun).mockResolvedValue(true);
  vi.mocked(getCompareDiff).mockResolvedValue("diff --git a/x b/x\n+one\n");
  vi.mocked(listOpenPullsWithHead).mockResolvedValue([42]);
  vi.mocked(findSuiteReviewRun).mockResolvedValue({ externalId: "open-inspect:pr=42" });
});

function gatedEnv(mergeGate: "off" | "shadow" | "required" = "required") {
  const env = makeEnv();
  Object.assign(env, { GITHUB_APP_ID: "12345" });
  const cpFetch = vi.mocked(env.CONTROL_PLANE.fetch);
  cpFetch.mockImplementation(async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/integration-settings/github/resolved/")) {
      return Response.json({
        config: {
          model: null,
          reasoningEffort: null,
          mergeGate,
          autoReviewOnOpen: true,
          enabledRepos: null,
          allowedTriggerUsers: null,
          codeReviewInstructions: null,
          commentActionInstructions: null,
        },
      });
    }
    if (requestUrl.startsWith("https://internal/github/route?")) {
      return Response.json({ teamId: null, via: "workspace" });
    }
    if (requestUrl.endsWith("/metadata")) {
      return Response.json({ repo: "test/repo", metadata: null });
    }
    if (requestUrl === "https://internal/sessions") {
      return Response.json({ sessionId: "session-gate", status: "created" });
    }
    if (requestUrl.endsWith("/prompt")) return Response.json({ messageId: "message-gate" });
    return new Response(null, { status: 204 });
  });
  const sessionsCreated = () =>
    cpFetch.mock.calls.filter(([url]) => String(url) === "https://internal/sessions").length;
  const deliver = async (event: string, deliveryId: string, payload: object) => {
    const body = JSON.stringify(payload);
    const ctx = makeCtx();
    const res = await app.fetch(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": await sign(SECRET, body),
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": deliveryId,
        },
      }),
      env,
      ctx
    );
    await flushWaitUntil(ctx);
    return res;
  };
  const seedAttempt = (overrides: object = {}) =>
    env.GITHUB_KV.put(
      ATTEMPT_KEY,
      JSON.stringify({
        id: ATTEMPT_ID,
        prNumber: 42,
        headSha: HEAD,
        baseSha: BASE,
        baseRef: "main",
        startedAt: "2020-01-01T00:00:00.000Z",
        reviewers: [{ key: "key-a", model: "anthropic/claude-haiku-4-5", seen: null }],
        checkRunId: 7,
        diffHash: null,
        concludedAt: null,
        ...overrides,
      })
    );
  return { env, deliver, sessionsCreated, seedAttempt };
}

const botReviewed = (state: string) => [
  {
    id: 1,
    login: "test-bot[bot]",
    commitId: HEAD,
    state,
    body: MARKER,
    url: "https://github.test/review/1",
    submittedAt: "2026-11-23T10:05:00Z",
  },
];

const reviewEvent = (action: string, login: string) => ({
  action,
  review: { id: 5681, state: "approved", commit_id: HEAD, user: { login, type: "Bot" } },
  pull_request: pullRequest,
  repository,
  sender: bob,
});

const comment = (body: string) => ({
  action: "created",
  issue: { number: 42, title: "Add caching", pull_request: { url: "https://api.test/pulls/42" } },
  comment: { id: 100, body, user: { login: "bob", type: "User" } },
  repository,
  sender: bob,
});

const checkRun = (action: string, check: object = {}, extra: object = {}) => ({
  action,
  ...extra,
  check_run: {
    id: 7,
    name: "AI Review",
    head_sha: HEAD,
    app: { id: 12345 },
    external_id: "open-inspect:pr=42",
    // GitHub leaves this empty for fork pull requests; the bot never relies on it.
    pull_requests: [],
    ...check,
  },
  repository,
  sender: bob,
});

describe("AI Review merge gate routing", () => {
  it("starts no review and touches no check when a human approves", async () => {
    const { env, deliver, sessionsCreated } = gatedEnv();

    await deliver("pull_request_review", "delivery-human", reviewEvent("submitted", "bob"));

    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalledOnce();
    expect(sessionsCreated()).toBe(0);
    expect(listPullRequestReviews).not.toHaveBeenCalled();
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes the check from the bot's own review, and again when it is dismissed", async () => {
    const { deliver, sessionsCreated, seedAttempt } = gatedEnv();
    await seedAttempt();
    vi.mocked(listPullRequestReviews).mockResolvedValue(botReviewed("APPROVED"));

    await deliver("pull_request_review", "delivery-bot", reviewEvent("submitted", "test-bot[bot]"));
    expect(updateCheckRun).toHaveBeenLastCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({ status: "completed", conclusion: "success" })
    );

    vi.mocked(listPullRequestReviews).mockResolvedValue(botReviewed("DISMISSED"));
    await deliver(
      "pull_request_review",
      "delivery-dismissed",
      reviewEvent("dismissed", "test-bot[bot]")
    );
    expect(updateCheckRun).toHaveBeenLastCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({ conclusion: "failure" })
    );
    expect(sessionsCreated()).toBe(0);
  });

  it("ignores the dismissal of a human's review", async () => {
    const { deliver, seedAttempt } = gatedEnv();
    // Still inside its window, so the stuck-check pass leaves it alone too.
    await seedAttempt({ startedAt: new Date().toISOString() });

    await deliver(
      "pull_request_review",
      "delivery-human-dismissed",
      reviewEvent("dismissed", "bob")
    );

    expect(listPullRequestReviews).not.toHaveBeenCalled();
  });

  it("asks for a review on synchronize without starting one, once per delivery", async () => {
    const { deliver, sessionsCreated } = gatedEnv();
    const payload = { action: "synchronize", pull_request: pullRequest, repository, sender: bob };

    await deliver("pull_request", "delivery-sync", payload);
    await deliver("pull_request", "delivery-sync", payload);

    expect(sessionsCreated()).toBe(0);
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD, externalId: "open-inspect:pr=42" }),
      expect.objectContaining({ conclusion: "action_required", reviewAction: true })
    );
  });

  it("asks for a review when the base branch is changed, and ignores other edits", async () => {
    const { deliver } = gatedEnv();
    const edited = { action: "edited", pull_request: pullRequest, repository, sender: bob };

    await deliver("pull_request", "delivery-edit-title", {
      ...edited,
      changes: { title: { from: "Old title" } },
    });
    expect(createCheckRun).not.toHaveBeenCalled();

    await deliver("pull_request", "delivery-edit-base", {
      ...edited,
      changes: { base: { ref: { from: "main" }, sha: { from: BASE } } },
    });
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD }),
      expect.objectContaining({ conclusion: "action_required" })
    );
  });

  it("leaves synchronize alone while the gate is off", async () => {
    const { deliver } = gatedEnv("off");

    await deliver("pull_request", "delivery-sync-off", {
      action: "synchronize",
      pull_request: pullRequest,
      repository,
      sender: bob,
    });

    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("reviews a pull request that leaves draft and shows the check in progress", async () => {
    const { deliver, sessionsCreated } = gatedEnv("shadow");

    await deliver("pull_request", "delivery-ready", {
      action: "ready_for_review",
      pull_request: pullRequest,
      repository,
      sender: bob,
    });

    expect(sessionsCreated()).toBe(1);
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD }),
      expect.objectContaining({ status: "in_progress" })
    );
  });

  it.each([
    ["rerequested", {}],
    ["requested_action", { requested_action: { identifier: "review" } }],
  ])("starts a review for check_run %s on our check, once per delivery", async (action, extra) => {
    const { deliver, sessionsCreated } = gatedEnv();
    const payload = checkRun(action, {}, extra);

    await deliver("check_run", `delivery-check-${action}`, payload);
    await deliver("check_run", `delivery-check-${action}`, payload);

    expect(sessionsCreated()).toBe(1);
    expect(createCheckRun).toHaveBeenCalledOnce();
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD }),
      expect.objectContaining({ status: "in_progress" })
    );
  });

  it("starts one review when a suite re-run and a run re-run arrive for one click", async () => {
    const { deliver, sessionsCreated } = gatedEnv();

    await deliver("check_suite", "delivery-suite", {
      action: "rerequested",
      check_suite: { id: 900, head_sha: HEAD, app: { id: 12345 }, pull_requests: [] },
      repository,
      sender: bob,
    });
    await deliver("check_run", "delivery-suite-run", checkRun("rerequested"));

    expect(findSuiteReviewRun).toHaveBeenCalledWith(expect.anything(), 900);
    expect(sessionsCreated()).toBe(1);
    expect(createCheckRun).toHaveBeenCalledOnce();
  });

  it.each([
    ["another check", "check_run", checkRun("rerequested", { name: "e2e" })],
    ["another App's check", "check_run", checkRun("rerequested", { app: { id: 999 } })],
    ["a created check", "check_run", checkRun("created")],
    [
      "a check with no pull request named",
      "check_run",
      checkRun("rerequested", { external_id: null }),
    ],
    [
      "a completed suite",
      "check_suite",
      {
        action: "completed",
        check_suite: { id: 900, head_sha: HEAD, app: { id: 12345 } },
        repository,
        sender: bob,
      },
    ],
  ])("ignores %s", async (_name, event, payload) => {
    const { deliver, sessionsCreated } = gatedEnv();

    await deliver(event, "delivery-check-other", payload);

    expect(sessionsCreated()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("passes the check on an override comment without starting a session", async () => {
    const { deliver, sessionsCreated } = gatedEnv();

    await deliver(
      "issue_comment",
      "delivery-override",
      comment("@test-bot override aaaaaaa hotfix")
    );

    expect(sessionsCreated()).toBe(0);
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: HEAD }),
      expect.objectContaining({
        conclusion: "success",
        output: expect.objectContaining({ title: "Overridden by @bob" }),
      })
    );
  });

  it("replies once to an override for another commit, even when redelivered", async () => {
    const { env, deliver, sessionsCreated } = gatedEnv();
    const stale = comment("@test-bot override ccccccc it was fine");

    await deliver("issue_comment", "delivery-override-stale", stale);
    await deliver("issue_comment", "delivery-override-stale", stale);

    expect(sessionsCreated()).toBe(0);
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(postIssueComment).toHaveBeenCalledOnce();
    expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-override-stale")).toBe("processed");
  });

  it("starts a normal session for an override comment while the gate is off", async () => {
    const { deliver, sessionsCreated } = gatedEnv("off");

    await deliver(
      "issue_comment",
      "delivery-override-off",
      comment("@test-bot override aaaaaaa x")
    );

    expect(sessionsCreated()).toBe(1);
    expect(createCheckRun).not.toHaveBeenCalled();
  });

  it("concludes a check left in progress on the next webhook for its pull request", async () => {
    const { env, deliver, sessionsCreated, seedAttempt } = gatedEnv();
    await seedAttempt();

    await deliver("issue_comment", "delivery-plain-comment", comment("Looks fine to me."));

    expect(sessionsCreated()).toBe(0);
    expect(updateCheckRun).toHaveBeenCalledWith(
      expect.anything(),
      7,
      expect.objectContaining({
        conclusion: "failure",
        output: expect.objectContaining({ title: "The AI review did not finish" }),
      })
    );
    const record = await env.GITHUB_KV.get(ATTEMPT_KEY, "json");
    expect(record).toMatchObject({ concludedAt: expect.any(String) });
  });

  it("does not fail a delivery when the stuck-check pass cannot read GitHub", async () => {
    const { env, deliver, seedAttempt } = gatedEnv();
    await seedAttempt();
    vi.mocked(listPullRequestReviews).mockResolvedValue(null);

    await deliver("issue_comment", "delivery-stuck-unreadable", comment("Looks fine to me."));

    expect(await env.GITHUB_KV.get("delivery:delivery-stuck-unreadable")).toBe("processed");
    expect(await env.GITHUB_KV.get(ATTEMPT_KEY, "json")).toMatchObject({ concludedAt: null });
  });
});
