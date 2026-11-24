import { vi } from "vitest";
import type {
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
  postIssueComment,
  postReaction,
} from "../src/github-auth";
import { findSuiteReviewRun } from "../src/github-checks";
import { getGitHubConfig } from "../src/utils/integration-config";

/**
 * Shared fixtures for the merge-gate tests. Each test file mocks `github-auth`,
 * `github-checks` and `utils/integration-config` itself; the helpers here drive those mocks.
 */
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const OLD_HEAD = "c".repeat(40);
export const BOT = "test-bot[bot]";
export const HAIKU = "anthropic/claude-haiku-4-5";
export const SOL = "openai/gpt-5.6-sol";

export const baseConfig: ResolvedGitHubConfig = {
  model: HAIKU,
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
/** The pull request as GitHub returns it now. */
export const livePull = { ...pullRequest, state: "open", draft: false };

export const opened: PullRequestOpenedPayload = {
  action: "opened",
  pull_request: { ...pullRequest, draft: false },
  repository,
  sender: alice,
};

export const synchronized: PullRequestChangedPayload = {
  action: "synchronize",
  pull_request: { number: 42, head: { sha: HEAD } },
  repository,
  sender: alice,
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

const GATE = "https://internal/github/review-gate/";

/** The control plane as the bot sees it; `gate` answers the merge-gate endpoints. */
export function createEnv(
  gate: Partial<Record<"reviews" | "pull-changes" | "overrides", unknown>> = {}
) {
  const kv = new Map<string, string>();
  const answers: Record<string, unknown> = {
    reviews: {
      outcome: "started",
      attemptId: "attempt-1",
      sessions: [{ sessionId: "gate-session-1", messageId: "gate-message-1", model: HAIKU }],
    },
    "pull-changes": { outcome: "needs_review" },
    overrides: { outcome: "overridden", headSha: HEAD },
    ...gate,
  };
  const controlPlaneFetch = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url.startsWith(GATE)) {
      const answer = answers[url.slice(GATE.length)];
      return answer instanceof Response ? answer : Response.json(answer);
    }
    if (url.startsWith("https://internal/github/route?")) {
      return Response.json({ teamId: null, via: "workspace" });
    }
    if (url.endsWith("/metadata")) return Response.json({ repo: "acme/widgets", metadata: null });
    if (url === "https://internal/model-preferences?strict=true") {
      return Response.json({ enabledModels: [HAIKU, SOL] });
    }
    if (url === "https://internal/sessions") {
      return Response.json({ sessionId: "session-1", status: "created" });
    }
    if (url.endsWith("/prompt")) return Response.json({ messageId: "message-1" });
    return new Response("Not found", { status: 404 });
  });
  const env = {
    GITHUB_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    CONTROL_PLANE: { fetch: controlPlaneFetch },
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: HAIKU,
    GITHUB_BOT_USERNAME: BOT,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "test-key",
    GITHUB_APP_INSTALLATION_ID: "67890",
    GITHUB_WEBHOOK_SECRET: "test-secret",
    SERVICE_AUTH_SECRET: "test-internal-secret",
    LOG_LEVEL: "error",
  } as unknown as Env;
  /** Bodies of the calls to one merge-gate endpoint, in order. */
  const gateCalls = (endpoint: "reviews" | "pull-changes" | "overrides") =>
    controlPlaneFetch.mock.calls
      .filter(([url]) => url === `${GATE}${endpoint}`)
      .map(([, init]) => JSON.parse(String(init?.body)));
  const sessionsStarted = () =>
    controlPlaneFetch.mock.calls.filter(([url]) => url === "https://internal/sessions").length;
  /** Prompts the bot sent to sessions it started itself, outside the gate. */
  const ownPrompts = () =>
    controlPlaneFetch.mock.calls
      .filter(([url]) => url.endsWith("/prompt"))
      .map(([, init]) => String(JSON.parse(String(init?.body)).content));
  return { env, controlPlaneFetch, gateCalls, sessionsStarted, ownPrompts };
}

export function useConfig(overrides: Partial<ResolvedGitHubConfig> = {}) {
  vi.mocked(getGitHubConfig).mockResolvedValue({ ...baseConfig, ...overrides });
}

/** Fresh mocks for a gate that is on, with one reviewer and an open pull request. */
export function resetGateMocks(): void {
  vi.clearAllMocks();
  useConfig();
  vi.mocked(generateInstallationToken).mockResolvedValue("installation-token");
  vi.mocked(postReaction).mockResolvedValue(true);
  vi.mocked(postIssueComment).mockResolvedValue(true);
  vi.mocked(checkSenderPermission).mockResolvedValue({ hasPermission: true });
  vi.mocked(getPullRequest).mockResolvedValue(livePull);
  vi.mocked(findSuiteReviewRun).mockResolvedValue({ externalId: "open-inspect:pr=42" });
}
