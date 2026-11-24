/**
 * The `AI Review` merge gate: one check run on a pull request's head commit that says
 * whether the platform's reviewers reviewed, and approved, exactly that commit.
 *
 * A review is an attempt: one platform-held session per configured reviewer. Each
 * session ends its last message with a verdict, which the platform reads from the
 * session itself when it completes. Nothing reviews on push: a new head asks for a
 * review, unless the pull request's own diff is unchanged, in which case the last
 * verdict carries forward.
 *
 * Every event here does the same two things: it records a fact in the database, then
 * asks the reconciler to bring the head's check in line with the facts. No event writes
 * a check itself, so the order in which events arrive cannot decide what a head shows.
 */
import { parseReviewVerdict } from "@open-inspect/shared/github-review-verdict";
import type {
  GateOverrideRequest,
  GateOverrideResponse,
  GatePullChangeRequest,
  GatePullChangeResponse,
  StartGateReviewRequest,
  StartGateReviewResponse,
} from "@open-inspect/shared/types/github-review-gate";
import { generateId } from "../auth/crypto";
import type { GateGitHub, LivePull } from "./github";
import { Reconciler, type GateRepository, type ReconcilerDeps } from "./reconcile";
import type { HeadRef, PullKey } from "./store";

export type { GateRepository } from "./reconcile";

/** An attempt whose sessions have not all reported after this long is concluded as unfinished. */
export const REVIEW_ATTEMPT_TIMEOUT_MS = 90 * 60 * 1000;

/** A head whose check still cannot be written this long after its last fact is given up. */
export const REVIEW_HEAD_GIVE_UP_MS = 2 * REVIEW_ATTEMPT_TIMEOUT_MS;

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

export type ReviewGateDeps = ReconcilerDeps;

const short = (sha: string) => sha.slice(0, 7);

export class ReviewGate {
  private readonly reconciler: Reconciler;

  constructor(private readonly deps: ReviewGateDeps) {
    this.reconciler = new Reconciler(deps);
  }

  /** Starts a review of the pull request's head, unless one is already running on it. */
  async start(
    request: StartGateReviewRequest,
    repository: GateRepository,
    sessions: GateSessions
  ): Promise<StartGateReviewResponse> {
    const { store, log } = this.deps;
    if ((await this.deps.mode(repository)) === "off") {
      return { outcome: "skipped", reason: "merge_gate_off" };
    }
    const github = this.deps.github(repository);
    const pull = await this.livePull(github, request.pullNumber);
    if (!pull.open) return { outcome: "skipped", reason: "pr_not_open" };
    if (pull.draft) return { outcome: "skipped", reason: "draft_pr" };
    if (pull.headSha !== request.headSha) return { outcome: "skipped", reason: "stale_head" };
    // The prompts name a base; a pull request retargeted since they were written would
    // be reviewed against one branch and recorded against another.
    if (pull.baseRef !== request.base.ref) return { outcome: "skipped", reason: "stale_base" };

    const head = headRef(repository, pull);
    const attempt = {
      id: generateId(),
      ...head,
      // The base the reviewers are given, not the live one: the branch may have moved on
      // since the prompts were written, and a pass is checked against this.
      baseRef: request.base.ref,
      baseSha: request.base.sha,
      diffHash: await github.hashPullDiff(request.base.sha, pull.headSha),
    };
    // The claim is the serialization point: of two starts, the database admits one.
    if (!(await store.claimAttempt(attempt, this.deps.now()))) {
      return { outcome: "skipped", reason: "review_in_progress" };
    }

    let started: { sessionId: string; messageId: string; model: string }[];
    try {
      const created = [];
      for (const reviewer of request.reviewers) {
        const sessionId = await sessions.create(reviewer);
        created.push({ reviewer, sessionId, nonce: generateId() });
      }
      // On record before any session is prompted, so none can report unseen.
      await store.addSessions(
        attempt.id,
        created.map(({ reviewer, sessionId, nonce }) => ({
          sessionId,
          model: reviewer.model,
          nonce,
        }))
      );
      started = await Promise.all(
        created.map(async ({ reviewer, sessionId, nonce }) => ({
          sessionId,
          messageId: await sessions.prompt(sessionId, reviewer, nonce),
          model: reviewer.model,
        }))
      );
    } catch (error) {
      // A review that did not fully start decides nothing; a session that did start
      // reports into a superseded attempt.
      await store.supersedeAttempt(
        attempt.id,
        "The AI review could not be started.",
        this.deps.now()
      );
      await this.reconcileDirty(head);
      throw error;
    }

    await this.reconcileDirty(head);
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
    if ((await this.deps.mode(repository)) === "off") {
      return { outcome: "skipped", reason: "merge_gate_off" };
    }
    const pullKey = { repoId: repository.id, prNumber: request.pullNumber };
    const invalidation =
      request.change === "base"
        ? "The base branch changed."
        : request.change === "reopened"
          ? "The pull request was reopened."
          : null;
    // Recorded before anything is asked of GitHub: whatever was reviewed, or is being
    // reviewed, was reviewed against another base branch or before the pull request was
    // closed, and none of it may pass later because a GitHub call failed now.
    if (invalidation !== null) await store.invalidatePull(pullKey, invalidation, this.deps.now());

    const github = this.deps.github(repository);
    // Deliveries arrive out of order and late; act on the pull request as it is now.
    const pull = await this.livePull(github, request.pullNumber);
    if (!pull.open) return { outcome: "skipped", reason: "pr_not_open" };
    if (pull.draft) return { outcome: "skipped", reason: "draft_pr" };
    if (invalidation === null && pull.headSha !== request.headSha) {
      return { outcome: "skipped", reason: "stale_head" };
    }

    const head = headRef(repository, pull);
    const note =
      invalidation ??
      (request.change === "review_not_started"
        ? `The AI review did not start (${request.detail ?? "unknown reason"}).`
        : "No AI review covers this diff.");
    await store.ensureHead(head, note, this.deps.now());
    if (request.change === "review_not_started") {
      await store.setNote(head, note, this.deps.now());
    } else if (request.change === "head") {
      await this.carryForward(github, head, pull);
    }
    await this.reconcileDirty(head);

    // What the head rests on now, which a review started meanwhile may have changed.
    const evidence = (await store.getHead(head))?.evidence.kind;
    if (evidence === "carried") return { outcome: "carried_forward" };
    if (evidence === "review" || evidence === "override") {
      return { outcome: "skipped", reason: "already_covered" };
    }
    return { outcome: "needs_review" };
  }

