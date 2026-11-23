import { escapeRegExp } from "./regex";

/**
 * GitHub App mentions in Markdown comment bodies, for a bot login such as
 * `my-app[bot]`. People type the App's handle without the suffix (GitHub does
 * not autocomplete Apps), so `@my-app` and `@my-app[bot]` both count.
 *
 * Not a mention: text inside code (GFM fenced blocks and code spans), an email
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

/**
 * Prose and code segments following GFM, alternating with prose at even indexes.
 * A fenced block opens with three or more backticks or tildes at the start of a
 * line (up to three spaces in) and closes with a fence of the same character at
 * least as long, or runs to the end of the body.
 */
function segments(body: string): string[] {
  const parts: string[] = [];
  const lines = body.split(/(?<=\n)/);
  let prose = "";
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
    // A backtick fence's info string cannot contain a backtick.
    if (!open || (open[1][0] === "`" && lines[i].slice(open[0].length).includes("`"))) {
      prose += lines[i];
      continue;
    }
    const fence = open[1];
    const close = new RegExp(
      String.raw`^ {0,3}${escapeRegExp(fence[0])}{${fence.length},}[ \t]*\r?\n?$`
    );
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    parts.push(...codeSpans(prose), lines.slice(i, end + 1).join(""));
    prose = "";
    i = end;
  }
  parts.push(...codeSpans(prose));
  return parts;
}

/**
 * Code spans in prose: a backtick run closed by a run of exactly the same length,
 * possibly on a later line. An unmatched run is literal text. Returns alternating
 * segments that start and end with prose.
 */
function codeSpans(prose: string): string[] {
  const out: string[] = [];
  const runs = /`+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = runs.exec(prose))) {
    const ticks = match[0];
    const closer = new RegExp(String.raw`(?<!\`)${ticks}(?!\`)`, "g");
    closer.lastIndex = match.index + ticks.length;
    const closing = closer.exec(prose);
    if (!closing) continue;
    const end = closing.index + ticks.length;
    out.push(prose.slice(cursor, match.index), prose.slice(match.index, end));
    cursor = end;
    runs.lastIndex = end;
  }
  out.push(prose.slice(cursor));
  return out;
}

export function containsBotMention(body: string, botUsername: string | undefined): boolean {
  const pattern = botUsername ? botMentionPattern(botUsername, "i") : null;
  if (!pattern) return false;
  return segments(body).some((part, index) => index % 2 === 0 && pattern.test(part));
}

/** Remove the bot's mentions from prose; code is left exactly as written. */
export function stripBotMention(body: string, botUsername: string): string {
  const pattern = botMentionPattern(botUsername, "gi");
  if (!pattern) return body.trim();
  return segments(body)
    .map((part, index) => (index % 2 === 0 ? part.replace(pattern, "") : part))
    .join("")
    .trim();
}
