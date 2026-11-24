import { vi } from "vitest";
import { GITHUB_AUTOFIX_DEFAULTS, type GitHubAutofixEnvelope } from "@open-inspect/shared";
import { AutofixService } from "./service";
import type { GitHubPullRequestFeedback } from "../source-control/providers/github-provider";
import type { CredentialScope } from "../source-control";

export type ReviewFeedback = Extract<GitHubPullRequestFeedback, { kind: "review" }>;

export const PR_COMMENT_ENVELOPE: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "issue_comment",
  action: "created",
  deliveryId: "delivery-1",
  providerObject: { kind: "pr_comment", id: "1234" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

export const OPEN_INSPECT_REVIEW_ENVELOPE: GitHubAutofixEnvelope = {
  version: 1,
  eventType: "pull_request_review",
  action: "submitted",
  deliveryId: "delivery-2",
  providerObject: { kind: "review", id: "5678" },
  repository: { id: "99", owner: "acme", name: "widgets" },
  pullRequestNumber: 42,
  receivedAt: "2026-07-30T05:00:00.000Z",
};

export function openInspectReview(
  overrides: Partial<Omit<ReviewFeedback, "kind" | "id" | "url" | "author">> = {}
): ReviewFeedback {
  return {
    kind: "review",
    id: "5678",
    body: "Please address this.",
    url: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
    state: "CHANGES_REQUESTED",
    author: { id: "9", login: "Open-Inspect[bot]", type: "Bot" },
    comments: [],
    ...overrides,
  };
}

export type ReviewComment = ReviewFeedback["comments"][number];

export function inlineComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "9003",
    inReplyToId: null,
    body: "Non-blocking: add an exhaustiveness check.",
    url: "https://github.com/acme/widgets/pull/42#discussion_r9003",
    path: "src/input.ts",
    line: 12,
    startLine: null,
    originalLine: 12,
    originalStartLine: null,
    side: "RIGHT",
    startSide: null,
    diffHunk: "@@ -10,3 +10,3 @@",
    ...overrides,
  };
}

export function buildService() {
  const received: {
    feedbackKey: string;
    decision: "received" | "queued" | "skipped" | "failed";
    dispatchAttemptedAt: number | null;
    messageId: string | null;
    reason?: string | null;
  } = {
    feedbackKey: "github:pr_comment:1234",
    decision: "received",
    dispatchAttemptedAt: null,
    messageId: null,
  };
  const feedbackStore = {
    receive: vi.fn(
      async (): Promise<{
        feedbackKey: string;
        decision: "received" | "queued" | "skipped" | "failed";
        dispatchAttemptedAt: number | null;
        messageId: string | null;
      }> => received
    ),
    get: vi.fn(async () => received),
    attachContext: vi.fn(async () => undefined),
    markDispatchAttempted: vi.fn(async () => undefined),
    markQueued: vi.fn(async () => undefined),
    markSkipped: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    recordError: vi.fn(async () => undefined),
  };
  const pullRequests = {
    getByIdentity: vi.fn(async () => ({
      artifactId: "artifact-1",
      sessionId: "session-1",
      repoOwner: "acme",
      repoName: "widgets",
      prNumber: 42,
    })),
  };
  const settings = {
    resolve: vi.fn(async () => ({
      enabledRepos: null,
      autofix: { ...GITHUB_AUTOFIX_DEFAULTS, enabled: true },
    })),
  };
  const github = {
    getPullRequest: vi.fn(async () => ({
      lifecycleState: "open" as const,
      repoOwner: "acme",
      repoName: "widgets",
    })),
    getPullRequestFeedback: vi.fn(async (): Promise<GitHubPullRequestFeedback> => ({
      kind: "pr_comment",
      id: "1234",
      body: "Please handle the null case.",
      url: "https://github.com/acme/widgets/pull/42#issuecomment-1234",
      author: { id: "7", login: "alice", type: "User" },
    })),
    hasPullRequestWritePermission: vi.fn(async () => true),
  };
  const sessions = {
    fetch: vi.fn(async () => Response.json({ kind: "enqueued", messageId: "message-1" })),
  };
  const credentialScope: CredentialScope = { kind: "repositories", repositoryIds: [99, 123] };
  const resolveCredentialScope = vi.fn(async () => credentialScope);
  const service = new AutofixService(
    feedbackStore,
    pullRequests,
    settings,
    github,
    sessions,
    { username: "open-inspect[bot]", command: "oi" },
    () => 2_000,
    resolveCredentialScope
  );

  return {
    service,
    feedbackStore,
    pullRequests,
    settings,
    github,
    sessions,
    credentialScope,
    resolveCredentialScope,
  };
}