  /**
   * Makes a new head rest on the pull request's last review when its diff, against the
   * same base branch, is the one that was reviewed. Whether an approval may then pass
   * here is the reconciler's question, as for any pass.
   */
  private async carryForward(github: GateGitHub, head: HeadRef, pull: LivePull): Promise<void> {
    const { store } = this.deps;
    const source = await store.findCarrySource(head);
    if (source === null || source.headSha === head.headSha) return;
    if (source.diffHash === null || source.baseRef !== pull.baseRef) return;
    if ((await github.hashPullDiff(pull.baseSha, pull.headSha)) !== source.diffHash) return;
    await store.carry(head, source.id, this.deps.now());
    this.deps.log.info("github_review.carried_forward", {
      pull_number: pull.number,
      head_sha: pull.headSha,
      reviewed_sha: source.headSha,
    });
  }

  /** A human passes the head's check, on the record. The caller has checked their access. */
  async override(
    request: GateOverrideRequest,
    repository: GateRepository
  ): Promise<GateOverrideResponse> {
    if ((await this.deps.mode(repository)) === "off") {
      return { outcome: "refused", reason: "merge_gate_off", detail: "" };
    }
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

    const head = headRef(repository, pull);
    // Bound to the pull request as it was just validated: an override passes that base
    // and that diff, not whatever the pull request has become by the time it is written.
    const given = {
      baseRef: pull.baseRef,
      baseSha: pull.baseSha,
      diffHash: await github.hashPullDiff(pull.baseSha, pull.headSha),
    };
    await this.deps.store.override(
      head,
      { by: request.overriddenBy, reason: request.reason, given },
      this.deps.now()
    );
    await this.reconcileDirty(head);
    this.deps.log.info("github_review.overridden", {
      pull_number: pull.number,
      head_sha: pull.headSha,
      overridden_by: request.overriddenBy,
    });
    return { outcome: "overridden", headSha: pull.headSha };
  }

  /**
   * A session completed. For a reviewer session, records the verdict its final message
   * ends with; the attempt concludes once every reviewer has reported. A session that
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
      session,
      verdict?.verdict ?? "failed",
      verdict?.summary ??
        (completion.success
          ? "The session ended without a verdict."
          : "The session did not complete."),
      this.deps.now()
    );
    const attempt = await store.getAttempt(session.attemptId);
    if (attempt !== null) await this.reconcileDirty(attempt);
  }

  /**
   * The backstop for what events alone cannot guarantee: an attempt whose sessions never
   * reported is concluded as unfinished, and every head whose check is behind its facts
   * (a GitHub write failed, a worker died) is reconciled again.
   */
  async recover(): Promise<void> {
    const now = this.deps.now();
    await this.deps.store.expireAttempts(
      now - REVIEW_ATTEMPT_TIMEOUT_MS,
      "The session did not report within the time limit.",
      now
    );
    await this.reconcileDirty();
  }

  /**
   * Reconciles every head that is behind its facts: of one pull request after an event
   * (the event's own head, and any other its fact touched, such as the one a newer
   * review replaced), or of all in the recovery pass. A failure is logged and left to
   * the next pass: the facts are already on record.
   */
  private async reconcileDirty(pull?: PullKey): Promise<void> {
    const now = this.deps.now();
    const dirty = await this.deps.store.listDirtyHeads(now, now - REVIEW_HEAD_GIVE_UP_MS, pull);
    for (const head of dirty) {
      try {
        await this.reconciler.reconcile(head);
      } catch (error) {
        await this.deps.store.deferRetry(head, this.deps.now());
        this.deps.log.error("github_review.reconcile_failed", {
          pull_number: head.prNumber,
          head_sha: head.headSha,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  private async livePull(github: GateGitHub, pullNumber: number): Promise<LivePull> {
    const pull = await github.getPull(pullNumber);
    if (pull === null) throw new Error(`Pull request #${pullNumber} unreadable`);
    return pull;
  }
}

function headRef(repository: GateRepository, pull: LivePull): HeadRef {
  return {
    repoOwner: repository.owner,
    repoName: repository.name,
    repoId: repository.id,
    prNumber: pull.number,
    headSha: pull.headSha,
  };
}
