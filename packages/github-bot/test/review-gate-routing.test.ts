import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { Env } from "../src/types";

vi.mock("../src/github-auth", () => ({
  generateInstallationToken: vi.fn().mockResolvedValue("installation-token"),
  postReaction: vi.fn().mockResolvedValue(true),
  postIssueComment: vi.fn().mockResolvedValue(true),
  checkSenderPermission: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", () => ({ findSuiteReviewRun: vi.fn() }));

import app from "../src/index";
import { checkSenderPermission, getPullRequest, postIssueComment } from "../src/github-auth";
import { findSuiteReviewRun } from "../src/github-checks";

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
const GATE = "https://internal/github/review-gate/";
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
  vi.mocked(getPullRequest).mockResolvedValue(pullRequest);
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
    if (requestUrl === `${GATE}reviews`) {
      return Response.json({
        outcome: "started",
        attemptId: "attempt-1",
        sessions: [{ sessionId: "gate-1", messageId: "message-1", model: "m" }],
      });
    }
    if (requestUrl === `${GATE}pull-changes`) return Response.json({ outcome: "needs_review" });
    if (requestUrl === `${GATE}overrides`) {
      return Response.json({ outcome: "overridden", headSha: HEAD });
    }
    if (requestUrl.startsWith("https://internal/github/route?")) {
      return Response.json({ teamId: null, via: "workspace" });
    }
    if (requestUrl.endsWith("/metadata")) {
      return Response.json({ repo: "test/repo", metadata: null });
    }
    if (requestUrl === "https://internal/sessions") {
      return Response.json({ sessionId: "session-own", status: "created" });
    }
    if (requestUrl.endsWith("/prompt")) return Response.json({ messageId: "message-own" });
    return new Response(null, { status: 204 });
  });
  const calls = (suffix: string) =>
    cpFetch.mock.calls
      .filter(([url]) => String(url) === suffix || String(url) === `${GATE}${suffix}`)
      .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
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
  return { env, deliver, calls };
}

const pullEvent = (action: string, extra: object = {}) => ({
  action,
  ...extra,
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
  it("does nothing for a submitted or dismissed review: verdicts never come from GitHub", async () => {
    const { env, deliver, calls } = gatedEnv();
    const review = (action: string, login: string) => ({
      action,
      review: { id: 5681, state: "approved", commit_id: HEAD, user: { login, type: "Bot" } },
      pull_request: pullRequest,
      repository,
      sender: bob,
    });

    await deliver("pull_request_review", "delivery-human", review("submitted", "bob"));
    await deliver("pull_request_review", "delivery-bot", review("submitted", "test-bot[bot]"));
    await deliver(
      "pull_request_review",
      "delivery-dismissed",
      review("dismissed", "test-bot[bot]")
    );

    // Autofix still hears about reviews; the gate does not.
    expect(env.AUTOFIX_QUEUE.send).toHaveBeenCalled();
    expect(calls("reviews")).toEqual([]);
    expect(calls("pull-changes")).toEqual([]);
    expect(calls("https://internal/sessions")).toEqual([]);
  });

  it.each([
    ["synchronize", {}, "head"],
    ["reopened", {}, "reopened"],
    ["edited", { changes: { base: { ref: { from: "main" }, sha: { from: BASE } } } }, "base"],
  ])(
    "reports %s to the gate once per delivery, starting no review",
    async (action, extra, change) => {
      const { deliver, calls } = gatedEnv();
      const payload = pullEvent(action, extra);

      await deliver("pull_request", `delivery-${action}`, payload);
      await deliver("pull_request", `delivery-${action}`, payload);

      expect(calls("pull-changes")).toEqual([
        { repository: { owner: "test", name: "repo" }, pullNumber: 42, change, headSha: HEAD },
      ]);
      expect(calls("reviews")).toEqual([]);
      expect(calls("https://internal/sessions")).toEqual([]);
    }
  );

  it("ignores an edit that does not change the base branch", async () => {
    const { deliver, calls } = gatedEnv();

    await deliver(
      "pull_request",
      "delivery-edit-title",
      pullEvent("edited", { changes: { title: { from: "Old title" } } })
    );

    expect(calls("pull-changes")).toEqual([]);
  });

  it("leaves pull request changes alone while the gate is off", async () => {
    const { deliver, calls } = gatedEnv("off");

    await deliver("pull_request", "delivery-sync-off", pullEvent("synchronize"));

    expect(calls("pull-changes")).toEqual([]);
  });

  it.each(["opened", "ready_for_review"])(
    "starts a gated review when a pull request is %s",
    async (action) => {
      const { deliver, calls } = gatedEnv("shadow");

      await deliver("pull_request", `delivery-${action}`, pullEvent(action));

      expect(calls("reviews")).toHaveLength(1);
      expect(calls("https://internal/sessions")).toEqual([]);
    }
  );

  it.each([
    ["rerequested", {}],
    ["requested_action", { requested_action: { identifier: "review" } }],
  ])(
    "starts a gated review for check_run %s on our check, once per delivery",
    async (action, extra) => {
      const { deliver, calls } = gatedEnv();
      const payload = checkRun(action, {}, extra);

      await deliver("check_run", `delivery-check-${action}`, payload);
      await deliver("check_run", `delivery-check-${action}`, payload);

      expect(calls("reviews")).toHaveLength(1);
      expect(calls("reviews")[0]).toMatchObject({ pullNumber: 42, headSha: HEAD });
    }
  );

  it("starts a gated review for a check suite re-run", async () => {
    const { deliver, calls } = gatedEnv();

    await deliver("check_suite", "delivery-suite", {
      action: "rerequested",
      check_suite: { id: 900, head_sha: HEAD, app: { id: 12345 }, pull_requests: [] },
      repository,
      sender: bob,
    });

    expect(findSuiteReviewRun).toHaveBeenCalledWith(expect.anything(), 900);
    expect(calls("reviews")).toHaveLength(1);
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
    const { deliver, calls } = gatedEnv();

    await deliver(event, "delivery-check-other", payload);

    expect(calls("reviews")).toEqual([]);
  });

  it("asks the gate for an override, without starting a session", async () => {
    const { deliver, calls } = gatedEnv();

    await deliver(
      "issue_comment",
      "delivery-override",
      comment("@test-bot override aaaaaaa hotfix")
    );

    expect(calls("overrides")).toEqual([
      {
        repository: { owner: "test", name: "repo" },
        pullNumber: 42,
        commit: "aaaaaaa",
        reason: "hotfix",
        overriddenBy: "bob",
      },
    ]);
    expect(calls("https://internal/sessions")).toEqual([]);
  });

  it("replies once to an override without a reason, even when redelivered", async () => {
    const { env, deliver, calls } = gatedEnv();
    const empty = comment("@test-bot override aaaaaaa");

    await deliver("issue_comment", "delivery-override-empty", empty);
    await deliver("issue_comment", "delivery-override-empty", empty);

    expect(calls("overrides")).toEqual([]);
    expect(postIssueComment).toHaveBeenCalledOnce();
    expect(await env.GITHUB_KV.get("delivery-dispatch:delivery-override-empty")).toBe("processed");
  });

  it("starts a normal session for an override comment while the gate is off", async () => {
    const { deliver, calls } = gatedEnv("off");

    await deliver(
      "issue_comment",
      "delivery-override-off",
      comment("@test-bot override aaaaaaa x")
    );

    expect(calls("https://internal/sessions")).toHaveLength(1);
    expect(calls("overrides")).toEqual([]);
  });
});
