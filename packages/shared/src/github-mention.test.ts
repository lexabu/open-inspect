import { describe, expect, it } from "vitest";
import { containsBotMention, isBotLogin, stripBotMention } from "./github-mention";

const BOT = "nativepath-ai[bot]";

describe("containsBotMention", () => {
  it.each([
    "@nativepath-ai[bot] review this",
    "@nativepath-ai review this",
    "thanks @NativePath-AI, one more question",
    "(@nativepath-ai)",
    "ping @nativepath-ai.",
    "see @nativepath-ai[bot][^1]",
    "first line\n@nativepath-ai please look",
    "_@nativepath-ai_ please look",
    "@nativepath-ai[^1] please look",
    "a ~~~ b\n@nativepath-ai please look",
    "````\n```\n@nativepath-ai in code\n````\n@nativepath-ai after the block",
    "a stray ` here\n\n@nativepath-ai please look\n\nanother ` there",
    "| a ` | b |\n| --- | --- |\n| @nativepath-ai | c ` |",
    "Can you check...@nativepath-ai[bot]",
    "确认一下@nativepath-ai[bot]",
    "<details>\n<summary>log</summary>\n\nlong log\n</details>\n@nativepath-ai[bot] please look",
    "<details><summary>log</summary>x</details> @nativepath-ai why?",
  ])("matches %s", (body) => {
    expect(containsBotMention(body, BOT)).toBe(true);
  });

  it.each([
    "@nativepath-ai-other review this",
    "ask @nativepath-ai[bot]-clone instead",
    "@nativepath-aibot review this",
    "nativepath-ai review this",
    "email me@nativepath-ai.com about it",
    "write to @nativepath-ai.com",
    "cc @nativepath-ai/reviewers",
    "the handle is `@nativepath-ai`",
    "```\n@nativepath-ai review\n```",
    "``code with\n@nativepath-ai inside``",
    "````\n```\n@nativepath-ai still code\n````",
    "~~~ts\n@nativepath-ai in an unclosed fence",
    "用户@nativepath-ai.公司",
    "@nativepath-ai\u200b-other review this",
    "x\u200b@nativepath-ai review this",
    "- step one\n  ```\n  @nativepath-ai in a listed fence\n  ```",
    "> ~~~\n> @nativepath-ai in a quoted fence\n> ~~~",
    "<!-- @nativepath-ai in a comment -->",
    "The literal text is <code>@nativepath-ai</code>",
    "press <kbd>@nativepath-ai</kbd> to see",
    '<code title="a>b">@nativepath-ai</code>',
    "<kbd><kbd>Ctrl</kbd>+<kbd>@nativepath-ai</kbd></kbd>",
  ])("does not match %s", (body) => {
    expect(containsBotMention(body, BOT)).toBe(false);
  });

  it("matches a prose mention next to code", () => {
    expect(containsBotMention("`npm test` fails, @nativepath-ai why?", BOT)).toBe(true);
  });

  it("matches nothing without a configured bot", () => {
    expect(containsBotMention("@nativepath-ai review", undefined)).toBe(false);
  });

  it("matches nothing when the configured login has no handle", () => {
    expect(containsBotMention("@anyone review", "[bot]")).toBe(false);
    expect(stripBotMention("@anyone review", "[bot]")).toBe("@anyone review");
  });

  it("also accepts a configured login without the [bot] suffix", () => {
    expect(containsBotMention("@nativepath-ai[bot] hi", "nativepath-ai")).toBe(true);
  });
});

describe("stripBotMention", () => {
  it("removes both mention forms and keeps the request", () => {
    expect(stripBotMention("@nativepath-ai please explain", BOT)).toBe("please explain");
    expect(stripBotMention("@nativepath-ai[bot] please explain", BOT)).toBe("please explain");
  });

  it("removes every prose mention of the bot", () => {
    expect(stripBotMention("@nativepath-ai fix this, then @nativepath-ai[bot] rerun", BOT)).toBe(
      "fix this, then  rerun"
    );
  });

  it("leaves multiline code spans and long fences untouched", () => {
    expect(
      stripBotMention(
        "@nativepath-ai see ``a\n@nativepath-ai b`` and\n````\n@nativepath-ai\n````",
        BOT
      )
    ).toBe("see ``a\n@nativepath-ai b`` and\n````\n@nativepath-ai\n````");
  });

  it("leaves inline <code> elements untouched", () => {
    expect(stripBotMention("@nativepath-ai what is <code>@nativepath-ai</code>?", BOT)).toBe(
      "what is <code>@nativepath-ai</code>?"
    );
  });

  it("leaves an email in any script untouched", () => {
    expect(stripBotMention("用户@nativepath-ai.公司", BOT)).toBe("用户@nativepath-ai.公司");
  });

  it("leaves code, emails and team handles as written", () => {
    expect(
      stripBotMention(
        "@nativepath-ai why does `@nativepath-ai` fail for me@nativepath-ai.com and @nativepath-ai/reviewers?",
        BOT
      )
    ).toBe("why does `@nativepath-ai` fail for me@nativepath-ai.com and @nativepath-ai/reviewers?");
  });
});

