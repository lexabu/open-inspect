import type {
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  ReviewSubmittedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { buildCodeReviewPrompt, buildCommentActionPrompt, type ReviewerContext } from "./prompts";
import type { ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema, reviewStatePayloadSchema } from "./payload-schemas";
import {
  containsBotMention,
  isBotLogin,
  stripBotMention,
} from "@open-inspect/shared/github-mention";
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";
import { startSession, type HandlerResult } from "./session-startup";

export type { HandlerResult } from "./session-startup";

/** GitHub rejects APPROVE and REQUEST_CHANGES reviews from a PR's author, including the App. */
function isAuthoredByBot(pr: { user: { login: string } }, env: Env): boolean {
  return isBotLogin(pr.user.login, env.GITHUB_BOT_USERNAME);
}

export function isReviewRequestedForBot(payload: unknown, botUsername: string): boolean {
  const parsed = requestedReviewerPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  return isBotLogin(parsed.data.requested_reviewer?.login, botUsername);
}

/** The review prompt for a PR, pinned to its head and base commits. */
function reviewPromptFor(
  env: Env,
  repo: ReviewRequestedPayload["repository"],
  pr: ReviewRequestedPayload["pull_request"],
  preMerge: boolean
): (config: ResolvedGitHubConfig, reviewer: ReviewerContext | null) => string {
  return (config, reviewer) =>
    buildCodeReviewPrompt({
      owner: repo.owner.login,
      repo: repo.name,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      author: pr.user.login,
      base: pr.base.ref,
      head: pr.head.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      isPublic: !repo.private,
      codeReviewInstructions: config.codeReviewInstructions,
      isSelfReview: isAuthoredByBot(pr, env),
      reviewer,
      commentOnlyReviews: config.commentOnlyReviews,
      preMerge,
    });
}

/** Only approvals start the pre-merge review; other review states are not parsed further. */
export function isApprovalReview(payload: unknown): boolean {
  const parsed = reviewStatePayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.review?.state.toLowerCase() === "approved";
}

export async function handleReviewRequested(
  env: Env,
  log: Logger,
  payload: ReviewRequestedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, requested_reviewer, sender } = payload;

  if (!isBotLogin(requested_reviewer?.login, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.review_not_for_bot", {
      trace_id: traceId,
      requested_reviewer: requested_reviewer?.login,
    });
    return { outcome: "skipped", skip_reason: "review_not_for_bot" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: Review PR #${pr.number}`,
    action: "review",
    reactionPath: `issues/${pr.number}`,
    reviewedCommit: { sha: pr.head.sha, preMerge: false },
    buildPrompt: reviewPromptFor(env, repo, pr, false),
  });
}

/**
 * The pre-merge review: a human approval of the PR's current head starts one more
 * review, unless the bot has already reviewed that commit. Branch rules that dismiss
 * stale approvals make the last approval land on the code that merges.
 */
export async function handleReviewApproved(
  env: Env,
  log: Logger,
  payload: ReviewSubmittedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { review, pull_request: pr, repository: repo, sender } = payload;
  const skip = (skip_reason: string): HandlerResult => {
    log.debug("handler.approval_review_skipped", {
      trace_id: traceId,
      pull_number: pr.number,
      skip_reason,
    });
    return { outcome: "skipped", skip_reason };
  };

  if (!isApprovalReview(payload)) return skip("review_not_approval");
  if (review.user.type === "Bot" || isBotLogin(review.user.login, env.GITHUB_BOT_USERNAME)) {
    return skip("bot_approval");
  }
  if (pr.state !== "open") return skip("pr_not_open");
  if (pr.draft) return skip("draft_pr");
  // An approval of an older commit is stale; the next approval on the head will run.
  if (review.commit_id !== pr.head.sha) return skip("approval_not_on_head");

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: Pre-merge review PR #${pr.number}`,
    action: "approval_review",
    reactionPath: `issues/${pr.number}`,
    reviewedCommit: { sha: review.commit_id, preMerge: true },
    buildPrompt: reviewPromptFor(env, repo, pr, true),
  });
}

export async function handlePullRequestOpened(
  env: Env,
  log: Logger,
  payload: PullRequestOpenedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository: repo, sender } = payload;

  if (pr.draft) {
    log.debug("handler.draft_pr_skipped", { trace_id: traceId, pull_number: pr.number });
    return { outcome: "skipped", skip_reason: "draft_pr" };
  }

  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: Review PR #${pr.number}`,
    action: "auto_review",
    reactionPath: `issues/${pr.number}`,
    reviewedCommit: { sha: pr.head.sha, preMerge: false },
    buildPrompt: reviewPromptFor(env, repo, pr, false),
  });
}

export async function handleIssueComment(
  env: Env,
  log: Logger,
  payload: IssueCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { issue, comment, repository: repo, sender } = payload;

  if (!issue.pull_request) {
    log.debug("handler.not_a_pr", { trace_id: traceId, issue_number: issue.number });
    return { outcome: "skipped", skip_reason: "not_a_pr" };
  }

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      issue_number: issue.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (isBotLogin(sender.login, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const inlineFlags = parseInlinePromptFlags(
    stripBotMention(comment.body, env.GITHUB_BOT_USERNAME)
  );
  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: issue.number,
    title: `GitHub: PR #${issue.number} comment`,
    action: "comment",
    reactionPath: `issues/comments/${comment.id}`,
    inlineFlags,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: issue.number,
        title: issue.title,
        commentBody: inlineFlags.ok ? inlineFlags.text : "",
        commenter: sender.login,
        isPublic: !repo.private,
        commentActionInstructions: config.commentActionInstructions,
        commentOnlyReviews: config.commentOnlyReviews,
      }),
  });
}

export async function handleReviewComment(
  env: Env,
  log: Logger,
  payload: ReviewCommentPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, comment, repository: repo, sender } = payload;

  if (!containsBotMention(comment.body, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.no_mention", {
      trace_id: traceId,
      pull_number: pr.number,
      sender: sender.login,
    });
    return { outcome: "skipped", skip_reason: "no_mention" };
  }

  if (isBotLogin(sender.login, env.GITHUB_BOT_USERNAME)) {
    log.debug("handler.self_comment_ignored", { trace_id: traceId });
    return { outcome: "skipped", skip_reason: "self_comment" };
  }

  const inlineFlags = parseInlinePromptFlags(
    stripBotMention(comment.body, env.GITHUB_BOT_USERNAME)
  );
  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber: pr.number,
    title: `GitHub: PR #${pr.number} review comment`,
    action: "review_comment",
    reactionPath: `pulls/comments/${comment.id}`,
    inlineFlags,
    buildPrompt: (config) =>
      buildCommentActionPrompt({
        owner: repo.owner.login,
        repo: repo.name,
        number: pr.number,
        title: pr.title,
        base: pr.base.ref,
        head: pr.head.ref,
        commentBody: inlineFlags.ok ? inlineFlags.text : "",
        commenter: sender.login,
        isPublic: !repo.private,
        filePath: comment.path,
        diffHunk: comment.diff_hunk,
        commentId: comment.in_reply_to_id ?? comment.id,
        commentActionInstructions: config.commentActionInstructions,
        commentOnlyReviews: config.commentOnlyReviews,
      }),
  });
}
