/**
 * What a comment that calls the bot asks for, read from its text once the triggers are
 * removed (`@bot`, `/command`, or `command` at the start of a line):
 *
 * - nothing, or `review`: the default full review;
 * - one focus area, or `review <focus>`: the same review with a focus line, where the
 *   focus is an area or any free text after `review`;
 * - anything else: a request, which starts a free-form session.
 */
export const REVIEW_FOCUS_AREAS = ["security", "performance", "bugs", "tests"] as const;

export type ReviewFocusArea = (typeof REVIEW_FOCUS_AREAS)[number];

export type ReviewFocus = { kind: "area"; area: ReviewFocusArea } | { kind: "text"; text: string };

export type CommentCommand =
  { kind: "review"; focus: ReviewFocus | null } | { kind: "request"; text: string };

function focusArea(text: string): ReviewFocusArea | undefined {
  const word = text.toLowerCase();
  return REVIEW_FOCUS_AREAS.find((area) => area === word);
}

export function parseCommentCommand(text: string): CommentCommand {
  // Address punctuation left by the trigger ("npai: review", "@bot, security") does not
  // change the command; a request keeps it, so `!model` after it stays prose.
  const words = text.replace(/^[\s:,]+/, "").trim();
  if (words === "") return { kind: "review", focus: null };
  const review = /^review(?:\s+([\s\S]+))?$/i.exec(words);
  const rest = review ? (review[1] ?? "").trim() : words;
  const area = focusArea(rest);
  if (area) return { kind: "review", focus: { kind: "area", area } };
  if (!review) return { kind: "request", text: text.trim() };
  return { kind: "review", focus: rest ? { kind: "text", text: rest } : null };
}
