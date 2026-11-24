import { z } from "zod";
import type { SqlDatabase } from "../db/sql-database";

const attemptRowSchema = z
  .object({
    id: z.string(),
    repo_owner: z.string(),
    repo_name: z.string(),
    repo_id: z.number(),
    pr_number: z.number(),
    head_sha: z.string(),
    base_ref: z.string(),
    base_sha: z.string(),
    diff_hash: z.string().nullable(),
    check_run_id: z.number().nullable(),
    status: z.enum(["running", "concluding", "concluded", "superseded", "abandoned"]),
    created_at: z.number(),
  })
  .transform((row) => ({
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoId: row.repo_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    diffHash: row.diff_hash,
    checkRunId: row.check_run_id,
    status: row.status,
    createdAt: row.created_at,
  }));
/** One review of one head commit of one pull request. */
export type ReviewAttempt = z.infer<typeof attemptRowSchema>;

const reviewerVerdictSchema = z.enum(["approve", "request_changes", "failed"]);
/** `failed`: the session failed, timed out or ended without a well-formed verdict. */
export type ReviewerVerdict = z.infer<typeof reviewerVerdictSchema>;

const attemptSessionRowSchema = z
  .object({
    attempt_id: z.string(),
    position: z.number(),
    session_id: z.string(),
    model: z.string(),
    nonce: z.string(),
    verdict: reviewerVerdictSchema.nullable(),
    summary: z.string().nullable(),
  })
  .transform((row) => ({
    attemptId: row.attempt_id,
    position: row.position,
    sessionId: row.session_id,
    model: row.model,
    nonce: row.nonce,
    verdict: row.verdict,
    summary: row.summary,
  }));
export type ReviewAttemptSession = z.infer<typeof attemptSessionRowSchema>;

const verdictRowSchema = z
  .object({
    sha: z.string(),
    reviewed_sha: z.string(),
    base_ref: z.string(),
    base_sha: z.string(),
    diff_hash: z.string().nullable(),
    approved: z.number(),
    summary: z.string(),
    attempt_id: z.string().nullable(),
    updated_at: z.number(),
  })
  .transform((row) => ({
    sha: row.sha,
    reviewedSha: row.reviewed_sha,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    diffHash: row.diff_hash,
    approved: row.approved === 1,
    summary: row.summary,
    attemptId: row.attempt_id,
    updatedAt: row.updated_at,
  }));
/** The last verdict on a pull request, which a later head with the same diff carries forward. */
export type PullVerdict = z.infer<typeof verdictRowSchema>;

export interface PullKey {
  repoId: number;
  prNumber: number;
}

/** An attempt that still holds its pull request: its sessions are working, or it is concluding. */
const ACTIVE = "status IN ('running', 'concluding')";
const SESSION_COLUMNS = "attempt_id, position, session_id, model, nonce, verdict, summary";

const ATTEMPT_COLUMNS =
  "id, repo_owner, repo_name, repo_id, pr_number, head_sha, base_ref, base_sha, diff_hash, check_run_id, status, created_at";

/**
 * Review attempts and pull request verdicts. Every transition is one conditional
 * statement or one atomic batch, so concurrent starts, conclusions and overrides
 * cannot interleave: the database decides which one happened.
 */
