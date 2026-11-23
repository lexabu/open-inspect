import { fromMarkdown } from "mdast-util-from-markdown";
import { escapeRegExp } from "./regex";

/**
 * GitHub App mentions in Markdown comment bodies, for a bot login such as
 * `my-app[bot]`. People type the App's handle without the suffix (GitHub does
 * not autocomplete Apps), so `@my-app` and `@my-app[bot]` both count.
 *
 * Not a mention: text inside code, raw HTML or an inline `<code>` element, an email
 * address in any script (`me@my-app.com`), a team handle (`@my-app/team`), or a
 * longer handle that only starts with the App's name (`@my-app-other`,
 * `@my-app[bot]-clone`), including one split by an invisible format character.
 * Emphasis and footnotes may surround either form (`_@my-app_`, `@my-app[^1]`).
 */

/** The App's handle (`my-app`) from a configured login, with or without `[bot]`. */
function botHandle(botUsername: string): string {
  return botUsername.trim().replace(/\[bot\]$/i, "");
}

/**
 * Whether a GitHub login is the bot's. A configured login with or without the
 * `[bot]` suffix means the same App, whose login GitHub always reports with it,
 * so a person whose username equals the App's handle never counts as the bot.
 */
export function isBotLogin(login: string | null | undefined, botUsername: string): boolean {
  const handle = botHandle(botUsername);
  return Boolean(handle) && login?.toLowerCase() === `${handle}[bot]`.toLowerCase();
}

/** Letters, digits and marks in any script, plus invisible format characters. */
const WORD = String.raw`\p{L}\p{N}\p{M}\p{Cf}`;

function botMentionPattern(botUsername: string, flags: string): RegExp | null {
  const raw = botHandle(botUsername);
  if (!raw) return null;
  const handle = escapeRegExp(raw);
  // Not after an email's local part or a path.
  const before = String.raw`(?<![${WORD}.%+/-])`;
  // Not glued to a longer handle.
  const afterFull = String.raw`(?![${WORD}-])`;
  // The plain handle must also not start `[bot]...`, a team, an email or a domain.
  const afterPlain = String.raw`(?![${WORD}/@-]|\[(?!\^)|\.[${WORD}])`;
  return new RegExp(`${before}@${handle}(?:\\[bot\\]${afterFull}|${afterPlain})`, `${flags}u`);
}

/** Node types whose text is not prose: code blocks, inline code and raw HTML. */
const NON_PROSE = new Set(["code", "inlineCode", "html"]);

/** Inline HTML elements whose contents render as code. */
const HTML_CODE_OPEN = /^<(code|pre|kbd|samp|tt)\b[^>]*>$/i;

/**
 * Bodies longer than this are matched as plain prose without parsing: nested
 * quotes make parse time grow quadratically (about 70 ms here, 2.7 s at GitHub's
 * 65,536-character cap). A mention inside code in such a body can trigger the
 * bot, which the sender permission check still gates.
 */
const MAX_PARSED_LENGTH = 20_000;

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Prose and code segments, alternating with prose at even indexes. The body is
 * parsed as CommonMark, so code blocks inside lists or quotes, code spans (which
 * never cross a paragraph), raw HTML and inline `<code>` elements are found the
 * way GitHub renders them. The tree is walked iteratively, so deep nesting cannot
 * overflow the stack.
 */
function segments(body: string): string[] {
  if (body.length > MAX_PARSED_LENGTH) return [body];
  const ranges: Array<[number, number]> = [];
  // Opening inline code tags waiting for their closing tag, by element name.
  const openHtml = new Map<string, number>();
  const stack: MarkdownNode[] = [fromMarkdown(body)];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (NON_PROSE.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push([start, end]);
      if (node.type === "html") {
        const opening = HTML_CODE_OPEN.exec(node.value ?? "");
        const closing = /^<\/(code|pre|kbd|samp|tt)\s*>$/i.exec(node.value ?? "");
        if (opening) openHtml.set(opening[1].toLowerCase(), start);
        else if (closing && openHtml.has(closing[1].toLowerCase())) {
          ranges.push([openHtml.get(closing[1].toLowerCase())!, end]);
          openHtml.delete(closing[1].toLowerCase());
        }
      }
      continue;
    }
    // Children in reverse so they are popped in document order.
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push(node.children![i]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push(body.slice(cursor, from), body.slice(from, end));
    else if (parts.length > 0) parts[parts.length - 1] += body.slice(from, end);
    else parts.push("", body.slice(from, end));
    cursor = end;
  }
  parts.push(body.slice(cursor));
  return parts;
}

/**
 * Whether the body could hold a mention at all. Parsing is skipped otherwise, so
 * ordinary comments cost a substring check; GitHub caps comments at 65,536
 * characters, which bounds the parse for the rest.
 */
function mayMention(body: string, botUsername: string): boolean {
  const handle = botHandle(botUsername).toLowerCase();
  return Boolean(handle) && body.toLowerCase().includes(`@${handle}`);
}

export function containsBotMention(body: string, botUsername: string | undefined): boolean {
  if (!botUsername || !mayMention(body, botUsername)) return false;
  const pattern = botMentionPattern(botUsername, "i");
  if (!pattern) return false;
  return segments(body).some((part, index) => index % 2 === 0 && pattern.test(part));
}

/** Remove the bot's mentions from prose; code is left exactly as written. */
export function stripBotMention(body: string, botUsername: string): string {
  const pattern = mayMention(body, botUsername) ? botMentionPattern(botUsername, "gi") : null;
  if (!pattern) return body.trim();
  return segments(body)
    .map((part, index) => (index % 2 === 0 ? part.replace(pattern, "") : part))
    .join("")
    .trim();
}
