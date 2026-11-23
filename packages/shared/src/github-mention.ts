import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { escapeRegExp } from "./regex";

/**
 * GitHub App mentions in Markdown comment bodies, for a bot login such as
 * `my-app[bot]`. People type the App's handle without the suffix (GitHub does
 * not autocomplete Apps), so `@my-app` and `@my-app[bot]` both count.
 *
 * Not a mention: text inside code, an HTML tag or comment, or a `<code>` element, an email
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
  // The full login keeps the boundaries it always had: anything but a longer handle.
  const full = String.raw`@${handle}\[bot\](?![A-Za-z0-9-])`;
  // The plain handle is stricter: not after an email's local part or a path, and not
  // the start of `[bot]...`, a longer handle, a team, an email or a domain.
  const before = String.raw`(?<![${WORD}.%+/-])`;
  const afterPlain = String.raw`(?![${WORD}/@-]|\[(?!\^)|\.[${WORD}])`;
  return new RegExp(`${full}|${before}@${handle}${afterPlain}`, `${flags}u`);
}

/** Node types whose text is never prose: code blocks and inline code. */
const CODE_NODES = new Set(["code", "inlineCode"]);

/** Inline HTML elements whose contents render as code, read from a tag's start. */
const HTML_CODE_OPEN = /^<(code|pre|kbd|samp|tt)(?=[\s/>])/i;
const HTML_CODE_CLOSE = /^<\/(code|pre|kbd|samp|tt)\s*>/i;

/**
 * Bodies longer than this skip the Markdown parser, whose cost grows faster than
 * the input on adversarial shapes (deep quotes, bracket runs: about 20 ms at this
 * size, 2.7 s at GitHub's 65,536-character cap). They get a linear scan for
 * top-level fenced blocks instead, which covers pasted logs.
 */
const MAX_PARSED_LENGTH = 10_000;

/** Deeper list or quote nesting on one line than any real comment uses. */
const MAX_CONTAINER_DEPTH = 8;
/** More link brackets, or emphasis markers, than any real comment uses. */
const MAX_BRACKETS = 1_000;
const MAX_EMPHASIS_MARKERS = 2_000;

/**
 * How many list-item or block-quote markers open a line (`>`, bullets, ordered
 * numbers). A plain loop, so long runs of markers cannot backtrack.
 */
function containerDepth(line: string): number {
  let depth = 0;
  let i = 0;
  for (;;) {
    while (line[i] === " " || line[i] === "\t") i++;
    let next = -1;
    if (line[i] === ">") next = i + 1;
    else if ("-*+".includes(line[i] ?? "x") && /^[ \t]?$/.test(line[i + 1] ?? "")) next = i + 1;
    else {
      let k = i;
      while (k < i + 9 && line[k] >= "0" && line[k] <= "9") k++;
      if (k > i && (line[k] === "." || line[k] === ")") && /^[ \t]?$/.test(line[k + 1] ?? "")) {
        next = k + 1;
      }
    }
    if (next < 0) return depth;
    depth++;
    i = next;
  }
}

/**
 * Whether the Markdown parser runs in bounded time on this body. Its cost grows
 * faster than the input on deep list or quote nesting, bracket runs and emphasis
 * runs (2 s for 9,800 characters of "- "), so those shapes and long bodies take
 * the linear fallback instead. One linear pass.
 */
function parseIsBounded(body: string): boolean {
  if (body.length > MAX_PARSED_LENGTH) return false;
  let brackets = 0;
  let emphasis = 0;
  for (const char of body) {
    if (char === "[" && ++brackets > MAX_BRACKETS) return false;
    if ((char === "*" || char === "_") && ++emphasis > MAX_EMPHASIS_MARKERS) return false;
  }
  return body.split("\n").every((line) => containerDepth(line) <= MAX_CONTAINER_DEPTH);
}

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * Code ranges from a CommonMark parse with GFM tables. (The GFM footnote and
 * autolink extensions are left out: footnotes scan backwards quadratically on
 * bracket-heavy input, and the autolink transform recurses on deep nesting.)
 */
function parsedCodeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const openHtml = new Map<string, { depth: number; start: number }>();
  const tree = fromMarkdown(body, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  // An explicit stack, so deep nesting cannot overflow; children are pushed in
  // reverse so nodes are visited in document order.
  const stack: MarkdownNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && CODE_NODES.has(node.type)) {
      ranges.push([start, end]);
      continue;
    }
    if (start !== undefined && end !== undefined && node.type === "html") {
      // Only the markup is masked: text between tags (after `</details>`, say) is
      // visible prose. Tags are read from the source, which keeps container markers.
      for (const [tagStart, tagEnd] of htmlTags(body, start, end)) {
        ranges.push([tagStart, tagEnd]);
        trackHtmlCode(body.slice(tagStart, tagEnd), tagStart, tagEnd, openHtml, ranges);
      }
      continue;
    }
    for (let i = (node.children?.length ?? 0) - 1; i >= 0; i--) stack.push(node.children![i]);
  }
  return ranges;
}

/**
 * HTML comments and tags in `body[start, end)`, by a linear scan that respects
 * quoted attribute values. An unterminated comment or tag runs to `end`.
 */
function htmlTags(body: string, start: number, end: number): Array<[number, number]> {
  const tags: Array<[number, number]> = [];
  let i = start;
  while (i < end) {
    const lt = body.indexOf("<", i);
    if (lt < 0 || lt >= end) break;
    if (body.startsWith("<!--", lt)) {
      const close = body.indexOf("-->", lt + 4);
      const tagEnd = close < 0 || close + 3 > end ? end : close + 3;
      tags.push([lt, tagEnd]);
      i = tagEnd;
      continue;
    }
    if (!/[A-Za-z/!?]/.test(body[lt + 1] ?? "")) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    let quote: string | null = null;
    while (j < end && (quote !== null || body[j] !== ">")) {
      if (quote !== null && body[j] === quote) quote = null;
      else if (quote === null && (body[j] === '"' || body[j] === "'")) quote = body[j];
      j++;
    }
    const tagEnd = Math.min(j + 1, end);
    tags.push([lt, tagEnd]);
    i = tagEnd;
  }
  return tags;
}

/** Masks code elements from their outermost opening tag to its closing tag. */
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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s;

/**
 * Top-level fenced blocks by a linear line scan, for bodies too long to parse:
 * a fence opens at the start of a line (up to three spaces in) and closes with
 * the same character, at least as many, and nothing else on its line. Fences
 * inside quotes are left as prose, so a mention after one is never hidden.
 */
function fencedRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: { char: string; length: number; start: number } | null = null;
  for (const line of body.split(/(?<=\n)/)) {
    const marker = FENCE.exec(line.replace(/\r?\n$/, ""));
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        ranges.push([fence.start, offset + line.length]);
        fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length, start: offset };
    }
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, body.length]);
  return ranges;
}

/** The last body segmented: a mention check is usually followed by a strip. */
let lastSegmented: { body: string; parts: string[] } | null = null;

/** Prose and code segments, alternating with prose at even indexes. */
function segments(body: string): string[] {
  if (lastSegmented?.body === body) return lastSegmented.parts;
  const parts = computeSegments(body);
  lastSegmented = { body, parts };
  return parts;
}

function computeSegments(body: string): string[] {
  const ranges = parseIsBounded(body) ? parsedCodeRanges(body) : fencedRanges(body);
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