export class ReviewGateStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Starts an attempt unless one is already active on the same head. An active attempt
   * on another head is superseded in the same transaction. Returns whether the claim
   * succeeded and the attempts it superseded.
   */
  async claimAttempt(
    attempt: Omit<ReviewAttempt, "status" | "checkRunId" | "createdAt">,
    now: number
  ): Promise<{ claimed: boolean; superseded: ReviewAttempt[] }> {
    const [, inserted] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE repo_id = ? AND pr_number = ? AND ${ACTIVE} AND head_sha != ?`
        )
        .bind(now, attempt.repoId, attempt.prNumber, attempt.headSha),
      this.db
        .prepare(
          `INSERT INTO github_review_attempts
             (id, repo_owner, repo_name, repo_id, pr_number, head_sha, base_ref, base_sha,
              diff_hash, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?
           WHERE NOT EXISTS (
             SELECT 1 FROM github_review_attempts
             WHERE repo_id = ? AND pr_number = ? AND ${ACTIVE}
           )`
        )
        .bind(
          attempt.id,
          attempt.repoOwner,
          attempt.repoName,
          attempt.repoId,
          attempt.prNumber,
          attempt.headSha,
          attempt.baseRef,
          attempt.baseSha,
          attempt.diffHash,
          now,
          attempt.repoId,
          attempt.prNumber
        ),
    ]);
    return {
      claimed: inserted.meta.changes === 1,
      superseded: await this.supersededAt(attempt, now),
    };
  }

  /**
   * Supersedes one attempt, if it is still active. Returns whether this call did: false
   * means something else superseded or concluded it first.
   */
  async supersedeAttempt(attemptId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
         WHERE id = ? AND ${ACTIVE}`
      )
      .bind(now, attemptId)
      .run();
    return result.meta.changes === 1;
  }

  private supersedeStatement(pull: PullKey, now: number) {
    return this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
         WHERE repo_id = ? AND pr_number = ? AND ${ACTIVE}`
      )
      .bind(now, pull.repoId, pull.prNumber);
  }

  private async supersededAt(pull: PullKey, now: number): Promise<ReviewAttempt[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts
         WHERE repo_id = ? AND pr_number = ? AND status = 'superseded' AND finished_at = ?`
      )
      .bind(pull.repoId, pull.prNumber, now)
      .all();
    return rows.results.map((row) => attemptRowSchema.parse(row));
  }

  /** Records the sessions of an attempt, in reviewer order. */
  async addSessions(
    attemptId: string,
    sessions: readonly { sessionId: string; model: string; nonce: string }[]
  ): Promise<void> {
    await this.db.batch(
      sessions.map((session, position) =>
        this.db
          .prepare(
            `INSERT INTO github_review_attempt_sessions
               (attempt_id, position, session_id, model, nonce)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(attemptId, position, session.sessionId, session.model, session.nonce)
      )
    );
  }

  async setCheckRun(attemptId: string, checkRunId: number): Promise<void> {
    await this.db
      .prepare("UPDATE github_review_attempts SET check_run_id = ? WHERE id = ?")
      .bind(checkRunId, attemptId)
      .run();
  }

  async getAttempt(attemptId: string): Promise<ReviewAttempt | null> {
    const row = await this.db
      .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts WHERE id = ?`)
      .bind(attemptId)
      .first();
    return row ? attemptRowSchema.parse(row) : null;
  }

  async getActiveAttempt(pull: PullKey): Promise<ReviewAttempt | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts
         WHERE repo_id = ? AND pr_number = ? AND ${ACTIVE}`
      )
      .bind(pull.repoId, pull.prNumber)
      .first();
    return row ? attemptRowSchema.parse(row) : null;
  }

  async listSessions(attemptId: string): Promise<ReviewAttemptSession[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM github_review_attempt_sessions WHERE attempt_id = ? ORDER BY position`
      )
      .bind(attemptId)
      .all();
    return rows.results.map((row) => attemptSessionRowSchema.parse(row));
  }

  /** The reviewer session with this id, or null when it is not a reviewer session. */
  async getSession(sessionId: string): Promise<ReviewAttemptSession | null> {
    const row = await this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM github_review_attempt_sessions WHERE session_id = ?`)
      .bind(sessionId)
      .first();
    return row ? attemptSessionRowSchema.parse(row) : null;
  }

  /**
   * Records a session's verdict, once: a session reports when it completes, and a second
   * report for the same session changes nothing.
   */
  async recordSessionVerdict(
    sessionId: string,
    verdict: ReviewerVerdict,
    summary: string,
    now: number
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_attempt_sessions SET verdict = ?, summary = ?, completed_at = ?
         WHERE session_id = ? AND verdict IS NULL`
      )
      .bind(verdict, summary, now, sessionId)
      .run();
  }

  /** Marks every session of an attempt that has not reported as failed. */
  async failUnreportedSessions(attemptId: string, summary: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_attempt_sessions SET verdict = 'failed', summary = ?, completed_at = ?
         WHERE attempt_id = ? AND verdict IS NULL`
      )
      .bind(summary, now, attemptId)
      .run();
  }

  /**
   * Takes ownership of an attempt's conclusion: of any number of workers, and against an
   * override or a newer attempt, exactly one gets true, and only it may write the check.
   */
  async beginConclusion(attemptId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'concluding', concluding_at = ?
         WHERE id = ? AND status = 'running'`
      )
      .bind(now, attemptId)
      .run();
    return result.meta.changes === 1;
  }

  /** Gives a claimed conclusion back, so it can be tried again: the check was not written. */
  async releaseConclusion(attemptId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'running', concluding_at = NULL
         WHERE id = ? AND status = 'concluding'`
      )
      .bind(attemptId)
      .run();
  }

  /** Releases conclusions claimed before `claimedBefore`: their worker died mid-way. */
  async releaseStaleConclusions(claimedBefore: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'running', concluding_at = NULL
         WHERE status = 'concluding' AND concluding_at < ?`
      )
      .bind(claimedBefore)
      .run();
  }

  /**
   * Finishes a claimed conclusion and, in the same transaction, stores the verdict it
   * reached. Returns false when the attempt lost ownership while its check was being
   * written: an override, a base change or a newer attempt superseded it, and that stands.
   */
  async concludeAttempt(
    attempt: ReviewAttempt,
    verdict: { approved: boolean; summary: string } | null,
    now: number
  ): Promise<boolean> {
    const conclude = this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'concluded', finished_at = ?
         WHERE id = ? AND status = 'concluding'`
      )
      .bind(now, attempt.id);
    if (verdict === null) return (await conclude.run()).meta.changes === 1;

    const [concluded] = await this.db.batch([
      conclude,
      // Only the attempt this very transaction concluded writes its verdict.
      this.db
        .prepare(
          `INSERT INTO github_review_verdicts
             (repo_id, pr_number, sha, reviewed_sha, base_ref, base_sha, diff_hash, approved,
              summary, attempt_id, updated_at)
           SELECT repo_id, pr_number, head_sha, head_sha, base_ref, base_sha, diff_hash, ?, ?, id, ?
           FROM github_review_attempts
           WHERE id = ? AND status = 'concluded' AND finished_at = ?
           ON CONFLICT (repo_id, pr_number) DO UPDATE SET
             sha = excluded.sha, reviewed_sha = excluded.reviewed_sha,
             base_ref = excluded.base_ref, base_sha = excluded.base_sha,
             diff_hash = excluded.diff_hash, approved = excluded.approved,
             summary = excluded.summary, attempt_id = excluded.attempt_id,
             updated_at = excluded.updated_at`
        )
        .bind(verdict.approved ? 1 : 0, verdict.summary, now, attempt.id, now),
    ]);
    return concluded.meta.changes === 1;
  }

  async getVerdict(pull: PullKey): Promise<PullVerdict | null> {
    const row = await this.db
      .prepare(
        `SELECT sha, reviewed_sha, base_ref, base_sha, diff_hash, approved, summary, attempt_id,
                updated_at
         FROM github_review_verdicts WHERE repo_id = ? AND pr_number = ?`
      )
      .bind(pull.repoId, pull.prNumber)
      .first();
    return row ? verdictRowSchema.parse(row) : null;
  }

  /**
   * Moves a verdict to a new head that it still covers. Refused when the verdict changed
   * since it was read: a conclusion or an override in between must not be carried over.
   */
  async carryVerdict(pull: PullKey, read: PullVerdict, sha: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_verdicts SET sha = ?, updated_at = ?
         WHERE repo_id = ? AND pr_number = ? AND updated_at = ? AND reviewed_sha = ?`
      )
      .bind(sha, now, pull.repoId, pull.prNumber, read.updatedAt, read.reviewedSha)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Drops everything a pull request's review state rests on: its verdict, and its running
   * attempt, which is superseded and returned.
   */
  async invalidate(pull: PullKey, now: number): Promise<ReviewAttempt[]> {
    await this.db.batch([
      this.supersedeStatement(pull, now),
      this.db
        .prepare("DELETE FROM github_review_verdicts WHERE repo_id = ? AND pr_number = ?")
        .bind(pull.repoId, pull.prNumber),
    ]);
    return this.supersededAt(pull, now);
  }

  /**
   * Stores a human override as the pull request's verdict and supersedes the attempt on
   * the overridden commit, which is returned: a review of that commit still in flight can
   * no longer change the outcome. A review of another head is not the override's business.
   */
  async override(
    pull: PullKey,
    verdict: Pick<PullVerdict, "sha" | "baseRef" | "baseSha" | "diffHash" | "summary">,
    now: number
  ): Promise<ReviewAttempt[]> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE repo_id = ? AND pr_number = ? AND head_sha = ? AND ${ACTIVE}`
        )
        .bind(now, pull.repoId, pull.prNumber, verdict.sha),
      this.db
        .prepare(
          `INSERT INTO github_review_verdicts
             (repo_id, pr_number, sha, reviewed_sha, base_ref, base_sha, diff_hash, approved,
              summary, attempt_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
           ON CONFLICT (repo_id, pr_number) DO UPDATE SET
             sha = excluded.sha, reviewed_sha = excluded.reviewed_sha,
             base_ref = excluded.base_ref, base_sha = excluded.base_sha,
             diff_hash = excluded.diff_hash, approved = 1, summary = excluded.summary,
             attempt_id = NULL, updated_at = excluded.updated_at`
        )
        .bind(
          pull.repoId,
          pull.prNumber,
          verdict.sha,
          verdict.sha,
          verdict.baseRef,
          verdict.baseSha,
          verdict.diffHash,
          verdict.summary,
          now
        ),
    ]);
    return this.supersededAt(pull, now);
  }

  /**
   * Gives an attempt up: its check could not be written for too long. It no longer holds
   * the pull request, so a new review can start.
   */
  async abandon(attemptId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_attempts SET status = 'abandoned', finished_at = ?
         WHERE id = ? AND ${ACTIVE}`
      )
      .bind(now, attemptId)
      .run();
  }

  /**
   * Running attempts the recovery pass must look at: every session has reported but the
   * attempt was not concluded (a failed check write), or it has run past `startedBefore`.
   */
  async listOverdueAttempts(startedBefore: number): Promise<ReviewAttempt[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts a
         WHERE a.status = 'running'
           AND (a.created_at < ?
                OR (EXISTS (SELECT 1 FROM github_review_attempt_sessions s
                            WHERE s.attempt_id = a.id)
                    AND NOT EXISTS (SELECT 1 FROM github_review_attempt_sessions s
                                    WHERE s.attempt_id = a.id AND s.verdict IS NULL)))
         ORDER BY a.created_at LIMIT 50`
      )
      .bind(startedBefore)
      .all();
    return rows.results.map((row) => attemptRowSchema.parse(row));
  }
}
