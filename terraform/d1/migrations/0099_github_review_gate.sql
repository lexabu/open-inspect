-- The GitHub bot's AI Review merge gate.
--
-- An attempt is one review of one head commit of one pull request, by one session per
-- configured reviewer. The control plane owns it end to end: it creates the sessions,
-- reads each session's verdict when it completes, and writes the check run.
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
  -- The attempt's own check run; NULL until GitHub has created it.
  check_run_id INTEGER,
  -- running: its sessions are working. concluding: one worker owns the conclusion and is
  -- writing the check. concluded, superseded: done. abandoned: its check could not be
  -- written for too long, and it was given up so it stops holding the pull request.
  status TEXT NOT NULL
    CHECK (status IN ('running', 'concluding', 'concluded', 'superseded', 'abandoned')),
  created_at INTEGER NOT NULL,
  -- When the conclusion was claimed; a claim left by a worker that died is released.
  concluding_at INTEGER,
  finished_at INTEGER
);

-- A reviewer session is held by the platform: nobody can prompt it, use its sandbox or
-- change who can read it, so nobody can steer the verdict it reports.
ALTER TABLE sessions ADD COLUMN platform_held INTEGER NOT NULL DEFAULT 0;

-- At most one attempt is active per pull request: starting one is an insert that this
-- index refuses while another is running or concluding.
CREATE UNIQUE INDEX idx_github_review_attempts_active
  ON github_review_attempts (repo_id, pr_number)
  WHERE status IN ('running', 'concluding');

CREATE INDEX idx_github_review_attempts_status ON github_review_attempts (status, created_at);

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

-- The last verdict on a pull request: the evidence a later head with the same diff
-- carries forward. Kept for as long as the pull request can use it; attempts are never
-- deleted, so a verdict's attempt always outlives it.
CREATE TABLE github_review_verdicts (
  repo_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  -- The head the verdict applies to, and the commit that was reviewed or overridden.
  sha TEXT NOT NULL,
  reviewed_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  diff_hash TEXT,
  approved INTEGER NOT NULL,
  summary TEXT NOT NULL,
  -- NULL for a human override.
  attempt_id TEXT REFERENCES github_review_attempts (id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pr_number)
);
