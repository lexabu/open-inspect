import { z } from "zod";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

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
    status: z.enum(["running", "concluded", "superseded"]),
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
    session_id: z.string(),
    model: z.string(),
    nonce: z.string(),
    verdict: reviewerVerdictSchema.nullable(),
    summary: z.string().nullable(),
  })
  .transform((row) => ({
    attemptId: row.attempt_id,
    sessionId: row.session_id,
    model: row.model,
    nonce: row.nonce,
    verdict: row.verdict,
    summary: row.summary,
  }));
export type ReviewAttemptSession = z.infer<typeof attemptSessionRowSchema>;

const headRowSchema = z
  .object({
    repo_id: z.number(),
    pr_number: z.number(),
    head_sha: z.string(),
    repo_owner: z.string(),
    repo_name: z.string(),
    attempt_id: z.string().nullable(),
    carried_attempt_id: z.string().nullable(),
    override_by: z.string().nullable(),
    override_reason: z.string().nullable(),
    note: z.string().nullable(),
    check_run_id: z.number().nullable(),
    version: z.number(),
    published_state: z.string().nullable(),
  })
  .transform((row) => ({
    repoId: row.repo_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    /** What the head's check rests on; `none` carries why it needs a review. */
    evidence:
      row.override_by !== null
        ? ({ kind: "override", by: row.override_by, reason: row.override_reason ?? "" } as const)
        : row.attempt_id !== null
          ? ({ kind: "review", attemptId: row.attempt_id } as const)
          : row.carried_attempt_id !== null
            ? ({ kind: "carried", attemptId: row.carried_attempt_id } as const)
            : ({ kind: "none", note: row.note } as const),
    checkRunId: row.check_run_id,
    version: row.version,
    publishedState: row.published_state,
  }));
/** A head commit of a pull request as the gate knows it. */
export type ReviewHead = z.infer<typeof headRowSchema>;

export interface PullKey {
  repoId: number;
  prNumber: number;
}
export interface HeadKey extends PullKey {
  headSha: string;
}
/** A head with the names its repository goes by, as needed to create its row. */
export interface HeadRef extends HeadKey {
  repoOwner: string;
  repoName: string;
}

const ATTEMPT_COLUMNS =
  "id, repo_owner, repo_name, repo_id, pr_number, head_sha, base_ref, base_sha, diff_hash, status, created_at";
const SESSION_COLUMNS = "attempt_id, session_id, model, nonce, verdict, summary";
const HEAD_COLUMNS =
  "repo_id, pr_number, head_sha, repo_owner, repo_name, attempt_id, carried_attempt_id, override_by, override_reason, note, check_run_id, version, published_state";
const HEAD_KEY = "repo_id = ? AND pr_number = ? AND head_sha = ?";
/** A head that rests on nothing yet: no review, no carried verdict, no override. */
const NO_EVIDENCE = "attempt_id IS NULL AND carried_attempt_id IS NULL AND override_by IS NULL";
/** Every fact written about a head bumps its version, which is what makes it dirty. */
const TOUCH = "version = version + 1, changed_at = ?";

/**
 * The facts of the AI Review gate. Every method is one conditional statement or one
 * atomic batch, so concurrent events cannot interleave: the database decides what
 * happened. Nothing here talks to GitHub.
 */
