import type {
  CheckRunPayload,
  CheckSuitePayload,
  Env,
  PullRequestOpenedPayload,
  ReviewRequestedPayload,
  IssueCommentPayload,
  ReviewCommentPayload,
} from "./types";
import type { Logger } from "./logger";
import { buildCodeReviewPrompt, buildCommentActionPrompt, type ReviewerContext } from "./prompts";
import type { ResolvedGitHubConfig } from "./utils/integration-config";
import { requestedReviewerPayloadSchema } from "./payload-schemas";
import {
  containsBotMention,
  isBotLogin,
  stripBotMention,
} from "@open-inspect/shared/github-mention";
import { parseInlinePromptFlags } from "@open-inspect/shared/inline-prompt-flags";
import { startSession, type HandlerResult } from "./session-startup";
import {
  AI_REVIEW_CHECK_NAME,
  pullNumberFromReviewCheck,
  REVIEW_ACTION_IDENTIFIER,
} from "@open-inspect/shared/types/github-review-gate";
import { getPullRequest } from "./github-auth";
import { findSuiteReviewRun } from "./github-checks";
import { mergeGateEnabled, repositoryClient, startOpeningReview } from "./review-gate";
import { handleOverrideComment, parseOverrideCommand } from "./review-gate-override";

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
      // Every review feeds the AI Review check where the merge gate is on.
      reportVerdict: config.mergeGate !== "off",
    });
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
    gatedHeadSha: pr.head.sha,
    buildPrompt: reviewPromptFor(env, repo, pr, false),
  });
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
  const { check_run: run, repository, sender } = payload;
  if (run.name !== AI_REVIEW_CHECK_NAME || String(run.app.id) !== env.GITHUB_APP_ID) {
    return { outcome: "skipped", skip_reason: "not_ai_review_check" };
  }
  if (
    payload.action === "requested_action" &&
    payload.requested_action?.identifier !== REVIEW_ACTION_IDENTIFIER
  ) {
    return { outcome: "skipped", skip_reason: "unsupported_check_action" };
  }
  // GitHub's own `pull_requests` list is empty for forks and stale heads; the bot's
  // `external_id` always names the pull request.
  const pullNumber = pullNumberFromReviewCheck(run.external_id);
  if (pullNumber === null) {
    return { outcome: "skipped", skip_reason: "check_without_pull_request" };
  }
  const target = { repository, sender, pullNumber, headSha: run.head_sha };
  return rerunReview(env, log, traceId, target);
}

/** "Re-run all checks" on a suite of this App's checks that holds the AI Review run. */
export async function handleCheckSuiteRerequested(
  env: Env,
  log: Logger,
  payload: CheckSuitePayload,
  traceId: string
): Promise<HandlerResult> {
  const { check_suite: suite, repository, sender } = payload;
  if (String(suite.app.id) !== env.GITHUB_APP_ID) {
    return { outcome: "skipped", skip_reason: "not_ai_review_check" };
  }
  if (!(await mergeGateEnabled(env, log, repository))) {
    return { outcome: "skipped", skip_reason: "merge_gate_off" };
  }
  const run = await findSuiteReviewRun(await repositoryClient(env, repository), suite.id);
  if (run === null) throw new Error(`Check suite ${suite.id} unreadable`);
  const pullNumber = pullNumberFromReviewCheck(run.externalId);
  if (pullNumber === null) {
    return { outcome: "skipped", skip_reason: "check_without_pull_request" };
  }
  const target = { repository, sender, pullNumber, headSha: suite.head_sha };
  return rerunReview(env, log, traceId, target);
}

async function rerunReview(
  env: Env,
  log: Logger,
  traceId: string,
  target: {
    repository: CheckRunPayload["repository"];
    sender: CheckRunPayload["sender"];
    pullNumber: number;
    headSha: string;
  }
): Promise<HandlerResult> {
  const { repository: repo, sender, pullNumber, headSha } = target;
  if (!(await mergeGateEnabled(env, log, repo))) {
    return { outcome: "skipped", skip_reason: "merge_gate_off" };
  }
  // The click may come long after the check was posted; the prompt is written for the
  // pull request as it is now, and the control plane refuses a head that has moved on.
  const client = await repositoryClient(env, repo);
  const pr = await getPullRequest(
    client.token,
    `${client.repoUrl}/pulls/${pullNumber}`,
    client.userAgent
  );
  if (pr === null) throw new Error(`Pull request #${pullNumber} unreadable`);
  if (pr.state !== "open") return { outcome: "skipped", skip_reason: "pr_not_open" };
  if (pr.draft) return { outcome: "skipped", skip_reason: "draft_pr" };
  if (pr.head.sha !== headSha) {
    log.debug("handler.check_not_on_head", { trace_id: traceId, pull_number: pullNumber });
    return { outcome: "skipped", skip_reason: "check_not_on_head" };
  }

  // A suite re-run and a run re-run of one click, or two clicks, start one review: the
  // control plane admits one attempt per head.
  return startSession(env, log, traceId, {
    repository: repo,
    sender,
    pullNumber,
    title: `GitHub: Review PR #${pullNumber}`,
    action: "review",
    reactionPath: `issues/${pullNumber}`,
    gatedHeadSha: headSha,
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

  // Leaving draft starts a review only for the merge gate, which needs one on the head.
  if (payload.action === "ready_for_review" && !(await mergeGateEnabled(env, log, repo))) {
    return { outcome: "skipped", skip_reason: "merge_gate_off" };
  }

  return startOpeningReview(
    env,
    log,
    traceId,
    { repository: repo, pullNumber: pr.number, headSha: pr.head.sha },
    () =>
      startSession(env, log, traceId, {
        repository: repo,
        sender,
        pullNumber: pr.number,
        title: `GitHub: Review PR #${pr.number}`,
        action: "auto_review",
        reactionPath: `issues/${pr.number}`,
        gatedHeadSha: pr.head.sha,
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

  // An override is a command to the merge gate, never a prompt; where the gate is off
  // the comment is an ordinary mention.
  const command = parseOverrideCommand(comment.body, env.GITHUB_BOT_USERNAME);
  if (command) {
    const overridden = await handleOverrideComment(env, log, traceId, {
      repository: repo,
      pullNumber: issue.number,
      commentId: comment.id,
      sender,
      command,
    });
    if (overridden !== null) return overridden;
  }

  const text = stripBotMention(comment.body, env.GITHUB_BOT_USERNAME);
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
