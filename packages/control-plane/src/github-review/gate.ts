/**
 * The `AI Review` merge gate: one check run on a pull request's head commit that says
 * whether the platform's reviewers reviewed, and approved, exactly that commit.
 *
 * A review is an attempt: one platform-held session per configured reviewer. Each
 * session ends its last message with a verdict, which the platform reads from the
 * session itself when it completes. GitHub review bodies play no part: they can be
 * edited, copied and written by other sessions. Nothing reviews on push: a new head
 * gets a check that asks for a review, unless the pull request's own diff is unchanged,
 * in which case the last verdict carries forward.
 */
import { botHandle } from "@open-inspect/shared/github-mention";
import { parseReviewVerdict } from "@open-inspect/shared/github-review-verdict";
import { getModelDisplayName } from "@open-inspect/shared/models";
import {
  reviewCheckExternalId,
  type GateOverrideRequest,
  type GateOverrideResponse,
  type GatePullChangeRequest,
  type GatePullChangeResponse,
  type StartGateReviewRequest,
  type StartGateReviewResponse,
} from "@open-inspect/shared/types/github-review-gate";
import type { GitHubMergeGate } from "@open-inspect/shared/types/integrations";
import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { CheckRunState, GateGitHub, LivePull } from "./github";
import type {
  PullKey,
  PullVerdict,
  ReviewAttempt,
  ReviewAttemptSession,
  ReviewGateStore,
} from "./store";

/** An attempt whose sessions have not all reported after this long is concluded as unfinished. */
export const REVIEW_ATTEMPT_TIMEOUT_MS = 90 * 60 * 1000;

/** An attempt whose check still cannot be written this long after it started is given up. */
const REVIEW_ATTEMPT_GIVE_UP_MS = 2 * REVIEW_ATTEMPT_TIMEOUT_MS;

/** A conclusion claimed this long ago without finishing was left by a worker that died. */
const STALE_CONCLUSION_MS = 5 * 60 * 1000;

export interface GateRepository {
  owner: string;
  name: string;
  id: number;
}

type Reviewer = StartGateReviewRequest["reviewers"][number];

/** Creates and prompts the platform-held sessions of an attempt. */
export interface GateSessions {
  create(reviewer: Reviewer): Promise<string>;
  /**
   * Queues the reviewer's prompt, with the verdict it must end on bound to `nonce`. The
   * session reports to the gate when it completes.
   */
  prompt(sessionId: string, reviewer: Reviewer, nonce: string): Promise<string>;
}

export interface ReviewGateDeps {
  store: ReviewGateStore;
  github(repository: GateRepository): GateGitHub;
  /** The repository's `mergeGate` setting; `off` also where the bot is not enabled. */
  mode(repository: GateRepository): Promise<GitHubMergeGate>;
  botUsername: string;
  now(): number;
  log: Logger;
}

type ActiveMode = Exclude<GitHubMergeGate, "off">;
const short = (sha: string) => sha.slice(0, 7);

function modeNote(mode: ActiveMode): string {
  return mode === "shadow"
    ? "\n\nShadow mode: this check reports the verdict and never blocks merging."
    : "";
}

/** The check for a head commit no review covers: it asks for one instead of failing. */
function needsReview(mode: ActiveMode, headSha: string, why: string): CheckRunState {
  return {
    status: "completed",
    conclusion: mode === "required" ? "action_required" : "neutral",
    output: {
      title: "Re-run the AI review before merging",
      summary: `${why} Click **Review now**, or re-run this check, when commit \`${short(headSha)}\` is ready to merge.${modeNote(mode)}`,
    },
    reviewAction: true,
  };
}

function verdictConclusion(mode: ActiveMode, approved: boolean) {
  if (approved) return "success" as const;
  return mode === "required" ? ("failure" as const) : ("neutral" as const);
}

/**
 * The check of a run that something else replaced. It concludes `cancelled`, not
 * `neutral`: GitHub lets a neutral run pass a required check, and whatever the order in
 * which runs were created, a replaced run must never be what lets a head merge.
 */
