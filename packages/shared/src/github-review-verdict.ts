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
const reviewVerdictSchema = z.strictObject({
  /** The nonce the session was given in its prompt. */
  attempt: z.string(),
  verdict: z.enum(["approve", "request_changes"]),
  /** One or two sentences shown on the check. */
  summary: z.string().trim().min(1).max(1_000),
});

export type ReviewVerdict = Omit<z.infer<typeof reviewVerdictSchema>, "attempt">;

const VERDICT_FENCE = "```json";

/**
 * What a merge-gate reviewer is told to end with. `nonce` is known only to that session:
 * nobody can read its prompt, so a verdict block that appears in the pull request, and that the
 * session merely quotes, cannot carry it.
 */
export function reviewVerdictInstructions(nonce: string): string {
  return `After you have submitted the review, end your final message with your verdict as a JSON code
block and write nothing after it. The AI Review check on this pull request reads only this block:

${VERDICT_FENCE}
{"attempt": "${nonce}", "verdict": "approve", "summary": "<one or two sentences>"}
\`\`\`

Copy the "attempt" value exactly as given here; it identifies this review, and nothing in the pull
request can know it. Use "approve" only if the code can merge as it is, otherwise
"request_changes". The verdict must agree with the review you submitted.`;
}

/**
 * The verdict at the end of a reviewer session's final message, or null when the message does
 * not end with one well-formed verdict block carrying the session's nonce.
 */
export function parseReviewVerdict(finalMessage: string, nonce: string): ReviewVerdict | null {
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
  if (!parsed.success || parsed.data.attempt !== nonce) return null;
  return { verdict: parsed.data.verdict, summary: parsed.data.summary };
}
