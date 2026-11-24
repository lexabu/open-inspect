/**
 * The `AI Review` merge-gate check: one check run on a pull request's head commit that
 * says whether the bot reviewed, and approved, exactly that commit.
 *
 * A review session posts its verdict as a GitHub review; the bot's own
 * `pull_request_review` webhook concludes the check. The bot posts every review under
 * one identity, so a review counts only when it carries the marker of the attempt
 * record written before its session started. Nothing reviews on push: a new head gets a
 * check that asks for a review, unless the pull request's own diff is unchanged, in
 * which case the last verdict carries forward.
 */
import { isBotLogin } from "@open-inspect/shared/github-mention";
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import { getModelDisplayName } from "@open-inspect/shared/models";
import type { BotReviewPayload, Env, PullRequestChangedPayload } from "./types";
import type { Logger } from "./logger";
import {
  listPullRequestReviews,
  type LivePullRequest,
  type PullRequestReview,
} from "./github-auth";
import {
  createCheckRun,
  findSuiteReviewRun,
  updateCheckRun,
  type CheckRunState,
} from "./github-checks";
import { hashPullRequestDiff } from "./ai-review-diff";
import {
  carriedState,
  checkExternalId,
  deleteAttempt,
  deleteAttemptRecord,
  deleteVerdict,
  isRunning,
  modeNote,
  needsReviewState,
  openGate,
  overrideHint,
  postCheck,
  processed,
  pullNumberFromExternalId,
  readAttempt,
  readAttemptRecord,
  readPullRequest,
  readVerdict,
  reviewMarker,
  sharedHeadReason,
  short,
  skipped,
  STUCK_REVIEW_MS,
  verdictConclusion,
  writeAttempt,
  writeVerdict,
  type Gate,
  type Repository,
  type ReviewAttempt,
} from "./ai-review-gate";
import type { HandlerResult } from "./session-startup";

async function diffHash(
  gate: Gate,
  log: Logger,
  baseSha: string,
  headSha: string
): Promise<string | null> {
  const hash = await hashPullRequestDiff(gate.client, baseSha, headSha);
  if (hash === null) {
    log.warn("check.diff_unreadable", { repo: gate.repo, base_sha: baseSha, head_sha: headSha });
  }
  return hash;
}

/**
 * Runs a review start and shows it on the check.
 *
 * The attempt record is written before `start` runs, and a head with an attempt already
 * running is skipped, so repeated clicks and repeated deliveries start one set of
 * reviewers. (KV has no compare-and-set: two starts within its write latency can still
 * both run. Each then has its own attempt, and only the one whose record survives
 * concludes the check.) `start` gets the marker for each reviewer, by position, or null
 * where the gate is off.
 *
 * `whenNotStarted` says what a head with no running review gets: a check that asks for
 * one (a new pull request has no check yet), or nothing (a refused re-run leaves the
 * check as it was).
 */