const SUPERSEDED: CheckRunState = {
  status: "completed",
  conclusion: "cancelled",
  output: {
    title: "Superseded",
    summary: "Another AI Review check on this pull request replaced this run.",
  },
  reviewAction: false,
};

export class ReviewGate {
  constructor(private readonly deps: ReviewGateDeps) {}

  /** Starts a review of the pull request's head, unless one is already running on it. */
  async start(
    request: StartGateReviewRequest,
    repository: GateRepository,
    sessions: GateSessions
  ): Promise<StartGateReviewResponse> {
    const { store, log } = this.deps;
    const mode = await this.deps.mode(repository);
    if (mode === "off") return { outcome: "skipped", reason: "merge_gate_off" };
    const github = this.deps.github(repository);
    const pull = await this.livePull(github, request.pullNumber);
    if (!pull.open) return { outcome: "skipped", reason: "pr_not_open" };
    if (pull.draft) return { outcome: "skipped", reason: "draft_pr" };
    if (pull.headSha !== request.headSha) return { outcome: "skipped", reason: "stale_head" };
    // The prompts name a base; a pull request retargeted since they were written would
    // be reviewed against one branch and recorded against another.
    if (pull.baseRef !== request.base.ref) return { outcome: "skipped", reason: "stale_base" };

    const attempt = {
      id: generateId(),
      repoOwner: repository.owner,
      repoName: repository.name,
      repoId: repository.id,
      prNumber: pull.number,
      headSha: pull.headSha,
      // The base the reviewers are given, not the live one: the branch may have moved on
      // since the prompts were written, and the conclusion compares against this.
      baseRef: request.base.ref,
      baseSha: request.base.sha,
      diffHash: await github.hashPullDiff(request.base.sha, pull.headSha),
    };
    const startedAt = this.deps.now();
    // The claim is the serialization point: of two starts, the database admits one.
    const { claimed, superseded } = await store.claimAttempt(attempt, startedAt);
    await this.closeSuperseded(github, superseded);
    if (!claimed) return { outcome: "skipped", reason: "review_in_progress" };

    let checkRunId: number | null = null;
    let started: { sessionId: string; messageId: string; model: string }[];
    try {
      const created = [];
      for (const reviewer of request.reviewers) {
        const sessionId = await sessions.create(reviewer);
        created.push({ reviewer, sessionId, nonce: generateId() });
      }
      await store.addSessions(
        attempt.id,
        created.map(({ reviewer, sessionId, nonce }) => ({
          sessionId,
          model: reviewer.model,
          nonce,
        }))
      );
      // The sessions and the check run are on record before any session is prompted, so
      // none can report unseen, and a conclusion always has this run to write to.
      checkRunId = await github.createCheck(
        {
          headSha: pull.headSha,
          externalId: reviewCheckExternalId(pull.number, attempt.id),
          startedAt: new Date(startedAt).toISOString(),
        },
        {
          status: "in_progress",
          output: {
            title: "AI review in progress",
            summary: `Reviewing commit \`${short(pull.headSha)}\`.${modeNote(mode)}`,
          },
        }
      );
      if (checkRunId === null) {
        // Without it the conclusion creates the check run instead of updating one.
        log.error("github_review.check_create_failed", { attempt: attempt.id });
      } else {
        await store.setCheckRun(attempt.id, checkRunId);
        // An override or a base change may have superseded the attempt before its check
        // run was on record. That run is then newer than whatever replaced the attempt
        // posted, so it is the one that counts on the head and must not pass: it asks
        // for a review, and no reviewer is prompted. Once the run is on record,
        // whatever supersedes the attempt closes it itself.
        if ((await store.getAttempt(attempt.id))?.status === "superseded") {
          const state = needsReview(
            mode,
            pull.headSha,
            "This review was replaced while it started."
          );
          if (!(await github.updateCheck(checkRunId, state))) {
            log.error("github_review.check_close_failed", { attempt: attempt.id });
          }
          return { outcome: "skipped", reason: "superseded" };
        }
      }
      started = await Promise.all(
        created.map(async ({ reviewer, sessionId, nonce }) => ({
          sessionId,
          messageId: await sessions.prompt(sessionId, reviewer, nonce),
          model: reviewer.model,
        }))
      );
    } catch (error) {
      // A review that did not fully start decides nothing; a session that did start
      // reports into a superseded attempt. Nothing replaces its check run, so the run
      // asks for a review: closed as neutral, it would pass a required check.
      const superseded = await store.supersedeAttempt(attempt.id, this.deps.now());
      // Only if this teardown is what ended the attempt: one that an override or a base
      // change replaced first had its run closed by that, and keeps it.
      if (superseded && checkRunId !== null) {
        const state = needsReview(mode, pull.headSha, "The AI review could not be started.");
        if (!(await github.updateCheck(checkRunId, state))) {
          log.error("github_review.check_close_failed", { attempt: attempt.id });
        }
      }
      throw error;
    }
    log.info("github_review.started", {
      attempt: attempt.id,
      repo: `${repository.owner}/${repository.name}`,
      pull_number: pull.number,
      head_sha: pull.headSha,
      reviewers: started.length,
    });
    return { outcome: "started", attemptId: attempt.id, sessions: started };
  }

