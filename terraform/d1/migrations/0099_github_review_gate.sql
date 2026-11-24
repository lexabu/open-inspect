-- The GitHub bot's AI Review merge gate.
--
-- Everything the gate knows is a fact in these tables. Events write facts; the check run
-- GitHub shows for a head is computed from them and written by one reconciler, so the
-- order in which events and GitHub writes happen cannot change what a head ends up showing.

-- An attempt is one review of one head commit of one pull request, by one session per
-- configured reviewer. The control plane creates the sessions and reads each session's
-- verdict when it completes.
CREATE TABLE github_review_attempts (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  -- The base the reviewers were given, and the hash of the diff against it.
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  diff_hash TEXT,
  -- running: its sessions are working. concluded: every session has reported, or the
  -- attempt ran out of time. superseded: replaced or invalidated; it is evidence of nothing.
  status TEXT NOT NULL CHECK (status IN ('running', 'concluded', 'superseded')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- A reviewer session is held by the platform: nobody can prompt it, use its sandbox or
-- change who can read it, so nobody can steer the verdict it reports.
ALTER TABLE sessions ADD COLUMN platform_held INTEGER NOT NULL DEFAULT 0;

-- At most one attempt runs per pull request: starting one is an insert that this index
-- refuses while another is running.
CREATE UNIQUE INDEX idx_github_review_attempts_running
  ON github_review_attempts (repo_id, pr_number)
  WHERE status = 'running';

CREATE INDEX idx_github_review_attempts_pull
  ON github_review_attempts (repo_id, pr_number, status, created_at);

-- One row per reviewer session of an attempt.
CREATE TABLE github_review_attempt_sessions (
  attempt_id TEXT NOT NULL REFERENCES github_review_attempts (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  -- Given to the session in its prompt and required in its verdict, so text the session
  -- merely quotes, from the pull request for example, is never read as its verdict.
  nonce TEXT NOT NULL,
  -- NULL while the session runs. 'failed' covers a session that failed, timed out or
  -- ended without a well-formed verdict.
  verdict TEXT CHECK (verdict IN ('approve', 'request_changes', 'failed')),
  summary TEXT,
  completed_at INTEGER,
  PRIMARY KEY (attempt_id, position)
);

-- One row per head commit of a pull request that the gate has seen: what its check rests
-- on, and the one check run that shows it.
CREATE TABLE github_review_heads (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  -- What the head's check rests on. At most one of these is set:
  -- a review of this very head (running or concluded),
  attempt_id TEXT REFERENCES github_review_attempts (id),
  -- a concluded review of an earlier head whose diff is the same,
  carried_attempt_id TEXT REFERENCES github_review_attempts (id),
  -- or a person's override of this commit, with the base and diff it was given for.
  override_by TEXT,
  override_reason TEXT,
  override_base_ref TEXT,
  override_base_sha TEXT,
  override_diff_hash TEXT,
  -- Why the head needs a review, when it rests on nothing.
  note TEXT,
  -- The head's one check run; created once, then only updated.
  check_run_id INTEGER,
  -- Bumped by every fact written about the head. The reconciler records the version and
  -- the state it published; a head whose version is ahead of that is dirty.
  version INTEGER NOT NULL DEFAULT 1,
  published_version INTEGER,
  published_state TEXT,
  -- The state a reconciler set out to write, from before it calls GitHub until the write
  -- is on record. While it is set, what GitHub shows is not known, and published_state is
  -- not trusted.
  pending_state TEXT,
  -- GitHub may be showing a pass: one was written, or set out to be written, and no
  -- other state has been recorded since. Such a head is retried until it is in line.
  remote_may_pass INTEGER NOT NULL DEFAULT 0,
  -- Held by the one reconciler writing the head's check run; expires if it dies.
  lease_token TEXT,
  lease_until INTEGER,
  -- The recovery pass leaves the head alone until then, after a failed attempt.
  retry_at INTEGER,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pr_number, head_sha)
);