describe("isBotLogin", () => {
  it.each([BOT, "nativepath-ai"])("recognizes the App's login when configured as %s", (config) => {
    expect(isBotLogin("nativepath-ai[bot]", config)).toBe(true);
    expect(isBotLogin("NativePath-AI[bot]", config)).toBe(true);
  });

  it("never treats a person named like the handle as the bot", () => {
    expect(isBotLogin("nativepath-ai", BOT)).toBe(false);
    expect(isBotLogin("nativepath-ai", "nativepath-ai")).toBe(false);
  });

  it("rejects other logins, missing logins and an empty configuration", () => {
    expect(isBotLogin("other[bot]", BOT)).toBe(false);
    expect(isBotLogin(undefined, BOT)).toBe(false);
    expect(isBotLogin("[bot]", "[bot]")).toBe(false);
  });
});

describe("worst-case input", () => {
  it("parses a maximum-size comment full of unmatched backtick runs in bounded time", () => {
    // GitHub caps comments at 65,536 characters; this body is about that size.
    const body = `${Array.from({ length: 360 }, (_, i) => "`".repeat(i + 1)).join(" x ")} @nativepath-ai`;
    const started = performance.now();
    expect(containsBotMention(body, BOT)).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("survives deeply nested quotes without overflowing", () => {
    const body = `${">".repeat(16_000)} @nativepath-ai`;
    expect(() => containsBotMention(body, BOT)).not.toThrow();
    expect(containsBotMention(body, BOT)).toBe(true);
  });

  it("scans a very long body for fenced code without parsing it", () => {
    const filler = "log line\n".repeat(3_000);
    const fenced = `${filler}\n\`\`\`\n@nativepath-ai in a pasted log\n\`\`\`\n`;
    expect(containsBotMention(fenced, BOT)).toBe(false);
    expect(stripBotMention(`@nativepath-ai look\n${fenced}`, BOT)).toContain(
      "@nativepath-ai in a pasted log"
    );
    const started = performance.now();
    expect(containsBotMention(`${">".repeat(60_000)} @nativepath-ai`, BOT)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps a mention after a quoted fence in a very long body", () => {
    const log = "> log line\n".repeat(2_000);
    const body = `> \`\`\`\n${log}> \`\`\`\n\n@nativepath-ai what broke?`;
    expect(body.length).toBeGreaterThan(10_000);
    expect(containsBotMention(body, BOT)).toBe(true);
  });

  it("does not close a top-level log fence on a quoted fence line in a very long body", () => {
    const log = "log line\n".repeat(2_000);
    const body = `\`\`\`\n${log}> \`\`\`\n@nativepath-ai in the log\n\`\`\`\n`;
    expect(body.length).toBeGreaterThan(10_000);
    expect(containsBotMention(body, BOT)).toBe(false);
  });

  it("keeps a mention after a fenced log inside a list item in a very long body", () => {
    const log = "    log line\n".repeat(2_000);
    const body = `- deploy failed:\n  \`\`\`\n${log}  \`\`\`\n\n@nativepath-ai what broke?`;
    expect(body.length).toBeGreaterThan(20_000);
    expect(containsBotMention(body, BOT)).toBe(true);
    expect(containsBotMention(body.replace("@nativepath-ai what broke?", "done"), BOT)).toBe(false);
  });

  it("parses a bracket-heavy comment just below the parse cutoff in bounded time", () => {
    const body = `${"[".repeat(4_990)}${"]".repeat(4_990)} @nativepath-ai`;
    expect(body.length).toBeLessThan(10_000);
    const started = performance.now();
    expect(containsBotMention(body, BOT)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.each([
    ["spaces", " ".repeat(60_000)],
    ["bullets", "- ".repeat(30_000)],
    ["quotes", "> ".repeat(30_000)],
    ["numbers", "1. ".repeat(20_000)],
  ])("scans a very long line of %s in bounded time", (_label, prefix) => {
    const started = performance.now();
    expect(containsBotMention(`${prefix}x @nativepath-ai`, BOT)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("skips parsing when the handle never appears", () => {
    const body = "`".repeat(60_000);
    const started = performance.now();
    expect(containsBotMention(body, BOT)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