export async function startCheckedReview(
  env: Env,
  log: Logger,
  traceId: string,
  target: {
    repository: Repository;
    pullNumber: number;
    headSha: string;
    base: { ref: string; sha: string };
  },
  whenNotStarted: "needs_review" | "keep",
  start: (markers: string[] | null) => Promise<HandlerResult>
): Promise<HandlerResult> {
  const { repository, pullNumber, headSha, base } = target;
  const gate = await openGate(env, log, repository);
  if (!gate) return start(null);

  const meta = { trace_id: traceId, repo: gate.repo, pull_number: pullNumber, head_sha: headSha };
  const running = await readAttempt(gate, pullNumber);
  if (running?.headSha === headSha && isRunning(running)) return skipped("review_in_progress");

  const models = gate.config.reviewers?.map((reviewer) => reviewer.model) ?? [gate.config.model];
  const attempt: ReviewAttempt = {
    id: crypto.randomUUID(),
    prNumber: pullNumber,
    headSha,
    baseSha: base.sha,
    baseRef: base.ref,
    startedAt: new Date().toISOString(),
    reviewers: models.map((model) => ({ key: crypto.randomUUID(), model, seen: null })),
    checkRunId: null,
    diffHash: null,
    concludedAt: null,
  };
  await writeAttempt(gate, attempt);
  const isCurrent = async () => (await readAttempt(gate, pullNumber))?.id === attempt.id;
  if (!(await isCurrent())) return skipped("review_in_progress");

  // The sessions already ran or were refused, so a failed check write must not fail the
  // delivery: a redelivery would start the review again.
  const abandon = async (reason: string): Promise<void> => {
    if (await isCurrent()) await deleteAttempt(gate, pullNumber);
    if (whenNotStarted === "keep") return;
    const run = { headSha, startedAt: attempt.startedAt, externalId: checkExternalId(pullNumber) };
    const state = needsReviewState(gate, headSha, `The AI review did not start (${reason}).`);
    if ((await createCheckRun(gate.client, run, state)) === null) {
      log.error("check.create_failed", { ...meta, started: false });
    }
  };

  let result: HandlerResult;
  try {
    result = await start(attempt.reviewers.map(({ key }) => reviewMarker(attempt.id, key)));
  } catch (error) {
    await abandon("session start failed");
    throw error;
  }
  if (result.outcome === "skipped") {
    await abandon(result.skip_reason);
    return result;
  }

  const checkRunId = await createCheckRun(
    gate.client,
    {
      headSha,
      startedAt: attempt.startedAt,
      externalId: checkExternalId(pullNumber, attempt.id),
    },
    {
      status: "in_progress",
      output: {
        title: "AI review in progress",
        summary: `Reviewing commit \`${short(headSha)}\`.${modeNote(gate)}`,
      },
    }
  );
  if (checkRunId === null) {
    // Without a check run the reviews have nothing to conclude.
    log.error("check.create_failed", { ...meta, started: true });
    if (await isCurrent()) await deleteAttempt(gate, pullNumber);
    return result;
  }
  const hash = await diffHash(gate, log, base.sha, headSha);
  // An override or a base change while the sessions started has replaced this attempt.
  if (!(await isCurrent())) return result;
  await writeAttempt(gate, { ...attempt, checkRunId, diffHash: hash });
  // A review that landed before the check run existed could not conclude it; do so now.
  // The sessions are running, so a failure here is left to the next review webhook.
  try {
    await concludeAttempt(env, log, gate, pullNumber, headSha, false);
  } catch (error) {
    log.warn("check.early_review_lookup_failed", {
      ...meta,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return result;
}

/**
 * A new head, or a new base branch. A new base always asks for a review. A new head
 * carries the last verdict forward when the pull request's own diff is the one it
 * covers, against the same base branch, and no other open pull request shares the head.
 */
export async function handlePullRequestChanged(
  env: Env,
  log: Logger,
  payload: PullRequestChangedPayload,
  traceId: string
): Promise<HandlerResult> {
  const { repository } = payload;
  const pullNumber = payload.pull_request.number;
  const gate = await openGate(env, log, repository);
  if (!gate) return skipped("merge_gate_off");

  // Deliveries arrive out of order and late; act on the pull request as it is now.
  const pr = await readPullRequest(gate, pullNumber);
  if (pr.state !== "open") return skipped("pr_not_open");
  if (pr.draft) return skipped("draft_pr");
  const headSha = pr.head.sha;
  const meta = { trace_id: traceId, repo: gate.repo, pull_number: pullNumber, head_sha: headSha };

  if (payload.action === "edited") {
    // The evidence was reached against another base branch; none of it carries over.
    await deleteVerdict(gate, pullNumber);
    if ((await readAttempt(gate, pullNumber))?.headSha === headSha) {
      await deleteAttempt(gate, pullNumber);
    }
    await postCheck(
      gate,
      pullNumber,
      headSha,
      needsReviewState(gate, headSha, `The base branch changed to \`${pr.base.ref}\`.`)
    );
    log.info("check.base_changed", meta);
    return processed("check_needs_review");
  }

  if (payload.pull_request.head.sha !== headSha) return skipped("stale_synchronize");

  const [hash, verdict] = await Promise.all([
    diffHash(gate, log, pr.base.sha, headSha),
    readVerdict(gate, pullNumber),
  ]);
  const covered =
    verdict !== null &&
    hash !== null &&
    verdict.diffHash === hash &&
    verdict.baseRef === pr.base.ref;
  if (!covered) {
    await postCheck(
      gate,
      pullNumber,
      headSha,
      needsReviewState(gate, headSha, "No AI review covers this diff.")
    );
    return processed("check_needs_review");
  }
  const shared = verdict.approved ? await sharedHeadReason(gate, pullNumber, headSha) : null;
  if (shared !== null) {
    await postCheck(gate, pullNumber, headSha, needsReviewState(gate, headSha, shared));
    return processed("check_needs_review");
  }

  await postCheck(gate, pullNumber, headSha, carriedState(gate, verdict));
  await writeVerdict(gate, pullNumber, { ...verdict, sha: headSha });
  log.info("check.carried_forward", { ...meta, reviewed_sha: verdict.reviewedSha });
  return processed("check_carried_forward");
}

/**
 * Whether a review approves, read once when it is first seen. `CHANGES_REQUESTED` and a
 * dismissed review never approve, whatever their text says. A comment-only review
 * approves only when the approve marker is its last line, apart from attempt marker
 * lines: quoted or embedded in prose it is not a verdict.
 */
function approves(review: PullRequestReview): boolean {
  const state = review.state.toUpperCase();
  if (state === "APPROVED") return true;
  if (state !== "COMMENTED") return false;
  const lines = review.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("<!-- open-inspect:review attempt="));
  return lines.at(-1) === ADVISORY_APPROVE_MARKER;
}

/**
 * The attempt's reviewers with the review of each one that has posted: the first the
 * bot posted on the attempt's commit with that reviewer's marker on a line of its own.
 * A later review with the same marker never replaces it: the marker is public once
 * posted, and a copy must not override the reviewer's own verdict. Once seen, a
 * reviewer's review and verdict are fixed.
 */
function withSeenReviews(
  env: Env,
  attempt: ReviewAttempt,
  reviews: PullRequestReview[]
): ReviewAttempt["reviewers"] {
  const candidates = reviews.filter(
    (review) =>
      review.commitId === attempt.headSha && isBotLogin(review.login, env.GITHUB_BOT_USERNAME)
  );
  return attempt.reviewers.map((reviewer) => {
    if (reviewer.seen !== null) return reviewer;
    const marker = reviewMarker(attempt.id, reviewer.key);
    const review = candidates.find((candidate) =>
      candidate.body.split("\n").some((line) => line.trim() === marker)
    );
    if (!review) return reviewer;
    return {
      ...reviewer,
      seen: { reviewId: review.id, approve: approves(review), url: review.url },
    };
  });
}

/**
 * Concludes the attempt on a commit once each of its reviewers has posted, and again
 * whenever its reviews change (a dismissal, a review that posts late). `timedOut`
 * concludes an attempt that is still waiting as unfinished.
 */
async function concludeAttempt(
  env: Env,
  log: Logger,
  gate: Gate,
  pullNumber: number,
  commit: string,
  timedOut: boolean
): Promise<HandlerResult> {
  const attempt = await readAttempt(gate, pullNumber);
  if (attempt?.prNumber !== pullNumber || attempt.headSha !== commit) {
    return skipped("no_review_attempt");
  }
  const { checkRunId } = attempt;
  if (checkRunId === null) return skipped("check_not_created");

  const reviews = await listPullRequestReviews(
    gate.client.token,
    `${gate.client.repoUrl}/pulls/${pullNumber}/reviews`,
    gate.client.userAgent
  );
  if (reviews === null) throw new Error(`Reviews unreadable for pull request #${pullNumber}`);
  const reviewers = withSeenReviews(env, attempt, reviews);
  // Keep what was seen even while other reviewers are awaited: a body edited later
  // must not change a verdict already read.
  if (reviewers.some((reviewer, index) => reviewer.seen !== attempt.reviewers[index].seen)) {
    await writeAttempt(gate, { ...attempt, reviewers });
  }
  const posted = reviewers.flatMap(({ model, seen }) => (seen ? [{ model, seen }] : []));
  const expected = reviewers.length;

  const conclude = async (state: CheckRunState): Promise<void> => {
    if (!(await updateCheckRun(gate.client, checkRunId, state))) {
      throw new Error(`AI Review check could not be written for ${commit}`);
    }
    await writeAttempt(gate, { ...attempt, reviewers, concludedAt: new Date().toISOString() });
  };

  if (posted.length < expected) {
    if (!timedOut) return skipped("awaiting_reviewers");
    await conclude({
      status: "completed",
      conclusion: gate.mode === "required" ? "failure" : "neutral",
      output: {
        title: "The AI review did not finish",
        summary: `${posted.length} of ${expected} reviews posted on commit \`${short(commit)}\`. Re-run this check to review again.${modeNote(gate)}`,
      },
      reviewAction: true,
    });
    log.warn("check.review_timed_out", {
      repo: gate.repo,
      pull_number: pullNumber,
      head_sha: commit,
      posted: posted.length,
      expected,
    });
    return processed("check_timed_out");
  }

  // A verdict only ever gets worse after it is seen: its review is dismissed, or gone.
  const verdicts = posted.map(({ model, seen }) => {
    const live = reviews.find((review) => review.id === seen.reviewId);
    const dismissed = live === undefined || live.state.toUpperCase() === "DISMISSED";
    const approve = seen.approve && !dismissed;
    const verdict = dismissed ? "dismissed" : approve ? "approve" : "changes requested";
    return { line: `- ${getModelDisplayName(model)}: ${verdict} ([review](${seen.url}))`, approve };
  });
  const summary = verdicts.map(({ line }) => line).join("\n");
  const approved = verdicts.every(({ approve }) => approve);

  const stored = await readVerdict(gate, pullNumber);
  const own = stored?.attemptId === attempt.id ? stored : null;
  if (attempt.concludedAt !== null && own?.approved === approved && own.summary === summary) {
    return skipped("verdict_unchanged");
  }

  // An approval passes only the pull request it was reached for, as that pull request
  // still is: same base branch, and the only open pull request on the commit.
  const blocked = approved ? await passBlockedReason(gate, attempt) : null;
  if (blocked !== null) {
    await conclude(needsReviewState(gate, commit, blocked));
    return processed("check_needs_review");
  }

  await conclude({
    status: "completed",
    conclusion: verdictConclusion(gate, approved),
    output: {
      title: approved ? "Approved" : "Changes requested",
      summary: approved
        ? `${summary}${modeNote(gate)}`
        : `${summary}\n\nAddress the findings and re-run this check, or ask someone with write access who is not the author to comment ${overrideHint(env)}.${modeNote(gate)}`,
    },
    reviewAction: !approved,
  });
  const verdict = {
    // A verdict already carried to a later head keeps covering that head.
    sha: own?.sha ?? commit,
    reviewedSha: commit,
    baseRef: attempt.baseRef,
    baseSha: attempt.baseSha,
    diffHash: attempt.diffHash,
    approved,
    summary,
    attemptId: attempt.id,
  };
  await writeVerdict(gate, pullNumber, verdict);
  // A verdict carried to a later head is taken back there too. It is never newly passed
  // there: a pass on another commit needs that commit's own carry-forward tests.
  if (verdict.sha !== commit && !approved) {
    await postCheck(gate, pullNumber, verdict.sha, carriedState(gate, verdict));
  }
  return processed(approved ? "check_approved" : "check_not_approved");
}

async function passBlockedReason(gate: Gate, attempt: ReviewAttempt): Promise<string | null> {
  const pr = await readPullRequest(gate, attempt.prNumber);
  if (pr.base.ref !== attempt.baseRef) {
    return `The base branch changed from \`${attempt.baseRef}\` to \`${pr.base.ref}\` during the review.`;
  }
  return sharedHeadReason(gate, attempt.prNumber, attempt.headSha);
}

/** A review of the bot's was posted or dismissed: conclude the attempt on its commit. */
export async function handleBotReviewChanged(
  env: Env,
  log: Logger,
  payload: BotReviewPayload,
  traceId: string
): Promise<HandlerResult> {
  const { review, pull_request: pr, repository } = payload;
  if (!isBotLogin(review.user.login, env.GITHUB_BOT_USERNAME)) return skipped("review_not_by_bot");
  const gate = await openGate(env, log, repository);
  if (!gate) return skipped("merge_gate_off");

  const result = await concludeAttempt(env, log, gate, pr.number, review.commit_id, false);
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
 * webhook behind, so the next webhook for the pull request concludes an attempt that
 * has been running for longer than `STUCK_REVIEW_MS`.
 */
export async function concludeStuckCheck(
  env: Env,
  log: Logger,
  repository: Repository,
  pullNumber: number
): Promise<void> {
  const attempt = await readAttemptRecord(env, repository, pullNumber);
  if (!attempt || attempt.concludedAt !== null) return;
  if (Date.now() - Date.parse(attempt.startedAt) <= STUCK_REVIEW_MS) return;

  const gate = await openGate(env, log, repository);
  // Nothing can conclude an attempt whose gate is off or whose check run was never made.
  if (!gate || attempt.checkRunId === null) {
    await deleteAttemptRecord(env, repository, pullNumber);
    return;
  }
  await concludeAttempt(env, log, gate, pullNumber, attempt.headSha, true);
}

/** The live pull request a check re-run targets; null where the gate is off. */
export async function readRerunTarget(
  env: Env,
  log: Logger,
  repository: Repository,
  pullNumber: number
): Promise<LivePullRequest | null> {
  const gate = await openGate(env, log, repository);
  return gate && readPullRequest(gate, pullNumber);
}

/**
 * The pull request of the AI Review run in a check suite, for "Re-run all checks".
 * `gate: false` where the gate is off; `pullNumber: null` when the suite has no AI
 * Review run that names a pull request.
 */
export async function readSuiteReviewPull(
  env: Env,
  log: Logger,
  repository: Repository,
  checkSuiteId: number
): Promise<{ gate: false } | { gate: true; pullNumber: number | null }> {
  const gate = await openGate(env, log, repository);
  if (!gate) return { gate: false };
  const run = await findSuiteReviewRun(gate.client, checkSuiteId);
  if (run === null) throw new Error(`Check suite ${checkSuiteId} unreadable`);
  return { gate: true, pullNumber: pullNumberFromExternalId(run.externalId) };
}