  /** A pull request changed in a way no review covers yet; see the request's `change`. */
  async pullChanged(
    request: GatePullChangeRequest,
    repository: GateRepository
  ): Promise<GatePullChangeResponse> {
    const { store } = this.deps;
    const mode = await this.deps.mode(repository);
    if (mode === "off") return { outcome: "skipped", reason: "merge_gate_off" };
    const github = this.deps.github(repository);
    // Deliveries arrive out of order and late; act on the pull request as it is now.
    const pull = await this.livePull(github, request.pullNumber);
    if (!pull.open) return { outcome: "skipped", reason: "pr_not_open" };
    if (pull.draft) return { outcome: "skipped", reason: "draft_pr" };
    const pullKey = { repoId: repository.id, prNumber: pull.number };
    const state = (why: string) => needsReview(mode, pull.headSha, why);
    const ask = async (why: string): Promise<GatePullChangeResponse> =>
      (await this.postUnlessReviewing(github, pullKey, pull, state(why)))
        ? { outcome: "needs_review" }
        : { outcome: "skipped", reason: "review_in_progress" };

    switch (request.change) {
      case "review_not_started": {
        if (pull.headSha !== request.headSha) return { outcome: "skipped", reason: "stale_head" };
        if (await this.reviewing(pullKey, pull)) {
          return { outcome: "skipped", reason: "review_in_progress" };
        }
        return ask(`The AI review did not start (${request.detail ?? "unknown reason"}).`);
      }
      case "base":
      case "reopened": {
        // The evidence was reached against another base branch, or before the pull
        // request was closed; none of it carries over. The new check is posted first:
        // a superseded run is only closed once something newer stands on the head.
        await this.postCheck(
          github,
          pull,
          state(
            request.change === "base"
              ? `The base branch changed to \`${pull.baseRef}\`.`
              : "The pull request was reopened."
          )
        );
        await this.closeSuperseded(github, await store.invalidate(pullKey, this.deps.now()));
        return { outcome: "needs_review" };
      }
      case "head": {
        if (pull.headSha !== request.headSha) return { outcome: "skipped", reason: "stale_head" };
        // A review of this very head is under way (a late delivery, or a review asked
        // for before the push event arrived). A newer check run would shadow its result.
        if (await this.reviewing(pullKey, pull)) {
          return { outcome: "skipped", reason: "review_in_progress" };
        }
        const verdict = await store.getVerdict(pullKey);
        const carried = verdict
          ? await this.carryForward(github, pullKey, pull, verdict, mode)
          : "not_covered";
        if (carried === "carried") return { outcome: "carried_forward" };
        if (carried === "reviewing") return { outcome: "skipped", reason: "review_in_progress" };
        return ask(carried === "not_covered" ? "No AI review covers this diff." : carried.blocked);
      }
    }
  }

