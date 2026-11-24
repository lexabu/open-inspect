/**
 * State and shared pieces of the `AI Review` merge gate: the gate for a repository, the
 * records it keeps in KV, and the check states it posts.
 */
import { resolveAppName } from "@open-inspect/shared/app-name";
import { createKvCacheStore, type CacheStore } from "@open-inspect/shared/cache-store";
import { botHandle } from "@open-inspect/shared/github-mention";
import type { GitHubMergeGate } from "@open-inspect/shared/types/integrations";
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { z } from "zod";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { generateInstallationToken, getPullRequest, type LivePullRequest } from "./github-auth";
import {
  createCheckRun,
  listOpenPullsWithHead,
  type CheckConclusion,
  type CheckRunState,
  type GitHubRepoClient,
} from "./github-checks";
import type { HandlerResult } from "./session-startup";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";

/** A review that has not posted after this long is taken to have died. */
export const STUCK_REVIEW_MS = 30 * 60 * 1000;
const VERDICT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Repository = { owner: { login: string }; name: string };

export interface Gate {
  mode: Exclude<GitHubMergeGate, "off">;
  config: ResolvedGitHubConfig;
  client: GitHubRepoClient;
  store: CacheStore;
  /** `owner/repo`, lower-cased: the KV key prefix. */
  repo: string;
}

function repoFullName(repository: Repository): string {
  return `${repository.owner.login}/${repository.name}`.toLowerCase();
}

export async function mergeGateEnabled(
  env: Env,
  log: Logger,
  repository: Repository
): Promise<boolean> {
  const repo = repoFullName(repository);
  const config = await getGitHubConfig(env, repo, log);
  return config.mergeGate !== "off" && (config.enabledRepos?.includes(repo) ?? true);
}

/** The gate for a repository, or null where it is off. */
export async function openGate(
  env: Env,
  log: Logger,
  repository: Repository
): Promise<Gate | null> {
  const repo = repoFullName(repository);
  const config = await getGitHubConfig(env, repo, log);
  if (config.mergeGate === "off") return null;
  if (config.enabledRepos !== null && !config.enabledRepos.includes(repo)) return null;

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
  return {
    mode: config.mergeGate,
    config,
    client: { token, userAgent, repoUrl: `https://api.github.com/repos/${path}` },
    store: createKvCacheStore(env.GITHUB_KV),
    repo,
  };
}

/**
 * One review of one head commit of one pull request, written before its sessions start.
 * Only reviews that carry this attempt's markers conclude its check, so a review the bot
 * posts for any other reason (a comment request, another pull request on the same
 * commit, an earlier attempt) never counts.
 */
const attemptSchema = z.object({
  id: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
  baseSha: z.string(),
  baseRef: z.string(),
  startedAt: z.string(),
  /** Every configured reviewer. `key` is secret until that reviewer's session posts. */
  reviewers: z.array(
    z.object({
      key: z.string(),
      model: z.string(),
      /**
       * The reviewer's review and its verdict as first seen; null until it posts. A
       * review body can be edited after posting, so the verdict is never read again.
       */
      seen: z.object({ reviewId: z.number(), approve: z.boolean(), url: z.string() }).nullable(),
    })
  ),
  /** Null until the check run exists; sessions are started first. */
  checkRunId: z.number().nullable(),
  /** Hash of the diff the reviewers were given; null when GitHub could not produce it. */
  diffHash: z.string().nullable(),
  /** Set once the check has a conclusion. A later review or dismissal concludes it again. */
  concludedAt: z.string().nullable(),
});
export type ReviewAttempt = z.infer<typeof attemptSchema>;

/** The last verdict on a pull request, kept so a head with the same diff carries it forward. */
const verdictSchema = z.object({
  /** The head commit the verdict applies to. */
  sha: z.string(),
  /** The commit the bot reviewed, or a human overrode; differs from `sha` once carried forward. */
  reviewedSha: z.string(),
  /** The base branch and commit the verdict was reached against. */
  baseRef: z.string(),
  baseSha: z.string(),
  diffHash: z.string().nullable(),
  approved: z.boolean(),
  summary: z.string(),
  /** The attempt whose reviews gave the verdict; null for a human override. */
  attemptId: z.string().nullable(),
});
export type Verdict = z.infer<typeof verdictSchema>;

const attemptKey = (repo: string, pullNumber: number) => `ai-review:attempt:${repo}#${pullNumber}`;
const verdictKey = (gate: Gate, pullNumber: number) =>
  `ai-review:verdict:${gate.repo}#${pullNumber}`;

/** The attempt record of a pull request, readable before the gate is opened. */
export async function readAttemptRecord(
  env: Env,
  repository: Repository,
  pullNumber: number
): Promise<ReviewAttempt | null> {
  const store = createKvCacheStore(env.GITHUB_KV);
  const key = attemptKey(repoFullName(repository), pullNumber);
  const parsed = attemptSchema.safeParse(await store.get(key, "json"));
  return parsed.success ? parsed.data : null;
}

export async function deleteAttemptRecord(
  env: Env,
  repository: Repository,
  pullNumber: number
): Promise<void> {
  await createKvCacheStore(env.GITHUB_KV).delete(attemptKey(repoFullName(repository), pullNumber));
}

export async function readAttempt(gate: Gate, pullNumber: number): Promise<ReviewAttempt | null> {
  const parsed = attemptSchema.safeParse(
    await gate.store.get(attemptKey(gate.repo, pullNumber), "json")
  );
  return parsed.success ? parsed.data : null;
}

