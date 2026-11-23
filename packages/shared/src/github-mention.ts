import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmTable } from "micromark-extension-gfm-table";
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

/** Inline HTML elements whose contents render as code, read from a tag's start. */
const HTML_CODE_OPEN = /^<(code|pre|kbd|samp|tt)(?=[\s/>])/i;
const HTML_CODE_CLOSE = /^<\/(code|pre|kbd|samp|tt)\s*>/i;

/**
 * Bodies longer than this skip the Markdown parser: parse time grows
 * quadratically with quote nesting (2.7 s at GitHub's 65,536-character cap).
 * They get a linear scan for top-level fenced blocks instead, which covers
 * pasted logs.
 */
const MAX_PARSED_LENGTH = 20_000;

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/** Code ranges from a CommonMark parse with GFM tables and footnotes. */
function parsedCodeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const openHtml = new Map<string, { depth: number; start: number }>();
  const tree = fromMarkdown(body, {
    extensions: [gfmTable(), gfmFootnote()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmFootnoteFromMarkdown()],
  });
  // An explicit stack, so deep nesting cannot overflow; children are pushed in
  // reverse so nodes are visited in document order.
  const stack: MarkdownNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (NON_PROSE.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push([start, end]);
      if (node.type === "html") trackHtmlCode(node.value ?? "", start, end, openHtml, ranges);
      continue;
    }
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push(node.children![i]);
  }
  return ranges;
}

/** Masks inline code elements from their outermost opening tag to its closing tag. */
function trackHtmlCode(
  tag: string,
  start: number,
  end: number,
  open: Map<string, { depth: number; start: number }>,
  ranges: Array<[number, number]>
): void {
  const opening = HTML_CODE_OPEN.exec(tag);
  if (opening) {
    const name = opening[1].toLowerCase();
    const current = open.get(name);
    if (current) current.depth++;
    else open.set(name, { depth: 1, start });
    return;
  }
  const closing = HTML_CODE_CLOSE.exec(tag);
  const current = closing ? open.get(closing[1].toLowerCase()) : undefined;
  if (!closing || !current) return;
  current.depth--;
  if (current.depth === 0) {
    ranges.push([current.start, end]);
    open.delete(closing[1].toLowerCase());
  }
}

/** Top-level fenced blocks by a linear line scan, for bodies too long to parse. */
function fencedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = body.split(/(?<=\n)/);
  let offset = 0;
  let fence: { char: string; length: number; start: number } | null = null;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes =
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        line.slice(marker[0].length).trim() === "";
      if (closes) {
        ranges.push([fence.start, offset + line.length]);
        fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && line.slice(marker[0].length).includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length, start: offset };
    }
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, body.length]);
  return ranges;
}

/** Prose and code segments, alternating with prose at even indexes. */
function segments(body: string): string[] {
  const ranges = body.length > MAX_PARSED_LENGTH ? fencedRanges(body) : parsedCodeRanges(body);
  ranges.sort((x, y) => x[0] - y[0]);
  // Overlapping or touching ranges (a <code> element and its tags) become one.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
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
