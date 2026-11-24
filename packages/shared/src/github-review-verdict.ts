import { z } from "zod";

/**
 * Hidden marker the bot puts on the last line of a COMMENT review whose verdict is
 * "approve", when it may not submit APPROVE (comment-only repositories, several
 * reviewers, its own PRs). Autofix reads it so an advisory approval is handled like a
 * real one: only a new inline thread queues a fix.
 */
export const ADVISORY_APPROVE_MARKER = "<!-- open-inspect:verdict=approve -->";

/**
 * The verdict a merge-gate reviewer reports to the platform, as the last thing in the last
 * message of its session. The AI Review check reads this and nothing else: a GitHub review body
 * can be edited, copied or written by another session, a reviewer session's own final message
 * cannot.
 */
export const reviewVerdictSchema = z.strictObject({
  verdict: z.enum(["approve", "request_changes"]),
  /** One or two sentences shown on the check. */
  summary: z.string().trim().min(1).max(1_000),
});

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

const VERDICT_FENCE = "```json";

/** What the review prompt tells a merge-gate reviewer to end with. */
export const REVIEW_VERDICT_INSTRUCTIONS = `After you have submitted the review, end your final message with your verdict as a JSON code
block and write nothing after it. The AI Review check on this pull request reads only this block:

${VERDICT_FENCE}
{"verdict": "approve", "summary": "<one or two sentences>"}
\`\`\`

Use "approve" only if the code can merge as it is, otherwise "request_changes". The verdict must
agree with the review you submitted.`;

/**
 * The verdict at the end of a reviewer session's final message, or null when the message does
 * not end with one well-formed verdict block.
 */
export function parseReviewVerdict(finalMessage: string): ReviewVerdict | null {
  const text = finalMessage.trimEnd();
  const start = text.lastIndexOf(VERDICT_FENCE);
  if (start === -1 || !text.endsWith("```") || text.length < start + VERDICT_FENCE.length + 3) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start + VERDICT_FENCE.length, -3));
  } catch {
    return null;
  }
  const parsed = reviewVerdictSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