  /** Whether an attempt on the pull request's live head is running or concluding. */
  private async reviewing(pullKey: PullKey, pull: LivePull): Promise<boolean> {
    return (await this.deps.store.getActiveAttempt(pullKey))?.headSha === pull.headSha;
  }

  /**
   * Carries a verdict to a new head whose diff it still covers. `not_covered` when it does
   * not cover the head, `blocked` with the reason an approval that covers it must not pass
   * here, `reviewing` when a review of the head started meanwhile.
   */
  private async carryForward(
    github: GateGitHub,
    pullKey: PullKey,
    pull: LivePull,
    verdict: PullVerdict,
    mode: ActiveMode
  ): Promise<"carried" | "not_covered" | "reviewing" | { blocked: string }> {
    // An override is a person's decision about one commit; it is never extended to another.
    if (verdict.attemptId === null) return "not_covered";
    if (verdict.diffHash === null || verdict.baseRef !== pull.baseRef) return "not_covered";
    if ((await github.hashPullDiff(pull.baseSha, pull.headSha)) !== verdict.diffHash) {
      return "not_covered";
    }
    if (verdict.approved) {
      const shared = await github.sharedHeadReason(pull);
      if (shared !== null) return { blocked: shared };
    }
    // The verdict may have changed since it was read; a stale one is not carried.
    if (!(await this.deps.store.carryVerdict(pullKey, verdict, pull.headSha, this.deps.now()))) {
      return "not_covered";
    }
    const posted = await this.postUnlessReviewing(github, pullKey, pull, {
      status: "completed",
      conclusion: verdictConclusion(mode, verdict.approved),
      output: {
        title: verdict.approved ? "Approved (carried forward)" : "Not approved (carried forward)",
        summary: `Carried forward from commit \`${short(verdict.reviewedSha)}\`: the pull request's own diff is unchanged.\n\n${verdict.summary}${modeNote(mode)}`,
      },
      reviewAction: !verdict.approved,
    });
    if (!posted) return "reviewing";
    this.deps.log.info("github_review.carried_forward", {
      pull_number: pull.number,
      head_sha: pull.headSha,
      reviewed_sha: verdict.reviewedSha,
    });
    return "carried";
  }

  /** A human passes the head's check, on the record. The caller has checked their access. */
  async override(
    request: GateOverrideRequest,
    repository: GateRepository
  ): Promise<GateOverrideResponse> {
    const mode = await this.deps.mode(repository);
    if (mode === "off") return { outcome: "refused", reason: "merge_gate_off", detail: "" };
    const github = this.deps.github(repository);
    const pull = await this.livePull(github, request.pullNumber);
    if (!pull.open) return { outcome: "refused", reason: "pr_not_open", detail: "" };
    if (!pull.headSha.startsWith(request.commit)) {
      return {
        outcome: "refused",
        reason: "wrong_commit",
        detail: `\`${request.commit}\` is not the head of this pull request. The head is \`${short(pull.headSha)}\`; an override applies only to the commit it names.`,
      };
    }
    if (request.overriddenBy.toLowerCase() === pull.author.toLowerCase()) {
      return {
        outcome: "refused",
        reason: "by_author",
        detail: "The author of a pull request can't override its AI Review check.",
      };
    }
    const shared = await github.sharedHeadReason(pull);
    if (shared !== null) {
      return {
        outcome: "refused",
        reason: "shared_head",
        detail: `${shared} The check can't be overridden.`,
      };
    }

    const summary = `@${request.overriddenBy} overrode the AI Review check on commit \`${short(pull.headSha)}\`.\n\nReason: ${request.reason}`;
    await this.postCheck(github, pull, {
      status: "completed",
      conclusion: "success",
      output: { title: `Overridden by @${request.overriddenBy}`, summary },
      reviewAction: false,
    });
    const superseded = await this.deps.store.override(
      { repoId: repository.id, prNumber: pull.number },
      {
        sha: pull.headSha,
        baseRef: pull.baseRef,
        baseSha: pull.baseSha,
        diffHash: await github.hashPullDiff(pull.baseSha, pull.headSha),
        summary,
      },
      this.deps.now()
    );
    await this.closeSuperseded(github, superseded);
    this.deps.log.info("github_review.overridden", {
      pull_number: pull.number,
      head_sha: pull.headSha,
      overridden_by: request.overriddenBy,
    });
    return { outcome: "overridden", headSha: pull.headSha };
  }

