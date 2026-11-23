import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { escapeRegExp } from "./regex";

/**
 * GitHub App mentions in Markdown comment bodies, for a bot login such as
 * `my-app[bot]`. People type the App's handle without the suffix (GitHub does
 * not autocomplete Apps), so `@my-app` and `@my-app[bot]` both count.
 *
 * Not a mention: text inside code or raw HTML (as GitHub renders it), an email
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

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Prose and code segments, alternating with prose at even indexes. The body is
 * parsed as GitHub Flavored Markdown, so code blocks inside lists or quotes,
 * code spans (which never cross a paragraph) and HTML comments are found the
 * way GitHub renders them.
 */
function segments(body: string): string[] {
  const ranges: Array<[number, number]> = [];
  const visit = (node: MarkdownNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (NON_PROSE.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push([start, end]);
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    parts.push(body.slice(cursor, start), body.slice(start, end));
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
