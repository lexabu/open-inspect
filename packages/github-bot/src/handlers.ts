import type {
  CheckRunPayload,
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { buildCodeReviewPrompt, buildCommentActionPrompt, type ReviewerContext } from "./prompts";
import type { ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema, reviewAuthorPayloadSchema } from "./payload-schemas";
import {
  containsBotMention,
  isBotLogin,
  stripBotMention,
} from "@open-inspect/shared/github-mention";
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";
import { startSession, type HandlerResult } from "./session-startup";
import {
  handleOverrideComment,
  mergeGateEnabled,
  parseOverrideCommand,
  readRerunTarget,
  startCheckedReview,
} from "./ai-review-check";
import { AI_REVIEW_CHECK_NAME, REVIEW_ACTION_IDENTIFIER } from "./github-checks";

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
  repo: Pick<ReviewRequestedPayload["repository"], "owner" | "name" | "private">,
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

/** Whether a submitted review is the bot's own; other reviews are not parsed further. */
export function isReviewByBot(payload: unknown, botUsername: string): boolean {
  const parsed = reviewAuthorPayloadSchema.safeParse(payload);
  return parsed.success && isBotLogin(parsed.data.review?.user?.login, botUsername);
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

  return startCheckedReview(
    env,
    log,
    traceId,
    { repository: repo, pullNumber: pr.number, headSha: pr.head.sha },
    "keep",
    () =>
      startSession(env, log, traceId, {
        repository: repo,
        sender,
        pullNumber: pr.number,
        title: `GitHub: Review PR #${pr.number}`,
        action: "review",
        reactionPath: `issues/${pr.number}`,
        buildPrompt: reviewPromptFor(env, repo, pr, false),
      })
  );
}

/**
 * The Re-run button or the "Review now" button on the AI Review check: review the
 * check's commit for whoever clicked, if it is still the pull request's head.
 */
export async function handleCheckRunReviewRequested(
  env: Env,
  log: Logger,
  payload: CheckRunPayload,
  traceId: string
): Promise<HandlerResult> {
  const { check_run: run, repository: repo, sender } = payload;
  if (run.name !== AI_REVIEW_CHECK_NAME || String(run.app.id) !== env.GITHUB_APP_ID) {
    return { outcome: "skipped", skip_reason: "not_ai_review_check" };
  }
  if (
    payload.action === "requested_action" &&
    payload.requested_action?.identifier !== REVIEW_ACTION_IDENTIFIER
  ) {
    return { outcome: "skipped", skip_reason: "unsupported_check_action" };
  }
  const pullNumber = run.pull_requests[0]?.number;
  if (pullNumber === undefined) {
    return { outcome: "skipped", skip_reason: "check_without_pull_request" };
  }

  // The click may come long after the check was posted; act on the live pull request.
  const target = await readRerunTarget(env, log, repo, pullNumber);
  if (target === null) return { outcome: "skipped", skip_reason: "merge_gate_off" };
  const { pr, reviewRunning } = target;
  if (pr.state !== "open") return { outcome: "skipped", skip_reason: "pr_not_open" };
  if (pr.head.sha !== run.head_sha) {
    log.debug("handler.check_not_on_head", { trace_id: traceId, pull_number: pullNumber });
    return { outcome: "skipped", skip_reason: "check_not_on_head" };
  }
  // A second click must not start a second set of reviewers.
  if (reviewRunning) return { outcome: "skipped", skip_reason: "review_in_progress" };

  return startCheckedReview(
    env,
    log,
    traceId,
    { repository: repo, pullNumber, headSha: run.head_sha },
    "keep",
    () =>
      startSession(env, log, traceId, {
        repository: repo,
        sender,
        pullNumber,
        title: `GitHub: Review PR #${pullNumber}`,
        action: "review",
        reactionPath: `issues/${pullNumber}`,
        buildPrompt: reviewPromptFor(env, repo, pr, true),
      })
  );
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

  // Leaving draft starts a review only for the merge gate, which needs one on the head.
  if (payload.action === "ready_for_review" && !(await mergeGateEnabled(env, log, repo))) {
    return { outcome: "skipped", skip_reason: "merge_gate_off" };
  }

  return startCheckedReview(
    env,
    log,
    traceId,
    { repository: repo, pullNumber: pr.number, headSha: pr.head.sha },
    "needs_review",
    () =>
      startSession(env, log, traceId, {
        repository: repo,
        sender,
        pullNumber: pr.number,
        title: `GitHub: Review PR #${pr.number}`,
        action: "auto_review",
        reactionPath: `issues/${pr.number}`,
        buildPrompt: reviewPromptFor(env, repo, pr, false),
      })
  );
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

  const text = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);
  // An override is a command to the merge gate, never a prompt for a session.
  const override = parseOverrideCommand(text);
  if (override) {
    return handleOverrideComment(env, log, traceId, {
      repository: repo,
      pullNumber: issue.number,
      commentId: comment.id,
      sender,
      reason: override.reason,
    });
  }

  const inlineFlags = parseInlinePromptFlags(text);
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