export class ReviewGateStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Starts an attempt on a head unless one is already running on it, and makes it what
   * the head rests on. An attempt running on another head of the pull request is
   * superseded in the same transaction. Returns whether the attempt was started.
   */
  async claimAttempt(
    attempt: Omit<ReviewAttempt, "status" | "createdAt">,
    now: number
  ): Promise<boolean> {
    const pull = [attempt.repoId, attempt.prNumber];
    const [, , inserted] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_heads
           SET attempt_id = NULL, note = 'A review of a newer commit replaced the one of this commit.', ${TOUCH}
           WHERE repo_id = ? AND pr_number = ? AND head_sha != ? AND attempt_id IN (
             SELECT id FROM github_review_attempts
             WHERE repo_id = ? AND pr_number = ? AND status = 'running')`
        )
        .bind(now, ...pull, attempt.headSha, ...pull),
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE repo_id = ? AND pr_number = ? AND status = 'running' AND head_sha != ?`
        )
        .bind(now, ...pull, attempt.headSha),
      this.db
        .prepare(
          `INSERT INTO github_review_attempts
             (id, repo_owner, repo_name, repo_id, pr_number, head_sha, base_ref, base_sha,
              diff_hash, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?
           WHERE NOT EXISTS (
             SELECT 1 FROM github_review_attempts
             WHERE repo_id = ? AND pr_number = ? AND status = 'running'
           )`
        )
        .bind(
          attempt.id,
          attempt.repoOwner,
          attempt.repoName,
          ...pull,
          attempt.headSha,
          attempt.baseRef,
          attempt.baseSha,
          attempt.diffHash,
          now,
          ...pull
        ),
      // Only for the attempt this very transaction started; a new review replaces a
      // carried verdict or an override of the same commit.
      this.db
        .prepare(
          `INSERT INTO github_review_heads
             (repo_id, pr_number, head_sha, repo_owner, repo_name, attempt_id, changed_at)
           SELECT repo_id, pr_number, head_sha, repo_owner, repo_name, id, ?
           FROM github_review_attempts WHERE id = ? AND status = 'running'
           ON CONFLICT (repo_id, pr_number, head_sha) DO UPDATE SET
             attempt_id = excluded.attempt_id, carried_attempt_id = NULL, override_by = NULL,
             override_reason = NULL, note = NULL, ${TOUCH}`
        )
        .bind(now, attempt.id, now),
    ]);
    return inserted.meta.changes === 1;
  }

  /**
   * Supersedes one attempt, if it is still running, and leaves the head it was reviewing
   * with a note of why it needs a review.
   */
  async supersedeAttempt(attemptId: string, note: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_heads SET attempt_id = NULL, note = ?, ${TOUCH}
           WHERE attempt_id = ? AND EXISTS (
             SELECT 1 FROM github_review_attempts WHERE id = ? AND status = 'running')`
        )
        .bind(note, now, attemptId, attemptId),
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE id = ? AND status = 'running'`
        )
        .bind(now, attemptId),
    ]);
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

  async getAttempt(attemptId: string): Promise<ReviewAttempt | null> {
    const row = await this.db
      .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts WHERE id = ?`)
      .bind(attemptId)
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
   * Records a session's verdict, once: a second report for the same session changes
   * nothing. An attempt whose sessions have then all reported is concluded.
   */
  async recordSessionVerdict(
    session: Pick<ReviewAttemptSession, "sessionId" | "attemptId">,
    verdict: ReviewerVerdict,
    summary: string,
    now: number
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempt_sessions SET verdict = ?, summary = ?, completed_at = ?
           WHERE session_id = ? AND verdict IS NULL`
        )
        .bind(verdict, summary, now, session.sessionId),
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'concluded', finished_at = ?
           WHERE id = ? AND status = 'running' AND NOT EXISTS (
             SELECT 1 FROM github_review_attempt_sessions
             WHERE attempt_id = ? AND verdict IS NULL)`
        )
        .bind(now, session.attemptId, session.attemptId),
      this.touchHeads("attempt_id = ?", now, session.attemptId),
    ]);
  }

  /**
   * Concludes every attempt that started before `startedBefore`: its sessions that have
   * not reported count as failed.
   */
  async expireAttempts(startedBefore: number, summary: string, now: number): Promise<void> {
    const expired = `SELECT id FROM github_review_attempts WHERE status = 'running' AND created_at < ?`;
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempt_sessions SET verdict = 'failed', summary = ?, completed_at = ?
           WHERE verdict IS NULL AND attempt_id IN (${expired})`
        )
        .bind(summary, now, startedBefore),
      this.touchHeads(`attempt_id IN (${expired})`, now, startedBefore),
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'concluded', finished_at = ?
           WHERE status = 'running' AND created_at < ?`
        )
        .bind(now, startedBefore),
    ]);
  }

  private touchHeads(where: string, now: number, ...bindings: unknown[]): SqlStatement {
    return this.db
      .prepare(`UPDATE github_review_heads SET ${TOUCH} WHERE ${where}`)
      .bind(now, ...bindings);
  }

  /**
   * Drops everything a pull request's checks rest on: every attempt stops being evidence,
   * and every head of the pull request is left with a note of why it needs a review.
   */
  async invalidatePull(pull: PullKey, note: string, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE repo_id = ? AND pr_number = ? AND status != 'superseded'`
        )
        .bind(now, pull.repoId, pull.prNumber),
      this.db
        .prepare(
          `UPDATE github_review_heads
           SET attempt_id = NULL, carried_attempt_id = NULL, override_by = NULL,
               override_reason = NULL, note = ?, ${TOUCH}
           WHERE repo_id = ? AND pr_number = ?`
        )
        .bind(note, now, pull.repoId, pull.prNumber),
    ]);
  }

  /** Makes sure a head has a row; a new one rests on nothing, with `note` as the reason. */
  async ensureHead(head: HeadRef, note: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO github_review_heads
           (repo_id, pr_number, head_sha, repo_owner, repo_name, note, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo_id, pr_number, head_sha) DO NOTHING`
      )
      .bind(head.repoId, head.prNumber, head.headSha, head.repoOwner, head.repoName, note, now)
      .run();
  }

  /** Says why a head needs a review, unless it rests on something by now. */
  async setNote(head: HeadKey, note: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_heads SET note = ?, ${TOUCH} WHERE ${HEAD_KEY} AND ${NO_EVIDENCE}`
      )
      .bind(note, now, head.repoId, head.prNumber, head.headSha)
      .run();
  }

  /**
   * Makes a head rest on the verdict of an earlier review, unless it rests on something
   * by now: a review of the head itself that started meanwhile takes precedence.
   */
  async carry(head: HeadKey, attemptId: string, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_heads SET carried_attempt_id = ?, note = NULL, ${TOUCH}
         WHERE ${HEAD_KEY} AND ${NO_EVIDENCE}`
      )
      .bind(attemptId, now, head.repoId, head.prNumber, head.headSha)
      .run();
  }

  /**
   * Makes a head rest on a person's override. A review of that commit still running is
   * superseded; a review of another head is not the override's business.
   */
  async override(head: HeadRef, by: string, reason: string, now: number): Promise<void> {
    const key = [head.repoId, head.prNumber, head.headSha];
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE github_review_attempts SET status = 'superseded', finished_at = ?
           WHERE repo_id = ? AND pr_number = ? AND head_sha = ? AND status = 'running'`
        )
        .bind(now, ...key),
      this.db
        .prepare(
          `INSERT INTO github_review_heads
             (repo_id, pr_number, head_sha, repo_owner, repo_name, override_by, override_reason,
              changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (repo_id, pr_number, head_sha) DO UPDATE SET
             override_by = excluded.override_by, override_reason = excluded.override_reason,
             attempt_id = NULL, carried_attempt_id = NULL, note = NULL, ${TOUCH}`
        )
        .bind(...key, head.repoOwner, head.repoName, by, reason, now, now),
    ]);
  }

  /**
   * The review a later head with the same diff may carry forward: the pull request's
   * newest concluded attempt in which every reviewer gave a verdict. An attempt that did
   * not finish is evidence of nothing, and an invalidated one is no longer evidence.
   */
  async findCarrySource(pull: PullKey): Promise<ReviewAttempt | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM github_review_attempts a
         WHERE a.repo_id = ? AND a.pr_number = ? AND a.status = 'concluded'
           AND EXISTS (SELECT 1 FROM github_review_attempt_sessions s WHERE s.attempt_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM github_review_attempt_sessions s
                           WHERE s.attempt_id = a.id AND s.verdict = 'failed')
         ORDER BY a.created_at DESC, a.id DESC LIMIT 1`
      )
      .bind(pull.repoId, pull.prNumber)
      .first();
    return row ? attemptRowSchema.parse(row) : null;
  }

  async getHead(head: HeadKey): Promise<ReviewHead | null> {
    const row = await this.db
      .prepare(`SELECT ${HEAD_COLUMNS} FROM github_review_heads WHERE ${HEAD_KEY}`)
      .bind(head.repoId, head.prNumber, head.headSha)
      .first();
    return row ? headRowSchema.parse(row) : null;
  }

  /**
   * Takes the right to write a head's check run until `until`. Of any number of
   * reconcilers, one gets true; a lease left by a worker that died expires.
   */
  async acquireLease(head: HeadKey, now: number, until: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE github_review_heads SET lease_until = ?
         WHERE ${HEAD_KEY} AND (lease_until IS NULL OR lease_until < ?)`
      )
      .bind(until, head.repoId, head.prNumber, head.headSha, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseLease(head: HeadKey): Promise<void> {
    await this.db
      .prepare(`UPDATE github_review_heads SET lease_until = NULL WHERE ${HEAD_KEY}`)
      .bind(head.repoId, head.prNumber, head.headSha)
      .run();
  }

  /** Records what was published for a version of a head, and the check run it is on. */
  async recordPublished(
    head: HeadKey,
    published: { version: number; state: string | null; checkRunId: number | null }
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_review_heads
         SET published_version = ?, published_state = ?, check_run_id = ? WHERE ${HEAD_KEY}`
      )
      .bind(
        published.version,
        published.state,
        published.checkRunId,
        head.repoId,
        head.prNumber,
        head.headSha
      )
      .run();
  }

  /**
   * Heads whose facts are ahead of what was published and that nobody is writing right
   * now, oldest first: of one pull request, or of all. A head that has been dirty since
   * before `changedAfter` is given up.
   */
  async listDirtyHeads(now: number, changedAfter: number, pull?: PullKey): Promise<HeadRef[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${HEAD_COLUMNS} FROM github_review_heads
         WHERE version > COALESCE(published_version, 0)
           AND (lease_until IS NULL OR lease_until < ?) AND changed_at > ?
           ${pull ? "AND repo_id = ? AND pr_number = ?" : ""}
         ORDER BY changed_at LIMIT 50`
      )
      .bind(now, changedAfter, ...(pull ? [pull.repoId, pull.prNumber] : []))
      .all();
    return rows.results.map((row) => headRowSchema.parse(row));
  }
}
