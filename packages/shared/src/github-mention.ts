import { escapeRegExp } from "./regex";

/**
 * GitHub App mentions in Markdown comment bodies, for a bot login such as
 * `my-app[bot]`. People type the App's handle without the suffix (GitHub does
 * not autocomplete Apps), so `@my-app` and `@my-app[bot]` both count.
 *
 * Not a mention: text inside inline code or fenced code blocks, an email
 * address (`me@my-app.com`), a team handle (`@my-app/team`), or a longer handle
 * that only starts with the App's name (`@my-app-other`, `@my-app[bot]-clone`).
 * The full login may sit next to Markdown punctuation such as a footnote
 * (`@my-app[bot][^1]`).
 */
function botMentionPattern(botUsername: string, flags: string): RegExp {
  const handle = escapeRegExp(botUsername.replace(/\[bot\]$/i, ""));
  const notInsideAWord = "(?<![A-Za-z0-9._%+/-])";
  return new RegExp(
    `${notInsideAWord}@${handle}(?:\\[bot\\](?![A-Za-z0-9-])|(?![A-Za-z0-9\\[/@-]|\\.[A-Za-z0-9]))`,
    flags
  );
}

/** Fenced blocks first, then inline code; a capture group keeps them in `split` output. */
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)/;

/** Prose and code segments in order; even indexes are prose. */
function segments(body: string): string[] {
  return body.split(CODE);
}

export function containsBotMention(body: string, botUsername: string | undefined): boolean {
  if (!botUsername) return false;
  const pattern = botMentionPattern(botUsername, "i");
  return segments(body).some((part, index) => index % 2 === 0 && pattern.test(part));
}

/** Remove the bot's mentions from prose; code is left exactly as written. */
export function stripBotMention(body: string, botUsername: string): string {
  const pattern = botMentionPattern(botUsername, "gi");
  return segments(body)
    .map((part, index) => (index % 2 === 0 ? part.replace(pattern, "") : part))
    .join("")
    .trim();
}
