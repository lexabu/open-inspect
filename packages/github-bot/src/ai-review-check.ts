/**
 * The `AI Review` merge-gate check: one check run on a pull request's head commit that
 * says whether the bot reviewed, and approved, exactly that commit.
 *
 * A review session posts its verdict as a GitHub review; the bot's own
 * `pull_request_review` webhook concludes the check. Nothing reviews on push: a new head
 * gets a check that asks for a review, unless the pull request's own diff is unchanged,
 * in which case the last verdict carries forward.
 */
import { resolveAppName } from "@open-inspect/shared/app-name";
import { createKvCacheStore, type CacheStore } from "@open-inspect/shared/cache-store";
import { botHandle, isBotLogin } from "@open-inspect/shared/github-mention";
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import type { GitHubMergeGate } from "@open-inspect/shared/types/integrations";
import { encodeRepositoryPathSegments } from "@open-inspect/shared/types/repositories";
import { z } from "zod";
import type { Env, PullRequestSynchronizePayload, ReviewSubmittedPayload } from "./types";
import type { Logger } from "./logger";
import {
  checkSenderPermission,
  generateInstallationToken,
  getPullRequest,
  listPullRequestReviews,
  postIssueComment,
  postReaction,
  type LivePullRequest,
  type PullRequestReview,
} from "./github-auth";
import {
  createCheckRun,
  findCheckRun,
  getCompareDiff,
  updateCheckRun,
  type CheckConclusion,
  type CheckRunState,
  type ExistingCheckRun,
  type GitHubRepoClient,
} from "./github-checks";
import type { HandlerResult } from "./session-startup";
import { getGitHubConfig, type ResolvedGitHubConfig } from "./utils/integration-config";

/** A review that has not posted after this long is taken to have died. */
export const STUCK_REVIEW_MS = 30 * 60 * 1000;
const VERDICT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OVERRIDE_REASON_LENGTH = 1_000;

const NEEDS_REVIEW_TITLE = "Re-run the AI review before merging";

type Repository = { owner: { login: string }; name: string };

/** The last verdict concluded on a pull request's head, kept so an unchanged diff carries it forward. */
const verdictSchema = z.object({
  /** The head commit the verdict applies to. */
  sha: z.string(),
  /** The commit the bot reviewed, or a human overrode; differs from `sha` once carried forward. */
  reviewedSha: z.string(),
  /** Hash of the pull request's own diff at `sha`; null when GitHub could not produce the diff. */
  diffHash: z.string().nullable(),
  approved: z.boolean(),
  summary: z.string(),
  /** Login of the human who overrode the check on `reviewedSha`. */
  overriddenBy: z.string().optional(),
});
type Verdict = z.infer<typeof verdictSchema>;

/** A review in flight, so a session that dies without posting does not hold the check open. */
const pendingSchema = z.object({ sha: z.string(), startedAt: z.string() });

