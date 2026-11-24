import { vi } from "vitest";
import type {
  BotReviewPayload,
  CheckRunPayload,
  CheckSuitePayload,
  Env,
  IssueCommentPayload,
  PullRequestChangedPayload,
  PullRequestOpenedPayload,
} from "../src/types";
import type { Logger } from "../src/logger";
import type { ResolvedGitHubConfig } from "../src/utils/integration-config";
import {
  checkSenderPermission,
  generateInstallationToken,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
  postReaction,
  type PullRequestReview,
} from "../src/github-auth";
import {
  createCheckRun,
  findSuiteReviewRun,
  getCompareDiff,
  listOpenPullsWithHead,
  updateCheckRun,
} from "../src/github-checks";
import { getGitHubConfig } from "../src/utils/integration-config";

/**
 * Shared fixtures for the AI Review check tests. Each test file mocks `github-auth`,
 * `github-checks` and `utils/integration-config` itself; the helpers here drive those mocks.
 */
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const OLD_HEAD = "c".repeat(40);
export const BOT = "test-bot[bot]";
export const VERDICT_KEY = "ai-review:verdict:acme/widgets#42";
export const ATTEMPT_KEY = "ai-review:attempt:acme/widgets#42";
export const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
export const KEY_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const KEY_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const DIFF_HASH = "d".repeat(64);
export const HAIKU = "anthropic/claude-haiku-4-5";
export const SOL = "openai/gpt-5.6-sol";
export const marker = (reviewerKey: string, attemptId = ATTEMPT_ID) =>
  `<!-- open-inspect:review attempt=${attemptId} reviewer=${reviewerKey} -->`;
/** Long enough ago that an attempt started then counts as stuck. */
export const LONG_AGO = "2020-01-01T00:00:00.000Z";

export const baseConfig: ResolvedGitHubConfig = {
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

export const twoReviewers = [
  { model: HAIKU, harness: "opencode" as const },
  { model: SOL, harness: "opencode" as const },
];
export const twoReviewerKeys = [
  { key: KEY_A, model: HAIKU },
  { key: KEY_B, model: SOL },
];

export const repository = { id: 99, owner: { login: "acme" }, name: "widgets", private: false };
export const alice = { login: "alice", id: 1001, avatar_url: "https://avatars.test/1001" };
export const bob = { login: "bob", id: 1002, avatar_url: "https://avatars.test/1002" };
export const pullRequest = {
  number: 42,
  title: "Add caching",
  body: "Adds Redis caching",
  user: { login: "alice" },
  head: { ref: "feature/cache", sha: HEAD },
  base: { ref: "main", sha: BASE },
};

export const opened: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: { ...pullRequest, draft: false },
  repository,
  sender: alice,
};

export const synchronized: PullRequestChangedPayload = {
  action: "synchronize",
  pull_request: { ...pullRequest, draft: false, state: "open" },
  repository,
  sender: alice,
};

/** The pull request as GitHub returns it now. */
export const livePull = { ...pullRequest, state: "open", draft: false };

export const botReview: BotReviewPayload = {
  action: "submitted",
  review: { commit_id: HEAD, user: { login: BOT } },
  pull_request: pullRequest,
  repository,
  sender: { login: BOT, id: 5, avatar_url: "https://avatars.test/5" },
};

export const rerequested: CheckRunPayload = {
  action: "rerequested",
  check_run: {
    name: "AI Review",
    head_sha: HEAD,
    app: { id: 12345 },
    external_id: "open-inspect:pr=42",
  },
  repository,
  sender: bob,
};

export const suiteRerequested: CheckSuitePayload = {
  action: "rerequested",
  check_suite: { id: 900, head_sha: HEAD, app: { id: 12345 } },
  repository,
  sender: bob,
};

export function overrideComment(body: string, sender = bob): IssueCommentPayload {
  return {
    action: "created",
    issue: { number: 42, title: "Add caching", pull_request: { url: "https://api.test/pulls/42" } },
    comment: { id: 100, body, user: { login: sender.login } },
    repository,
    sender,
  };
}

export function review(overrides: Partial<PullRequestReview> = {}): PullRequestReview {
  return {
    login: BOT,
    commitId: HEAD,
    state: "COMMENTED",
    body: `Looks good.\n${marker(KEY_A)}`,
    url: "https://github.test/review/1",
    submittedAt: "2026-11-23T10:05:00.000Z",
    ...overrides,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

export async function defaultControlPlane(url: string): Promise<Response> {
  if (url.startsWith("https://internal/github/route?")) {
    return Response.json({ teamId: null, via: "workspace" });
  }
  if (url.endsWith("/metadata")) return Response.json({ repo: "acme/widgets", metadata: null });
  if (url === "https://internal/sessions") {
    return Response.json({ sessionId: "session-1", status: "created" });
  }
  if (url.endsWith("/prompt")) return Response.json({ messageId: "message-1" });
  return new Response("Not found", { status: 404 });
}

/** The prompt text of every session started, in order. */
export function prompts(
  controlPlaneFetch: ReturnType<typeof createEnv>["controlPlaneFetch"]
): string[] {
  return controlPlaneFetch.mock.calls
    .filter(([url]) => url.endsWith("/prompt"))
    .map((call) => {
      const [, init] = call as unknown as [string, { body: string }];
      return String(JSON.parse(init.body).content);
    });
}

export function createEnv() {
  const kv = new Map<string, string>();
  const controlPlaneFetch = vi.fn(defaultControlPlane);
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
  const remove = (key: string) => kv.delete(key);
  return { env, controlPlaneFetch, sessionsStarted, json, seed, remove };
}

export function useConfig(overrides: Partial<ResolvedGitHubConfig> = {}) {
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...baseConfig, ...overrides });
}

/** A review attempt on the head with its check run posted, as `startCheckedReview` records it. */
export function attempt(overrides: object = {}) {
  return {
    id: ATTEMPT_ID,
    prNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    baseRef: "main",
    startedAt: LONG_AGO,
    reviewers: [{ key: KEY_A, model: HAIKU }],
    checkRunId: 7,
    diffHash: DIFF_HASH,
    concludedAt: null,
    ...overrides,
  };
}

/** A verdict reached by `attempt()` on the head. */
export function verdict(overrides: object = {}) {
  return {
    sha: HEAD,
    reviewedSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
    diffHash: DIFF_HASH,
    approved: true,
    summary: "- Claude Haiku 4.5: approve ([review](https://github.test/review/1))",
    attemptId: ATTEMPT_ID,
    ...overrides,
  };
}

/** Fresh mocks for a gate that is on, with one reviewer and an open pull request. */
export function resetGateMocks(): void {
  vi.clearAllMocks();
  vi.useRealTimers();
  useConfig();
  vi.mocked(generateInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(postIssueComment).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(listPullRequestReviews).mockResolvedValue([]);
  vi.mocked(getPullRequest).mockResolvedValue(livePull);
  vi.mocked(listOpenPullsWithHead).mockResolvedValue([42]);
  vi.mocked(findSuiteReviewRun).mockResolvedValue({ externalId: "open-inspect:pr=42" });
  vi.mocked(createCheckRun).mockResolvedValue(7);
  vi.mocked(updateCheckRun).mockResolvedValue(true);
  vi.mocked(getCompareDiff).mockResolvedValue("diff --git a/x b/x\n+one\n");
}
