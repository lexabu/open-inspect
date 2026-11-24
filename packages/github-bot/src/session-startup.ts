import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env, ReviewRequestedPayload } from "./types";
import type { Logger } from "./logger";
import {
  generateInstallationToken,
  postReaction,
  postIssueComment,
  checkSenderPermission,
} from "./github-auth";
import { commitReviewClaim } from "./commit-review-gate";
import { resolveSessionTarget } from "./session-target";
import { createSession, sendPrompt } from "./session-client";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";
import { resolveModelSelection, type ModelSelection } from "./model-selection";
import type { ReviewerContext } from "./prompts";
import { getModelDisplayName } from "@open-inspect/shared/models";
import type { ParseInlinePromptFlagsResult } from "@open-inspect/shared/inline-prompt-flags";

/** One started session; a multi-reviewer review starts one per reviewer. */
interface LaunchedSession {
  session_id: string;
  message_id: string;
  model: string;
}

export type HandlerResult =
  | { outcome: "processed"; sessions: LaunchedSession[]; handler_action: string }
  | { outcome: "skipped"; skip_reason: string };

type SessionAction = "review" | "auto_review" | "approval_review" | "comment" | "review_comment";

const githubRouteResponseSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("workspace"), teamId: z.null() }),
  z.object({ via: z.literal("sender_membership"), teamId: z.string().min(1) }),
  z.object({ via: z.literal("pull_request_session"), teamId: z.string().min(1).nullable() }),
]);

async function resolveGitHubRoute(
  env: Env,
  log: Logger,
  traceId: string,
  params: { repositoryId: number; pullNumber: number; senderId: number }
): Promise<z.infer<typeof githubRouteResponseSchema>> {
  const query = new URLSearchParams({
    repositoryId: String(params.repositoryId),
    pullNumber: String(params.pullNumber),
    sender: `github:${params.senderId}`,
  });
  try {
    const url = `https://internal/github/route?${query}`;
    const response = await signedControlPlaneFetch(env, { method: "GET", url, traceId });
    if (!response.ok) {
      throw new Error(`GitHub routing lookup failed: ${response.status}`);
    }
    const parsed = githubRouteResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("GitHub routing lookup failed: invalid response");
    }
    return parsed.data;
  } catch (err) {
    log.warn("route.lookup_failed", {
      trace_id: traceId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }
}

async function withReaction<T>(
  log: Logger,
  token: string,
  url: string,
  userAgent: string,
  meta: Record<string, unknown>,
  action: () => Promise<T>
): Promise<T> {
  const reaction = postReaction(token, url, "eyes", userAgent).then(
    (ok) => {
      if (ok) log.debug("acknowledgment.posted", meta);
      else log.warn("acknowledgment.failed", meta);
    },
    () => log.warn("acknowledgment.failed", meta)
  );
  try {
    return await action();
  } finally {
    await reaction;
  }
}

type CallerGatingResult =
  | { allowed: true; ghToken: string }
  | {
      allowed: false;
      reason: "sender_not_allowed" | "sender_insufficient_permission" | "permission_check_failed";
    };

async function resolveCallerGating(
  env: Env,
  config: ResolvedGitHubConfig,
  senderLogin: string,
  owner: string,
  repoName: string,
  log: Logger,
  traceId: string,
  repoFullName: string
): Promise<CallerGatingResult> {
  // The allowlist gates first; routed-team membership is rechecked on session creation.
  if (config.allowedTriggerUsers !== null) {
    if (!config.allowedTriggerUsers.some((u) => u.toLowerCase() === senderLogin.toLowerCase())) {
      log.info("handler.sender_not_allowed", { trace_id: traceId, sender: senderLogin });
      return { allowed: false, reason: "sender_not_allowed" };
    }
  }

  const userAgent = resolveAppName(env);
  const ghToken = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });

  if (config.allowedTriggerUsers === null) {
    const { hasPermission, error } = await checkSenderPermission(
      ghToken,
      owner,
      repoName,
      senderLogin,
      userAgent
    );
    if (!hasPermission) {
      const reason = error ? "permission_check_failed" : "sender_insufficient_permission";
      log.info(
        error ? "handler.permission_check_failed" : "handler.sender_insufficient_permission",
        {
          trace_id: traceId,
          sender: senderLogin,
          repo: repoFullName,
        }
      );
      return { allowed: false, reason };
    }
  }

  return { allowed: true, ghToken };
}

