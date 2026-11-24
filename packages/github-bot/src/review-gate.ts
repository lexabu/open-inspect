/**
 * The bot's part of the `AI Review` merge gate: it tells the control plane what happened
 * to a pull request and who asked for what. The control plane holds the review attempts,
 * runs their sessions where nobody can steer them, and writes the check run.
 */
import { resolveAppName } from "@open-inspect/shared/app-name";
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import type { Env, PullRequestChangedPayload } from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken } from "./github-auth";
import { reportPullChange } from "./review-gate-client";
import type { HandlerResult } from "./session-startup";
import { getGitHubConfig } from "./utils/integration-config";

export type GateRepository = { owner: { login: string }; name: string };

/** Whether the gate is on for a repository the bot is enabled on. */
export async function mergeGateEnabled(
  env: Env,
  log: Logger,
  repository: GateRepository
): Promise<boolean> {
  const repo = `${repository.owner.login}/${repository.name}`.toLowerCase();
  const config = await getGitHubConfig(env, repo, log);
  return config.mergeGate !== "off" && (config.enabledRepos?.includes(repo) ?? true);
}

/** An installation token and the repository's REST root, for the bot's own GitHub reads. */
export async function repositoryClient(
  env: Env,
  repository: GateRepository
): Promise<{ token: string; userAgent: string; repoUrl: string }> {
  const userAgent = resolveAppName(env);
  const token = await generateInstallationToken({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
    userAgent,
  });
  const path = encodeRepositoryPathSegments({
    repoOwner: repository.owner.login,
    repoName: repository.name,
  });
  return { token, userAgent, repoUrl: `https://api.github.com/repos/${path}` };
}

/**
 * Runs a review start for a pull request that has no check yet (it was just opened, or
 * left draft). When the review does not start, the gate is told, so the head gets a
 * check that asks for one instead of none at all.
 */
export async function startOpeningReview(
  env: Env,
  log: Logger,
  traceId: string,
  target: { repository: GateRepository; pullNumber: number; headSha: string },
  start: () => Promise<HandlerResult>
): Promise<HandlerResult> {
  const { repository, pullNumber, headSha } = target;
  const reportNotStarted = async (detail: string): Promise<void> => {
    if (!(await mergeGateEnabled(env, log, repository))) return;
    await reportPullChange(env, traceId, {
      repository: { owner: repository.owner.login, name: repository.name },
      pullNumber,
      change: "review_not_started",
      headSha,
      detail,
    });
  };

  let result: HandlerResult;
  try {
    result = await start();
  } catch (error) {
    // Best effort beside the real failure, which is what the delivery reports.
    await reportNotStarted("session start failed").catch((reportError: unknown) =>
      log.error("review_gate.report_failed", {
        trace_id: traceId,
        pull_number: pullNumber,
        error: reportError instanceof Error ? reportError : new Error(String(reportError)),
      })
    );
    throw error;
  }
  // A review already running on the head has its own check.
  if (result.outcome === "skipped" && result.skip_reason !== "review_in_progress") {
    await reportNotStarted(result.skip_reason);
  }
  return result;
}

const CHANGES = { synchronize: "head", edited: "base", reopened: "reopened" } as const;

/**
 * A new head, a new base branch, or a reopened pull request: the control plane carries
 * the last verdict forward where it still covers the diff, and otherwise asks for a review.
 */
export async function handlePullRequestChanged(
  env: Env,
  log: Logger,
  payload: PullRequestChangedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository } = payload;
  if (!(await mergeGateEnabled(env, log, repository))) {
    return { outcome: "skipped", skip_reason: "merge_gate_off" };
  }
  const response = await reportPullChange(env, traceId, {
    repository: { owner: repository.owner.login, name: repository.name },
    pullNumber: pr.number,
    change: CHANGES[payload.action],
    headSha: pr.head.sha,
  });
  if (response.outcome === "skipped") return { outcome: "skipped", skip_reason: response.reason };
  return {
    outcome: "processed",
    sessions: [],
    handler_action:
      response.outcome === "carried_forward" ? "check_carried_forward" : "check_needs_review",
  };
}
