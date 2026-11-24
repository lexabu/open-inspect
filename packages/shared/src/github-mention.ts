import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { escapeRegExp } from "./regex";

/**
 * How a Markdown comment body calls a GitHub App, for a bot login such as `my-app[bot]`
 * and an optional short command such as `ma`. Three triggers count:
 *
 * - A mention. People type the App's handle without the suffix (GitHub does not
 *   autocomplete Apps), so `@my-app` and `@my-app[bot]` both count, anywhere in prose.
 * - The command as a slash command (`/ma`), anywhere in prose after a space or a line start.
 * - The bare command (`ma`, lower case exactly), only where it starts a line of a top-level
 *   paragraph, so prose that names it, quotes, lists, headings, tables and `<details>` do not.
 *
 * Not a trigger: text inside code, an HTML tag or comment, or a `<code>` element, an email
 * address in any script (`me@my-app.com`, `ma+tag@x`), a team handle (`@my-app/team`), a
 * path, URL or link (`src/ma/x`, `?next=/ma`, `[x](/ma)`), or a longer word that only starts
 * with the trigger (`@my-app-other`, `@my-app[bot]-clone`, `mas`, `ma_x`), including one split
 * by an invisible format character. Emphasis and footnotes may surround a mention
 * (`_@my-app_`, `@my-app[^1]`).
 */