export function writeAttempt(gate: Gate, attempt: ReviewAttempt): Promise<void> {
  return gate.store.put(attemptKey(gate.repo, attempt.prNumber), JSON.stringify(attempt), {
    ttlMs: ATTEMPT_TTL_MS,
  });
}

export function deleteAttempt(gate: Gate, pullNumber: number): Promise<void> {
  return gate.store.delete(attemptKey(gate.repo, pullNumber));
}

/** Whether an attempt's sessions may still be working: not concluded, and not yet stuck. */
export function isRunning(attempt: ReviewAttempt): boolean {
  return (
    attempt.concludedAt === null && Date.now() - Date.parse(attempt.startedAt) <= STUCK_REVIEW_MS
  );
}

export async function readVerdict(gate: Gate, pullNumber: number): Promise<Verdict | null> {
  const parsed = verdictSchema.safeParse(
    await gate.store.get(verdictKey(gate, pullNumber), "json")
  );
  return parsed.success ? parsed.data : null;
}

export function writeVerdict(gate: Gate, pullNumber: number, verdict: Verdict): Promise<void> {
  return gate.store.put(verdictKey(gate, pullNumber), JSON.stringify(verdict), {
    ttlMs: VERDICT_TTL_MS,
  });
}

export function deleteVerdict(gate: Gate, pullNumber: number): Promise<void> {
  return gate.store.delete(verdictKey(gate, pullNumber));
}

/** The hidden line a reviewer session must put in its review body. */
export function reviewMarker(attemptId: string, reviewerKey: string): string {
  return `<!-- open-inspect:review attempt=${attemptId} reviewer=${reviewerKey} -->`;
}

/** A check run's `external_id`: its pull request and, for a review, the attempt. */
export function checkExternalId(pullNumber: number, attemptId?: string): string {
  const pull = `open-inspect:pr=${pullNumber}`;
  return attemptId ? `${pull};attempt=${attemptId}` : pull;
}

/** The pull request a check run names in its `external_id`, or null when it names none. */
export function pullNumberFromExternalId(externalId: string | null | undefined): number | null {
  const match = /^open-inspect:pr=(\d+)(?:;attempt=[0-9a-f-]+)?$/.exec(externalId ?? "");
  return match ? Number(match[1]) : null;
}

export const short = (sha: string) => sha.slice(0, 7);

export const processed = (handler_action: string): HandlerResult => ({
  outcome: "processed",
  sessions: [],
  handler_action,
});
export const skipped = (skip_reason: string): HandlerResult => ({
  outcome: "skipped",
  skip_reason,
});

export function verdictConclusion(gate: Gate, approved: boolean): CheckConclusion {
  if (approved) return "success";
  return gate.mode === "required" ? "failure" : "neutral";
}

export function modeNote(gate: Gate): string {
  return gate.mode === "shadow"
    ? "\n\nShadow mode: this check reports the verdict and never blocks merging."
    : "";
}

/** The check for a head commit no review covers: it asks for one instead of failing. */
export function needsReviewState(gate: Gate, headSha: string, why: string): CheckRunState {
  return {
    status: "completed",
    conclusion: gate.mode === "required" ? "action_required" : "neutral",
    output: {
      title: "Re-run the AI review before merging",
      summary: `${why} Click **Review now**, or re-run this check, when commit \`${short(headSha)}\` is ready to merge.${modeNote(gate)}`,
    },
    reviewAction: true,
  };
}

/** The check a head gets when a verdict reached on an earlier commit still covers its diff. */
export function carriedState(gate: Gate, verdict: Verdict): CheckRunState {
  return {
    status: "completed",
    conclusion: verdictConclusion(gate, verdict.approved),
    output: {
      title: verdict.approved ? "Approved (carried forward)" : "Not approved (carried forward)",
      summary: `Carried forward from commit \`${short(verdict.reviewedSha)}\`: the pull request's own diff is unchanged.\n\n${verdict.summary}${modeNote(gate)}`,
    },
    reviewAction: !verdict.approved,
  };
}

/** Posts a new check run on a commit; it replaces any earlier AI Review run there. */
export async function postCheck(
  gate: Gate,
  pullNumber: number,
  headSha: string,
  state: CheckRunState
): Promise<void> {
  const run = {
    headSha,
    startedAt: new Date().toISOString(),
    externalId: checkExternalId(pullNumber),
  };
  if ((await createCheckRun(gate.client, run, state)) === null) {
    throw new Error(`AI Review check could not be written for ${headSha}`);
  }
}

export async function readPullRequest(gate: Gate, pullNumber: number): Promise<LivePullRequest> {
  const pr = await getPullRequest(
    gate.client.token,
    `${gate.client.repoUrl}/pulls/${pullNumber}`,
    gate.client.userAgent
  );
  if (pr === null) throw new Error(`Pull request #${pullNumber} unreadable`);
  return pr;
}

export function overrideHint(env: Env): string {
  return `\`@${botHandle(env.GITHUB_BOT_USERNAME)} override <commit> <reason>\``;
}

/**
 * Why a head's check must not pass for this pull request although its verdict is
 * approve, or null when it may. A check run belongs to the commit, so a pass would also
 * show on any other open pull request with the same head.
 */
export async function sharedHeadReason(
  gate: Gate,
  pullNumber: number,
  headSha: string
): Promise<string | null> {
  const pulls = await listOpenPullsWithHead(gate.client, headSha);
  if (pulls === null) {
    return `Could not confirm that #${pullNumber} is the only open pull request on this commit.`;
  }
  const others = pulls.filter((number) => number !== pullNumber);
  return others.length === 0
    ? null
    : `Commit \`${short(headSha)}\` is also the head of ${others.map((number) => `#${number}`).join(", ")}, and a check run cannot tell pull requests on one commit apart.`;
}
