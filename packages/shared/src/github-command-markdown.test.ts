import { describe, expect, it } from "vitest";
import { containsBotMention, stripBotMention } from "./github-mention";

const BOT = "nativepath-ai[bot]";
const CMD = "npai";
/** Prose after the comment that pushes it past the parser's limit, into the linear fallback. */
const FALLBACK_PADDING = `\n\n${"filler words ".repeat(900)}`;

const paths = [
  ["parsed", (body: string) => body],
  ["fallback", (body: string) => body + FALLBACK_PADDING],
] as const;

describe.each(paths)("bare command Markdown context (%s)", (_path, shape) => {
  it.each([
    ["a continued quote line", "> example\nnpai review"],
    ["a list continuation line", "- item\n  npai review"],
    ["an ordered list continuation line", "1. item\n   npai review"],
    ["a setext heading (dashes)", "npai review\n---"],
    ["a setext heading (equals)", "npai review\n==="],
    ["an inline code span across lines", "Run ``\nnpai review\n`` to see"],
    ["an HTML comment", "<!--\nnpai review\n-->"],
    ["a details block", "<details>\n<summary>s</summary>\n\nnpai review\n\n</details>"],
    ["indented code", "Intro\n\n    npai review"],
    ["a fenced block", "```\nnpai review\n```"],
    ["a table cell", "| a |\n| --- |\n| npai review |"],
    ["a line separator", "see docs\u2028npai review"],
    ["a paragraph separator", "see docs\u2029npai review"],
    ["an upper-case bare command", "NPAI is wrong here"],
    ["a capitalised bare command", "Npai review"],
    ["an underscore name", "npai_config is set"],
    ["an email with a tag", "npai+tag@example.org"],
  ])("does not fire on %s", (_name, body) => {
    expect(containsBotMention(shape(body), BOT, CMD)).toBe(false);
  });
});

describe.each(paths)("slash command boundaries (%s)", (_path, shape) => {
  it.each([
    ["a URL query", "https://example.org/?next=/npai"],
    ["a Markdown link", "[link](/npai)"],
    ["an underscore name", "/npai_x"],
    ["an email with a tag", "/npai+tag@example.org"],
  ])("does not fire on %s", (_name, body) => {
    expect(containsBotMention(shape(body), BOT, CMD)).toBe(false);
  });
});

describe.each(paths)("commands that still fire (%s)", (_path, shape) => {
  it.each(["npai review", "npai", "/NPAI review", "please /npai review", "@NativePath-AI review"])(
    "fires on %j",
    (body) => {
      expect(containsBotMention(shape(body), BOT, CMD)).toBe(true);
    }
  );
});

describe("commands on a later paragraph line", () => {
  it.each(["Thanks.\nnpai review", "Thanks.\r\nnpai review", "Thanks.\rnpai review"])(
    "fires on %j",
    (body) => {
      expect(containsBotMention(body, BOT, CMD)).toBe(true);
      expect(stripBotMention(body, BOT, CMD)).toMatch(/^Thanks\.\r?\n?review$/);
    }
  );
});