/** The App's handle (`my-app`) from a configured login, with or without `[bot]`. */
export function botHandle(botUsername: string): string {
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

/** A short command: a lower-case ASCII letter or digit, then those or hyphens. */
const COMMAND = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The configured short command, or null where none is set. A malformed one is an error:
 * deployments check it once where they load their configuration.
 */
export function parseBotCommand(command: string | null | undefined): string | null {
  const value = command?.trim() ?? "";
  if (value === "") return null;
  if (!COMMAND.test(value)) {
    throw new Error(`Invalid bot command "${value}": use lower-case letters, digits and hyphens`);
  }
  return value;
}

/** The end of a command: not a longer word, a path, an email, a possessive or a domain. */
const COMMAND_END = String.raw`(?![${WORD}_/@'’+%=-]|\.[${WORD}])`;

/** The triggers that count anywhere in prose: mentions, and the slash command. */
function botTriggerPattern(botUsername: string, command: string | null): RegExp | null {
  const raw = botHandle(botUsername);
  const short = command;
  if (!raw && !short) return null;
  const alternatives: string[] = [];
  if (raw) {
    const handle = escapeRegExp(raw);
    // The full login keeps the boundaries it always had: anything but a longer handle.
    alternatives.push(String.raw`@${handle}\[bot\](?![A-Za-z0-9-])`);
    // The plain handle is stricter: not after an email's local part or a path, and not
    // the start of `[bot]...`, a longer handle, a team, an email or a domain.
    const before = String.raw`(?<![${WORD}.%+/-])`;
    const afterPlain = String.raw`(?![${WORD}/@-]|\[(?!\^)|\.[${WORD}])`;
    alternatives.push(`${before}@${handle}${afterPlain}`);
  }
  if (short) {
    // The slash command follows a space or a line start, so it is not part of a path, a
    // URL, a link target or an email.
    alternatives.push(String.raw`(?<!\S)/${escapeRegExp(short)}${COMMAND_END}`);
  }
  return new RegExp(alternatives.join("|"), "giu");
}

/**
 * The bare command at a line start, in lower case exactly. It takes the line's indent and
 * the spaces after it, so a strip leaves the rest of the line at its start.
 */
function bareCommandPattern(command: string): RegExp {
  return new RegExp(String.raw`[ \t]{0,3}${escapeRegExp(command)}${COMMAND_END}[ \t]*`, "uy");
}

/** The shortest way to call the bot: its short command where set, otherwise `@handle`. */
export function botTrigger(botUsername: string, command: string | null | undefined): string {
  return parseBotCommand(command) ?? `@${botHandle(botUsername)}`;
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

/** Where code is, and where a line command may start. */
interface BodyLayout {
  ranges: Array<[number, number]>;
  /** Offsets of the lines that may hold a line command, in order. */
  commandLines: number[];
}

/** The offsets in `body[start, end)` that start a line: after `\n`, or a lone `\r`. */
function lineStarts(body: string, start: number, end: number): number[] {
  const starts = [start];
  for (let i = start; i < end - 1; i++) {
    if (body[i] === "\n" || (body[i] === "\r" && body[i + 1] !== "\n")) starts.push(i + 1);
  }
  return starts;
}

const DETAILS_OPEN = /^<details(?=[\s>])/i;
const DETAILS_CLOSE = /^<\/details\s*>/i;

/**
 * A command line is a line of a top-level paragraph outside `<details>`: never a quote, a
 * list item or its continuation, a heading (setext included), a table or code.
 */
function paragraphLines(body: string, tree: MarkdownNode): number[] {
  const lines: number[] = [];
  let details = 0;
  for (const node of tree.children ?? []) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (node.type === "html") {
      for (const [tagStart, tagEnd] of htmlTags(body, start, end)) {
        const tag = body.slice(tagStart, tagEnd);
        if (DETAILS_OPEN.test(tag)) details++;
        else if (DETAILS_CLOSE.test(tag)) details = Math.max(0, details - 1);
      }
    } else if (node.type === "paragraph" && details === 0) {
      lines.push(...lineStarts(body, start, end));
    }
  }
  return lines;
}

/**
 * Code ranges and command lines from a CommonMark parse with GFM tables. (The GFM
 * footnote and autolink extensions are left out: footnotes scan backwards quadratically
 * on bracket-heavy input, and the autolink transform recurses on deep nesting.)
 */
function parsedLayout(body: string): BodyLayout {
  const ranges: Array<[number, number]> = [];
  const openHtml = new Map<string, { depth: number; start: number }>();
  const tree: MarkdownNode = fromMarkdown(body, {
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
  return { ranges, commandLines: paragraphLines(body, tree) };
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

/** Whether a line is a setext underline or a table delimiter row, by two linear tests. */
function isUnderline(line: string): boolean {
  return /^[ \t|:=-]*$/.test(line) && /[=-]/.test(line);
}

/**
 * The linear fallback's layout. Without a parse, the only command line it trusts is the
 * first non-blank one, which nothing above can quote, list, fence or hide; it still is not
 * one when the next line makes it a heading or a table header.
 */
function fallbackLayout(body: string): BodyLayout {
  const ranges = fencedRanges(body);
  // Lines end at LF, CRLF or a lone CR, so no line read here keeps a trailing CR.
  let start = 0;
  let end = nextLineBreak(body, start);
  while (start < body.length && body.slice(start, end).trim() === "") {
    start = afterLineBreak(body, end);
    end = nextLineBreak(body, start);
  }
  if (start >= body.length) return { ranges, commandLines: [] };
  const nextStart = afterLineBreak(body, end);
  const next = body.slice(nextStart, nextLineBreak(body, nextStart));
  return { ranges, commandLines: isUnderline(next) ? [] : [start] };
}

/** The start of the line after the break at `end`: past a CRLF pair, or one LF or CR. */
function afterLineBreak(body: string, end: number): number {
  return end + (body.startsWith("\r\n", end) ? 2 : 1);
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

/** The last body laid out: a trigger check is usually followed by a strip. */
let lastSegmented: { body: string; segmented: Segmented } | null = null;

interface ProsePart {
  /** Offset of the part in the body. */
  start: number;
  text: string;
  /** Code that follows the part, exactly as written; empty after the last part. */
  code: string;
}

interface Segmented {
  parts: ProsePart[];
  commandLines: number[];
}

/** Prose parts of the body, each followed by the code after it, and its command lines. */
function segments(body: string): Segmented {
  if (lastSegmented?.body === body) return lastSegmented.segmented;
  const segmented = computeSegments(body);
  lastSegmented = { body, segmented };
  return segmented;
}

function computeSegments(body: string): Segmented {
  const { ranges, commandLines } = parseIsBounded(body) ? parsedLayout(body) : fallbackLayout(body);
  ranges.sort((x, y) => x[0] - y[0]);
  // Overlapping or touching ranges (a <code> element and its tags) become one.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const parts: ProsePart[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    parts.push({ start: cursor, text: body.slice(cursor, start), code: body.slice(start, end) });
    cursor = end;
  }
  parts.push({ start: cursor, text: body.slice(cursor), code: "" });
  return { parts, commandLines };
}

/**
 * Whether the body could hold a trigger at all. Parsing is skipped otherwise, so
 * ordinary comments cost a substring check; GitHub caps comments at 65,536
 * characters, which bounds the parse for the rest.
 */
function mayTrigger(body: string, botUsername: string, command: string | null): boolean {
  const text = body.toLowerCase();
  const handle = botHandle(botUsername).toLowerCase();
  return (Boolean(handle) && text.includes(`@${handle}`)) || (!!command && text.includes(command));
}

interface TriggerMatch {
  /** Offset in the part's text. */
  index: number;
  length: number;
}

/**
 * The triggers in each prose part, in order: the anywhere triggers, and the bare command
 * where a command line starts in the part.
 */
function* partTriggers(
  body: string,
  botUsername: string,
  command: string | null
): Generator<{ part: ProsePart; matches: TriggerMatch[] }> {
  const pattern = botTriggerPattern(botUsername, command);
  const bare = command ? bareCommandPattern(command) : null;
  const { parts, commandLines } = segments(body);
  let line = 0;
  for (const part of parts) {
    const matches: TriggerMatch[] = pattern
      ? Array.from(part.text.matchAll(pattern), (m) => ({ index: m.index, length: m[0].length }))
      : [];
    const end = part.start + part.text.length;
    while (line < commandLines.length && commandLines[line] < part.start) line++;
    for (; bare && line < commandLines.length && commandLines[line] < end; line++) {
      bare.lastIndex = commandLines[line] - part.start;
      const match = bare.exec(part.text);
      if (match) matches.push({ index: match.index, length: match[0].length });
    }
    yield { part, matches: matches.sort((x, y) => x.index - y.index) };
  }
}

/** Whether the body calls the bot with any trigger outside code. */
export function containsBotMention(
  body: string,
  botUsername: string | undefined,
  command?: string | null
): boolean {
  const short = parseBotCommand(command);
  if (!botUsername || !mayTrigger(body, botUsername, short)) return false;
  for (const { matches } of partTriggers(body, botUsername, short)) {
    if (matches.length > 0) return true;
  }
  return false;
}

/** Remove the bot's triggers from prose; code is left exactly as written. */
export function stripBotMention(
  body: string,
  botUsername: string,
  command?: string | null
): string {
  const short = parseBotCommand(command);
  if (!mayTrigger(body, botUsername, short)) return body.trim();
  let stripped = "";
  for (const { part, matches } of partTriggers(body, botUsername, short)) {
    let cursor = 0;
    for (const match of matches) {
      stripped += part.text.slice(cursor, match.index);
      cursor = match.index + match.length;
    }
    stripped += part.text.slice(cursor) + part.code;
  }
  return stripped.trim();
}

/**
 * The rest of each command line that starts with a trigger (`@my-app`, `@my-app[bot]`,
 * `/ma`, or `ma` in lower case), to the end of its line, for line commands such as an
 * override. Only command lines count, so a trigger hidden in an HTML comment, code, a
 * quote or `<details>` is never one.
 */
export function lineCommands(body: string, botUsername: string, command?: string | null): string[] {
  const short = parseBotCommand(command);
  if (!mayTrigger(body, botUsername, short)) return [];
  const forms: string[] = [];
  const raw = botHandle(botUsername);
  if (raw) forms.push(String.raw`@${escapeRegExp(raw)}(?:\[bot\])?`);
  if (short) forms.push(String.raw`\/${escapeRegExp(short)}`);
  const anyCase = new RegExp(String.raw`[ \t]{0,3}(?:${forms.join("|")})(?=[ \t]|$)`, "iy");
  const bare = short
    ? new RegExp(String.raw`[ \t]{0,3}${escapeRegExp(short)}(?=[ \t]|$)`, "y")
    : null;
  const { parts, commandLines } = segments(body);
  const rests: string[] = [];
  let partIndex = 0;
  for (const lineStart of commandLines) {
    while (partIndex < parts.length - 1 && parts[partIndex + 1].start <= lineStart) partIndex++;
    const part = parts[partIndex];
    // A command line that starts inside code (an inline span) holds no command.
    if (lineStart > part.start + part.text.length) continue;
    const lineEnd = nextLineBreak(body, lineStart);
    const line = body.slice(lineStart, lineEnd);
    for (const pattern of bare ? [anyCase, bare] : [anyCase]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        rests.push(line.slice(match[0].length));
        break;
      }
    }
  }
  return rests;
}

/** The offset of the line break that ends the line starting at `start`. */
function nextLineBreak(body: string, start: number): number {
  for (let i = start; i < body.length; i++) {
    if (body[i] === "\n" || body[i] === "\r") return i;
  }
  return body.length;
}