export async function startSession(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    repository: ReviewRequestedPayload["repository"];
    sender: ReviewRequestedPayload["sender"];
    pullNumber: number;
    title: string;
    action: SessionAction;
    reactionPath: string;
    /** `!model` / `!reasoning` flags parsed from the triggering comment, if any. */
    inlineFlags?: ParseInlinePromptFlagsResult;
    /**
     * The commit a review runs on, claimed while it runs. A pre-merge review skips a
     * commit that is claimed, already reviewed by the bot, or no longer the live head.
     */
    reviewedCommit?: { sha: string; preMerge: boolean };
    buildPrompt: (config: ResolvedGitHubConfig, reviewer: ReviewerContext | null) => string;
  }
): Promise<HandlerResult> {
  const { repository: repo, sender, pullNumber, action } = params;
  const owner = repo.owner.login;
  const repoName = repo.name;
  const repoFullName = `${owner}/${repoName}`.toLowerCase();
  const config = await getGitHubConfig(env, repoFullName, log);

  if (config.enabledRepos !== null && !config.enabledRepos.includes(repoFullName)) {
    log.debug("handler.repo_not_enabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "repo_not_enabled" };
  }
  if (action === "auto_review" && !config.autoReviewOnOpen) {
    log.debug("handler.auto_review_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "auto_review_disabled" };
  }
  if (action === "approval_review" && !config.reviewOnApproval) {
    log.debug("handler.review_on_approval_disabled", { trace_id: traceId, repo: repoFullName });
    return { outcome: "skipped", skip_reason: "review_on_approval_disabled" };
  }

  const gating = await resolveCallerGating(
    env,
    config,
    sender.login,
    owner,
    repoName,
    log,
    traceId,
    repoFullName
  );
  if (!gating.allowed) return { outcome: "skipped", skip_reason: gating.reason };
  const { ghToken } = gating;
  const repositoryPath = encodeRepositoryPathSegments({ repoOwner: owner, repoName });
  const userAgent = resolveAppName(env);
  const meta = { trace_id: traceId, repo: repoFullName, pull_number: pullNumber };

  const claim = params.reviewedCommit
    ? commitReviewClaim(
        env,
        log,
        {
          token: ghToken,
          userAgent,
          pullUrl: `https://api.github.com/repos/${repositoryPath}/pulls/${pullNumber}`,
        },
        meta,
        params.reviewedCommit.sha
      )
    : null;
  if (claim && params.reviewedCommit?.preMerge) {
    const skipReason = await claim.checkPreMerge();
    if (skipReason !== null) {
      log.info("handler.pre_merge_review_skipped", { ...meta, skip_reason: skipReason });
      return { outcome: "skipped", skip_reason: skipReason };
    }
  }

  const commentsUrl = `https://api.github.com/repos/${repositoryPath}/issues/${pullNumber}/comments`;
  const postRequiredComment = async (body: string, code: string): Promise<void> => {
    if (await postIssueComment(ghToken, commentsUrl, body, userAgent)) return;
    log.warn("session.refusal_comment_failed", { ...meta, code });
    throw new Error(`Session refusal comment failed: ${code}`);
  };

  const selections: ModelSelection[] = [];
  let inlineModelOverride = false;
  for (const requested of requestedSelections(action, config)) {
    const modelSelection = await resolveModelSelection(
      env,
      log,
      traceId,
      requested,
      params.inlineFlags
    );
    if (!modelSelection.ok) {
      await postRequiredComment(modelSelection.message, modelSelection.reason);
      log.info("handler.inline_flags_rejected", { ...meta, reason: modelSelection.reason });
      return { outcome: "skipped", skip_reason: modelSelection.reason };
    }
    inlineModelOverride ||= modelSelection.overridden;
    selections.push(modelSelection.selection);
  }
  const reviewerCount = selections.length;

  await claim?.claim();
  let result: HandlerResult;
  try {
    result = await launchSessions();
  } catch (error) {
    await claim?.release();
    throw error;
  }
  if (result.outcome === "skipped") await claim?.release();
  return result;

  function launchSessions(): Promise<HandlerResult> {
    return withReaction(
      log,
      ghToken,
      `https://api.github.com/repos/${repositoryPath}/${params.reactionPath}/reactions`,
      userAgent,
      meta,
      async () => {
        // Deprecated auto-review is always workspace-level and never needs a route lookup.
        // The pre-merge review routes like a review request, so it follows the PR's session.
        const teamId =
          action === "auto_review"
            ? null
            : (
                await resolveGitHubRoute(env, log, traceId, {
                  repositoryId: repo.id,
                  pullNumber,
                  senderId: sender.id,
                })
              ).teamId;
        const target = await resolveSessionTarget(env, log, {
          owner,
          repoName,
          teamId,
          senderId: sender.id,
          senderLogin: sender.login,
          config,
          ghToken,
          traceId,
        });

        const launch = async (selection: ModelSelection): Promise<LaunchOutcome> => {
          const modelName = getModelDisplayName(selection.model);
          const creation = await createSession(env, traceId, {
            target,
            teamId,
            title: reviewerCount > 1 ? `${params.title} (${modelName})` : params.title,
            model: selection.model,
            harness: selection.harness,
            reasoningEffort: selection.reasoningEffort,
            scmLogin: sender.login,
            scmUserId: String(sender.id),
            scmAvatarUrl: sender.avatar_url,
          });
          if (!creation.ok) {
            const { status, code, body } = creation;
            if (isRefusal(status, code)) return { kind: "refused", code };
            throw new Error(`Session creation failed: ${status} ${body}`);
          }
          const { sessionId } = creation;
          log.info("session.created", {
            ...meta,
            session_id: sessionId,
            action,
            model: selection.model,
            harness: selection.harness,
            reasoning_effort: selection.reasoningEffort,
            inline_model_override: inlineModelOverride,
            reviewer_count: reviewerCount,
          });

          const prompt = params.buildPrompt(
            config,
            reviewerCount > 1 ? { modelName, reviewerCount } : null
          );
          const messageId = await sendPrompt(env, traceId, sessionId, {
            content: prompt,
            authorId: `github:${sender.id}`,
          }).catch((error: unknown) => {
            // The session exists but got no prompt; name it so it can be found and archived.
            log.error("session.prompt_failed", {
              ...meta,
              session_id: sessionId,
              model: selection.model,
            });
            throw error;
          });
          log.info("prompt.sent", {
            ...meta,
            session_id: sessionId,
            message_id: messageId,
            source: "github",
            content_length: prompt.length,
          });
          return {
            kind: "launched",
            session: { session_id: sessionId, message_id: messageId, model: selection.model },
          };
        };

        const outcomes = await Promise.allSettled(selections.map(launch));
        const sessions: LaunchedSession[] = [];
        const failedModels: string[] = [];
        let refusal: RefusalCode | null = null;
        let firstError: unknown = null;
        for (const [index, outcome] of outcomes.entries()) {
          const { model } = selections[index];
          if (outcome.status === "rejected") {
            failedModels.push(model);
            firstError ??= outcome.reason;
            log.error("session.reviewer_launch_failed", {
              ...meta,
              model,
              error:
                outcome.reason instanceof Error
                  ? outcome.reason
                  : new Error(String(outcome.reason)),
            });
          } else if (outcome.value.kind === "refused") {
            failedModels.push(model);
            refusal ??= outcome.value.code;
          } else {
            sessions.push(outcome.value.session);
          }
        }

        if (sessions.length === 0) {
          if (refusal) {
            // A PR comment must not disclose secondary repositories from the environment.
            await postRequiredComment(refusalComment(refusal, `${owner}/${repoName}`), refusal);
            return { outcome: "skipped", skip_reason: refusal };
          }
          throw firstError instanceof Error ? firstError : new Error(String(firstError));
        }
        if (failedModels.length > 0) {
          // Some reviewers started; say which did not so the PR never looks fully reviewed.
          // Best effort: throwing here would make a redelivery restart the reviewers that ran.
          const names = failedModels.map((model) => `\`${getModelDisplayName(model)}\``).join(", ");
          const posted = await postIssueComment(
            ghToken,
            commentsUrl,
            `I couldn't start the ${names} review, so ${sessions.length} of ${reviewerCount} reviews started. Request a review again to retry.`,
            userAgent
          );
          if (!posted) {
            log.error("session.reviewer_failure_notice_failed", {
              ...meta,
              failed_models: failedModels,
            });
          }
        }
        return { outcome: "processed", sessions, handler_action: action };
      }
    );
  }
}

type RefusalCode = "not_member" | "target_team_missing_grant" | "team_archived";

type LaunchOutcome =
  { kind: "launched"; session: LaunchedSession } | { kind: "refused"; code: RefusalCode };

function isRefusal(status: number, code: string | undefined): code is RefusalCode {
  return (
    (status === 403 && code === "not_member") ||
    (status === 409 && (code === "target_team_missing_grant" || code === "team_archived"))
  );
}

function refusalComment(code: RefusalCode, triggerRepo: string): string {
  return {
    not_member:
      "I couldn't start a session because you are not a member of the target team. Ask a team lead to add you, then try again.",
    target_team_missing_grant: `I couldn't start a session because the target team is missing a required repository grant to work on \`${triggerRepo}\`. Ask a team lead or workspace administrator to review the team's repository and environment grants, then try again.`,
    team_archived:
      "I couldn't start a session because the target team is archived. Ask a workspace administrator to restore the team, then try again.",
  }[code];
}

/**
 * The model selections a trigger starts sessions for: every configured reviewer
 * for a review request, auto-review or pre-merge review, otherwise the single
 * configured selection.
 */
function requestedSelections(
  action: SessionAction,
  config: ResolvedGitHubConfig
): ModelSelection[] {
  if (
    (action === "review" || action === "auto_review" || action === "approval_review") &&
    config.reviewers
  ) {
    return config.reviewers.map((reviewer) => ({
      model: reviewer.model,
      harness: reviewer.harness,
      reasoningEffort: reviewer.reasoningEffort ?? null,
    }));
  }
  return [
    { model: config.model, harness: config.harness, reasoningEffort: config.reasoningEffort },
  ];
}