interface Gate {
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
async function openGate(env: Env, log: Logger, repository: Repository): Promise<Gate | null> {
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

const verdictKey = (gate: Gate, pullNumber: number) =>
  `ai-review:verdict:${gate.repo}#${pullNumber}`;
const pendingKey = (repo: string, pullNumber: number) => `ai-review:pending:${repo}#${pullNumber}`;

async function readVerdict(gate: Gate, pullNumber: number): Promise<Verdict | null> {
  const parsed = verdictSchema.safeParse(
    await gate.store.get(verdictKey(gate, pullNumber), "json")
  );
  return parsed.success ? parsed.data : null;
}

function writeVerdict(gate: Gate, pullNumber: number, verdict: Verdict): Promise<void> {
  return gate.store.put(verdictKey(gate, pullNumber), JSON.stringify(verdict), {
    ttlMs: VERDICT_TTL_MS,
  });
}

async function clearPending(gate: Gate, pullNumber: number, sha: string): Promise<void> {
  const key = pendingKey(gate.repo, pullNumber);
  const pending = pendingSchema.safeParse(await gate.store.get(key, "json"));
  if (pending.success && pending.data.sha === sha) await gate.store.delete(key);
}

const short = (sha: string) => sha.slice(0, 7);

const processed = (handler_action: string): HandlerResult => ({
  outcome: "processed",
  sessions: [],
  handler_action,
});
const skipped = (skip_reason: string): HandlerResult => ({ outcome: "skipped", skip_reason });

/**
 * A pull request's own diff without what a base-branch update changes: blob ids
 * (`index` lines) and hunk positions. Content lines start with a space, `+` or `-`, so
 * only headers match.
 */
export function normalizeDiff(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => (line.startsWith("@@") ? "@@" : line))
    .join("\n");
}

async function diffHash(
  gate: Gate,
  log: Logger,
  baseSha: string,
  headSha: string
): Promise<string | null> {
  const diff = await getCompareDiff(gate.client, baseSha, headSha);
  if (diff === null) {
    log.warn("check.diff_unreadable", { repo: gate.repo, base_sha: baseSha, head_sha: headSha });
    return null;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizeDiff(diff))
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function verdictConclusion(gate: Gate, approved: boolean): CheckConclusion {
  if (approved) return "success";
  return gate.mode === "required" ? "failure" : "neutral";
}

function modeNote(gate: Gate): string {
  return gate.mode === "shadow"
    ? "\n\nShadow mode: this check reports the verdict and never blocks merging."
    : "";
}

function overrideHint(env: Env): string {
  return `\`@${botHandle(env.GITHUB_BOT_USERNAME)} override <reason>\``;
}

/** The check for a head commit no review covers: it asks for one instead of failing. */
function needsReviewState(gate: Gate, headSha: string, why: string): CheckRunState {
  return {
    status: "completed",
    conclusion: gate.mode === "required" ? "action_required" : "neutral",
    output: {
      title: NEEDS_REVIEW_TITLE,
      summary: `${why} Click **Review now**, or re-run this check, when commit \`${short(headSha)}\` is ready to merge.${modeNote(gate)}`,
    },
    reviewAction: true,
  };
}

/** Puts a state on a commit's check: the run found there, else a new one. */
async function setCheck(
  gate: Gate,
  headSha: string,
  existing: ExistingCheckRun | null,
  state: CheckRunState
): Promise<void> {
  const ok = existing
    ? await updateCheckRun(gate.client, existing.id, state)
    : (await createCheckRun(gate.client, headSha, new Date().toISOString(), state)) !== null;
  if (!ok) throw new Error(`AI Review check could not be written for ${headSha}`);
}

/**
 * Runs a review start and shows it on the check. `whenNotStarted` says what a head with
 * no running review gets: a check that asks for one (a new pull request has no check
 * yet), or nothing (a refused re-run leaves the check as it was).
 */
export async function startCheckedReview(
  env: Env,
  log: Logger,
  traceId: string,
  target: { repository: Repository; pullNumber: number; headSha: string },
  whenNotStarted: "needs_review" | "keep",
  start: () => Promise<HandlerResult>
): Promise<HandlerResult> {
  const { repository, pullNumber, headSha } = target;
  const startedAt = new Date().toISOString();
  const meta = { trace_id: traceId, pull_number: pullNumber, head_sha: headSha };

  const show = async (started: boolean, reason: string): Promise<void> => {
    if (!started && whenNotStarted === "keep") return;
    const gate = await openGate(env, log, repository);
    if (!gate) return;
    const state: CheckRunState = started
      ? {
          status: "in_progress",
          output: {
            title: "AI review in progress",
            summary: `Reviewing commit \`${short(headSha)}\`.${modeNote(gate)}`,
          },
        }
      : needsReviewState(gate, headSha, `The AI review did not start (${reason}).`);
    // The sessions already ran or were refused, so a failed write must not fail the delivery:
    // a redelivery would start the review again.
    if ((await createCheckRun(gate.client, headSha, startedAt, state)) === null) {
      log.error("check.create_failed", { ...meta, repo: gate.repo, started });
      return;
    }
    if (started) {
      // A new review of this head replaces an override of it.
      const verdict = await readVerdict(gate, pullNumber);
      if (verdict?.overriddenBy && verdict.sha === headSha) {
        await gate.store.delete(verdictKey(gate, pullNumber));
      }
      await gate.store.put(
        pendingKey(gate.repo, pullNumber),
        JSON.stringify({ sha: headSha, startedAt }),
        { ttlMs: PENDING_TTL_MS }
      );
    }
  };

  let result: HandlerResult;
  try {
    result = await start();
  } catch (error) {
    await show(false, "session start failed").catch((showError: unknown) =>
      log.error("check.create_failed", {
        ...meta,
        error: showError instanceof Error ? showError : new Error(String(showError)),
      })
    );
    throw error;
  }
  await show(
    result.outcome === "processed",
    result.outcome === "skipped" ? result.skip_reason : ""
  );
  return result;
}

/** A new head: carry the last verdict forward when the diff is unchanged, else ask for a review. */
export async function handlePullRequestSynchronized(
  env: Env,
  log: Logger,
  payload: PullRequestSynchronizePayload,
  traceId: string
): Promise<HandlerResult> {
  const { pull_request: pr, repository } = payload;
  if (pr.state !== "open") return skipped("pr_not_open");
  if (pr.draft) return skipped("draft_pr");
  const gate = await openGate(env, log, repository);
  if (!gate) return skipped("merge_gate_off");

  const headSha = pr.head.sha;
  const [hash, verdict] = await Promise.all([
    diffHash(gate, log, pr.base.sha, headSha),
    readVerdict(gate, pr.number),
  ]);

  if (verdict && hash !== null && verdict.diffHash === hash) {
    await setCheck(gate, headSha, null, {
      status: "completed",
      conclusion: verdictConclusion(gate, verdict.approved),
      output: {
        title: verdict.approved ? "Approved (carried forward)" : "Not approved (carried forward)",
        summary: `Carried forward from commit \`${short(verdict.reviewedSha)}\`: this push left the pull request's own diff unchanged.\n\n${verdict.summary}${modeNote(gate)}`,
      },
      reviewAction: !verdict.approved,
    });
    await writeVerdict(gate, pr.number, { ...verdict, sha: headSha });
    log.info("check.carried_forward", {
      trace_id: traceId,
      repo: gate.repo,
      pull_number: pr.number,
      head_sha: headSha,
      reviewed_sha: verdict.reviewedSha,
    });
    return processed("check_carried_forward");
  }

  await setCheck(
    gate,
    headSha,
    null,
    needsReviewState(gate, headSha, "No AI review covers this commit.")
  );
  return processed("check_needs_review");
}

function isApproval(review: PullRequestReview): boolean {
  return review.state.toUpperCase() === "APPROVED" || review.body.includes(ADVISORY_APPROVE_MARKER);
}

/** The model a multi-reviewer review names in its first lines, as the prompt asks it to. */
function reviewerName(review: PullRequestReview): string {
  return /^\*\*Reviewer: (.+?)\*\*/m.exec(review.body)?.[1] ?? "AI review";
}

/**
 * Concludes a commit's check from the bot's reviews on it, once every configured
 * reviewer has posted. `timedOut` concludes a run that is still waiting as unfinished.
 */
async function concludeFromReviews(
  env: Env,
  log: Logger,
  gate: Gate,
  pr: { number: number; headSha: string; baseSha: string },
  commit: string,
  timedOut: boolean
): Promise<HandlerResult> {
  const verdict = await readVerdict(gate, pr.number);
  if (verdict?.overriddenBy && verdict.reviewedSha === commit) return skipped("check_overridden");

  const [found, reviews] = await Promise.all([
    findCheckRun(gate.client, env.GITHUB_APP_ID, commit),
    listPullRequestReviews(
      gate.client.token,
      `${gate.client.repoUrl}/pulls/${pr.number}/reviews`,
      gate.client.userAgent
    ),
  ]);
  if (found === null) throw new Error(`AI Review check unreadable for ${commit}`);
  if (reviews === null) throw new Error(`Reviews unreadable for pull request #${pr.number}`);
  if (timedOut && found.run?.status !== "in_progress") {
    await clearPending(gate, pr.number, commit);
    return skipped("check_not_stuck");
  }

  // Reviews from before the run started belong to an earlier run on the same commit.
  const runStart = found.run?.startedAt ? Date.parse(found.run.startedAt) : null;
  const posted = reviews.filter(
    (review) =>
      review.commitId === commit &&
      review.state.toUpperCase() !== "DISMISSED" &&
      isBotLogin(review.login, env.GITHUB_BOT_USERNAME) &&
      (runStart === null || Date.parse(review.submittedAt) >= runStart)
  );
  const expected = gate.config.reviewers?.length ?? 1;

  if (posted.length < expected) {
    if (!timedOut) return skipped("awaiting_reviewers");
    await setCheck(gate, commit, found.run, {
      status: "completed",
      conclusion: gate.mode === "required" ? "failure" : "neutral",
      output: {
        title: "The AI review did not finish",
        summary: `${posted.length} of ${expected} reviews posted on commit \`${short(commit)}\`. Re-run this check to review again.${modeNote(gate)}`,
      },
      reviewAction: true,
    });
    await clearPending(gate, pr.number, commit);
    log.warn("check.review_timed_out", {
      repo: gate.repo,
      pull_number: pr.number,
      head_sha: commit,
      posted: posted.length,
      expected,
    });
    return processed("check_timed_out");
  }

  const counted = posted.slice(-expected);
  const approved = counted.every(isApproval);
  const verdicts = counted
    .map(
      (review) =>
        `- ${reviewerName(review)}: ${isApproval(review) ? "approve" : "changes requested"} ([review](${review.url}))`
    )
    .join("\n");
  const summary = approved
    ? verdicts
    : `${verdicts}\n\nAddress the findings and re-run this check, or ask someone with write access who is not the author to comment ${overrideHint(env)}.`;
  await setCheck(gate, commit, found.run, {
    status: "completed",
    conclusion: verdictConclusion(gate, approved),
    output: {
      title: approved ? "Approved" : "Changes requested",
      summary: `${summary}${modeNote(gate)}`,
    },
    reviewAction: !approved,
  });

  // Only the live head's verdict is worth carrying to the next push.
  if (commit === pr.headSha) {
    await writeVerdict(gate, pr.number, {
      sha: commit,
      reviewedSha: commit,
      diffHash: await diffHash(gate, log, pr.baseSha, commit),
      approved,
      summary: verdicts,
    });
  }
  await clearPending(gate, pr.number, commit);
  return processed(approved ? "check_approved" : "check_not_approved");
}

/** The bot's own review landed: conclude the check of the commit it reviewed. */
export async function handleBotReviewSubmitted(
  env: Env,
  log: Logger,
  payload: ReviewSubmittedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { review, pull_request: pr, repository } = payload;
  if (!isBotLogin(review.user.login, env.GITHUB_BOT_USERNAME)) return skipped("review_not_by_bot");
  const gate = await openGate(env, log, repository);
  if (!gate) return skipped("merge_gate_off");

  const result = await concludeFromReviews(
    env,
    log,
    gate,
    { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha },
    review.commit_id,
    false
  );
  log.info("check.review_evaluated", {
    trace_id: traceId,
    repo: gate.repo,
    pull_number: pr.number,
    head_sha: review.commit_id,
    result: result.outcome === "processed" ? result.handler_action : result.skip_reason,
  });
  return result;
}

/**
 * The bounded failure path: a review session that ends without posting leaves no
 * webhook behind, so the next webhook for the pull request concludes a check that has
 * been in progress for longer than `STUCK_REVIEW_MS`.
 */
export async function concludeStuckCheck(
  env: Env,
  log: Logger,
  repository: Repository,
  pullNumber: number
): Promise<void> {
  const store = createKvCacheStore(env.GITHUB_KV);
  const key = pendingKey(repoFullName(repository), pullNumber);
  const pending = pendingSchema.safeParse(await store.get(key, "json"));
  if (!pending.success) return;
  if (Date.now() - Date.parse(pending.data.startedAt) <= STUCK_REVIEW_MS) return;

  const gate = await openGate(env, log, repository);
  if (!gate) {
    await store.delete(key);
    return;
  }
  const pr = await readPullRequest(gate, pullNumber);
  await concludeFromReviews(
    env,
    log,
    gate,
    { number: pullNumber, headSha: pr.head.sha, baseSha: pr.base.sha },
    pending.data.sha,
    true
  );
}

async function readPullRequest(gate: Gate, pullNumber: number): Promise<LivePullRequest> {
  const pr = await getPullRequest(
    gate.client.token,
    `${gate.client.repoUrl}/pulls/${pullNumber}`,
    gate.client.userAgent
  );
  if (pr === null) throw new Error(`Pull request #${pullNumber} unreadable`);
  return pr;
}

/**
 * What a check re-run acts on: the live pull request, and whether a review of its head
 * is already running. Null where the gate is off.
 */
export async function readRerunTarget(
  env: Env,
  log: Logger,
  repository: Repository,
  pullNumber: number
): Promise<{ pr: LivePullRequest; reviewRunning: boolean } | null> {
  const gate = await openGate(env, log, repository);
  if (!gate) return null;
  const pr = await readPullRequest(gate, pullNumber);
  const pending = pendingSchema.safeParse(
    await gate.store.get(pendingKey(gate.repo, pullNumber), "json")
  );
  const reviewRunning =
    pending.success &&
    pending.data.sha === pr.head.sha &&
    Date.now() - Date.parse(pending.data.startedAt) <= STUCK_REVIEW_MS;
  return { pr, reviewRunning };
}

/** The reason of an `override <reason>` command, or null when the text is not one. */
export function parseOverrideCommand(text: string): { reason: string } | null {
  const match = /^override(?![\p{L}\p{N}_-])[\s:,]*([\s\S]*)$/iu.exec(text.trim());
  return match && { reason: match[1].trim().slice(0, MAX_OVERRIDE_REASON_LENGTH) };
}

/**
 * `@bot override <reason>`: someone with write access who did not author the pull
 * request passes the head's check, on the record.
 */
export async function handleOverrideComment(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    repository: Repository;
    pullNumber: number;
    commentId: number;
    sender: { login: string; type?: string };
    reason: string;
  }
): Promise<HandlerResult> {
  const { repository, pullNumber, sender, reason } = params;
  // Another bot gets no reply: two bots answering each other would loop.
  if (sender.type === "Bot") return skipped("override_not_authorized");
  const gate = await openGate(env, log, repository);
  if (!gate) return skipped("merge_gate_off");

  const { token, userAgent, repoUrl } = gate.client;
  const meta = {
    trace_id: traceId,
    repo: gate.repo,
    pull_number: pullNumber,
    sender: sender.login,
  };
  const refuse = async (skip_reason: string, reply: string): Promise<HandlerResult> => {
    if (
      !(await postIssueComment(token, `${repoUrl}/issues/${pullNumber}/comments`, reply, userAgent))
    ) {
      log.warn("check.override_reply_failed", { ...meta, skip_reason });
    }
    log.info("check.override_refused", { ...meta, skip_reason });
    return skipped(skip_reason);
  };

  if (!reason) {
    return refuse("override_missing_reason", `An override needs a reason: ${overrideHint(env)}.`);
  }
  const pr = await readPullRequest(gate, pullNumber);
  if (pr.state !== "open") return skipped("pr_not_open");
  if (sender.login.toLowerCase() === pr.user.login.toLowerCase()) {
    return refuse(
      "override_by_author",
      "The author of a pull request can't override its AI Review check."
    );
  }
  const permission = await checkSenderPermission(
    token,
    repository.owner.login,
    repository.name,
    sender.login,
    userAgent
  );
  if (permission.error) return skipped("permission_check_failed");
  if (!permission.hasPermission) {
    return refuse(
      "override_not_authorized",
      "Only someone with write access to this repository can override the AI Review check."
    );
  }

  const headSha = pr.head.sha;
  const found = await findCheckRun(gate.client, env.GITHUB_APP_ID, headSha);
  if (found === null) throw new Error(`AI Review check unreadable for ${headSha}`);
  const summary = `@${sender.login} overrode the AI Review check on commit \`${short(headSha)}\`.\n\nReason: ${reason}`;
  await setCheck(gate, headSha, found.run, {
    status: "completed",
    conclusion: "success",
    output: { title: `Overridden by @${sender.login}`, summary },
    reviewAction: false,
  });
  await writeVerdict(gate, pullNumber, {
    sha: headSha,
    reviewedSha: headSha,
    diffHash: await diffHash(gate, log, pr.base.sha, headSha),
    approved: true,
    summary,
    overriddenBy: sender.login,
  });
  await clearPending(gate, pullNumber, headSha);
  if (
    !(await postReaction(
      token,
      `${repoUrl}/issues/comments/${params.commentId}/reactions`,
      "+1",
      userAgent
    ))
  ) {
    log.warn("acknowledgment.failed", meta);
  }
  log.info("check.overridden", { ...meta, head_sha: headSha });
  return processed("check_overridden");
}
