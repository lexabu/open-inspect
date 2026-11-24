/**
 * Hidden marker the bot puts on the last line of a COMMENT review whose verdict is
 * "approve", when it may not submit APPROVE (comment-only repositories, several
 * reviewers, its own PRs). Autofix reads it so an advisory approval is handled like a
 * real one: only a new inline thread queues a fix.
 */
export const ADVISORY_APPROVE_MARKER = "<!-- open-inspect:verdict=approve -->";
