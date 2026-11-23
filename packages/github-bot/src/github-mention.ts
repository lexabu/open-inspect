import { escapeRegExp } from "@open-inspect/shared/regex";

/**
 * Matches `@<app>` or `@<app>[bot]` for a bot login such as `my-app[bot]`. People
 * usually type the App's handle without the suffix, so both forms count; a longer
 * handle that merely starts with the App's name (`@my-app-other`, `@my-app[bot]-clone`)
 * does not.
 */
function botMentionPattern(botUsername: string, flags: string): RegExp {
  const handle = botUsername.replace(/\[bot\]$/i, "");
  return new RegExp(`@${escapeRegExp(handle)}(?:\\[bot\\])?(?![A-Za-z0-9\\[-])`, flags);
}

export function containsBotMention(body: string, botUsername: string | undefined): boolean {
  return botUsername ? botMentionPattern(botUsername, "i").test(body) : false;
}

export function stripBotMention(body: string, botUsername: string): string {
  return body.replace(botMentionPattern(botUsername, "gi"), "").trim();
}