  /**
   * A session completed. For a reviewer session, records the verdict its final message
   * ends with and concludes the attempt once every reviewer has reported. A session that
   * failed, or ended without a well-formed verdict, counts as failed.
   */
  async sessionCompleted(completion: {
    sessionId: string;
    success: boolean;
    finalMessage: string;
  }): Promise<void> {
    const { store } = this.deps;
    const session = await store.getSession(completion.sessionId);
    if (session === null) return;
    const verdict = completion.success
      ? parseReviewVerdict(completion.finalMessage, session.nonce)
      : null;
    await store.recordSessionVerdict(
      session.sessionId,
      verdict?.verdict ?? "failed",
      verdict?.summary ??
        (completion.success
          ? "The session ended without a verdict."
          : "The session did not complete."),
      this.deps.now()
    );
    await this.concludeIfComplete(session.attemptId);
  }

  /**
   * The backstop for what completion alone cannot guarantee: an attempt whose sessions
   * all reported but whose check write failed is concluded again, one that has run past
   * its time limit is concluded as unfinished, and one whose check still cannot be
   * written long after that is given up, so it stops holding its pull request.
   */
  async recover(): Promise<void> {
    const { store, log } = this.deps;
    const now = this.deps.now();
    const cutoff = now - REVIEW_ATTEMPT_TIMEOUT_MS;
    // A conclusion claimed by a worker that died is anyone's again.
    await store.releaseStaleConclusions(now - STALE_CONCLUSION_MS);
    for (const attempt of await store.listOverdueAttempts(cutoff)) {
      try {
        if (attempt.createdAt < cutoff) {
          await store.failUnreportedSessions(
            attempt.id,
            "The session did not report within the time limit.",
            this.deps.now()
          );
        }
        if ((await store.listSessions(attempt.id)).length === 0) {
          // Its start never recorded a session, nor a check run: nothing will ever report.
          await store.supersedeAttempt(attempt.id, this.deps.now());
          continue;
        }
        await this.concludeIfComplete(attempt.id);
      } catch (error) {
        const fields = {
          attempt: attempt.id,
          pull_number: attempt.prNumber,
          head_sha: attempt.headSha,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        if (attempt.createdAt < now - REVIEW_ATTEMPT_GIVE_UP_MS) {
          // Its check run stays as it is on GitHub; a new review of the head replaces it.
          await store.abandon(attempt.id, this.deps.now());
          log.error("github_review.abandoned", fields);
        } else {
          log.error("github_review.recovery_failed", fields);
        }
      }
    }
  }

  private async concludeIfComplete(attemptId: string): Promise<void> {
    const { store } = this.deps;
    const attempt = await store.getAttempt(attemptId);
    if (attempt?.status !== "running") return;
    const sessions = await store.listSessions(attemptId);
    if (sessions.length === 0 || sessions.some((session) => session.verdict === null)) return;
    await this.conclude(attempt, sessions);
  }

  /**
   * Concludes an attempt whose sessions have all reported. Ownership comes first: only
   * the caller that claims the conclusion writes the check, and an attempt that was
   * superseded can no longer claim it.
   */
  private async conclude(attempt: ReviewAttempt, sessions: ReviewAttemptSession[]): Promise<void> {
    const { store } = this.deps;
    if (!(await store.beginConclusion(attempt.id, this.deps.now()))) return;
    let written: {
      state: CheckRunState;
      checkRunId: number;
      finished: boolean;
      approved: boolean;
      summary: string;
    };
    try {
      written = await this.writeConclusion(attempt, sessions);
    } catch (error) {
      // Nothing was decided; the recovery pass claims the conclusion again.
      await store.releaseConclusion(attempt.id);
      throw error;
    }
    const { state, checkRunId, finished, approved, summary } = written;

    // The verdict is evidence about the diff that was reviewed, whatever the check says
    // about passing here and now. An unfinished review is evidence of nothing.
    const concluded = await store.concludeAttempt(
      attempt,
      finished ? { approved, summary } : null,
      this.deps.now()
    );
    if (!concluded && (await store.getAttempt(attempt.id))?.status === "superseded") {
      // Superseded while the check was being written: what replaced it decides, and
      // this run must not be left saying otherwise. An attempt that another worker
      // concluded meanwhile keeps the check as written.
      const repository = { owner: attempt.repoOwner, name: attempt.repoName, id: attempt.repoId };
      await this.closeSuperseded(this.deps.github(repository), [{ ...attempt, checkRunId }]);
    }
    this.deps.log.info("github_review.concluded", {
      attempt: attempt.id,
      pull_number: attempt.prNumber,
      head_sha: attempt.headSha,
      conclusion: state.status === "completed" ? state.conclusion : state.status,
      superseded: !concluded,
    });
  }

  /** Decides an attempt's check state and writes it to the attempt's own check run. */
  private async writeConclusion(
    attempt: ReviewAttempt,
    sessions: ReviewAttemptSession[]
  ): Promise<{
    state: CheckRunState;
    checkRunId: number;
    finished: boolean;
    approved: boolean;
    summary: string;
  }> {
    const repository = { owner: attempt.repoOwner, name: attempt.repoName, id: attempt.repoId };
    const setting = await this.deps.mode(repository);
    // A gate turned off mid-review still closes its check, without blocking anything.
    const mode: ActiveMode = setting === "off" ? "shadow" : setting;
    const github = this.deps.github(repository);

    const LABELS = {
      approve: "approve",
      request_changes: "changes requested",
      failed: "no verdict",
    } as const;
    const summary = sessions
      .map(
        (session) =>
          `- ${getModelDisplayName(session.model)}: ${LABELS[session.verdict ?? "failed"]}. ${session.summary ?? ""}`
      )
      .join("\n");
    const finished = sessions.every((session) => session.verdict !== "failed");
    const approved = sessions.every((session) => session.verdict === "approve");

    let state: CheckRunState;
    if (!finished) {
      state = {
        status: "completed",
        conclusion: verdictConclusion(mode, false),
        output: {
          title: "The AI review did not finish",
          summary: `${summary}\n\nRe-run this check to review commit \`${short(attempt.headSha)}\` again.${modeNote(mode)}`,
        },
        reviewAction: true,
      };
    } else if (!approved) {
      state = {
        status: "completed",
        conclusion: verdictConclusion(mode, false),
        output: {
          title: "Changes requested",
          summary: `${summary}\n\nAddress the findings and re-run this check, or ask someone with write access who is not the author to comment \`@${botHandle(this.deps.botUsername)} override ${short(attempt.headSha)} <reason>\`.${modeNote(mode)}`,
        },
        reviewAction: true,
      };
    } else {
      const blocked = await this.passBlockedReason(github, attempt);
      state =
        blocked === null
          ? {
              status: "completed",
              conclusion: "success",
              output: { title: "Approved", summary: `${summary}${modeNote(mode)}` },
              reviewAction: false,
            }
          : needsReview(mode, attempt.headSha, `${summary}\n\n${blocked}`);
    }

    let checkRunId = attempt.checkRunId;
    if (checkRunId === null) {
      checkRunId = await github.createCheck(
        {
          headSha: attempt.headSha,
          externalId: reviewCheckExternalId(attempt.prNumber, attempt.id),
          startedAt: new Date(attempt.createdAt).toISOString(),
        },
        state
      );
    } else if (!(await github.updateCheck(checkRunId, state))) {
      checkRunId = null;
    }
    if (checkRunId === null) {
      throw new Error(`AI Review check could not be written for ${attempt.headSha}`);
    }
    return { state, checkRunId, finished, approved, summary };
  }

  /**
   * Why an approving attempt must not pass its commit's check, or null when it may: the
   * pull request must still be as it was reviewed, and alone on that commit.
   */
  private async passBlockedReason(
    github: GateGitHub,
    attempt: ReviewAttempt
  ): Promise<string | null> {
    const pull = await github.getPull(attempt.prNumber);
    if (pull === null) return `Could not read #${attempt.prNumber} to confirm it is unchanged.`;
    if (pull.headSha !== attempt.headSha) {
      return `Commit \`${short(attempt.headSha)}\` is no longer the head of #${attempt.prNumber}.`;
    }
    if (pull.baseRef !== attempt.baseRef) {
      return `The base branch changed from \`${attempt.baseRef}\` to \`${pull.baseRef}\` during the review.`;
    }
    if (pull.baseSha !== attempt.baseSha) {
      // The base moved on. That is fine only if the diff is still the one reviewed.
      const hash = await github.hashPullDiff(pull.baseSha, pull.headSha);
      if (hash === null || hash !== attempt.diffHash) {
        return `\`${pull.baseRef}\` moved during the review, and the pull request's diff against it could not be shown to be the one that was reviewed.`;
      }
    }
    return github.sharedHeadReason(pull);
  }

  private async livePull(github: GateGitHub, pullNumber: number): Promise<LivePull> {
    const pull = await github.getPull(pullNumber);
    if (pull === null) throw new Error(`Pull request #${pullNumber} unreadable`);
    return pull;
  }

  /** Posts a new check run on the head; it replaces any earlier AI Review run there. */
  private async postCheck(
    github: GateGitHub,
    pull: LivePull,
    state: CheckRunState
  ): Promise<number> {
    const run = {
      headSha: pull.headSha,
      externalId: reviewCheckExternalId(pull.number),
      startedAt: new Date(this.deps.now()).toISOString(),
    };
    const checkRunId = await github.createCheck(run, state);
    if (checkRunId === null) {
      throw new Error(`AI Review check could not be written for ${pull.headSha}`);
    }
    return checkRunId;
  }

  /**
   * Posts a check for a head that no review was running on when the caller looked. A
   * review may have started since; its run is then the older one and this the newer, so
   * this one is withdrawn rather than left to stand in for the review's result. Returns
   * false when it was withdrawn.
   */
  private async postUnlessReviewing(
    github: GateGitHub,
    pullKey: PullKey,
    pull: LivePull,
    state: CheckRunState
  ): Promise<boolean> {
    const checkRunId = await this.postCheck(github, pull, state);
    if (!(await this.reviewing(pullKey, pull))) return true;
    await this.closeSuperseded(github, [{ id: `posted-for-${pull.headSha}`, checkRunId }]);
    return false;
  }

  /**
   * Closes the check runs of attempts that were replaced, so none stays in progress
   * forever. Best effort: the replacing check is what decides, whatever this does.
   */
  private async closeSuperseded(
    github: GateGitHub,
    attempts: readonly Pick<ReviewAttempt, "id" | "checkRunId">[]
  ): Promise<void> {
    for (const attempt of attempts) {
      if (attempt.checkRunId === null) continue;
      if (!(await github.updateCheck(attempt.checkRunId, SUPERSEDED))) {
        this.deps.log.warn("github_review.supersede_close_failed", { attempt: attempt.id });
      }
    }
  }
}
