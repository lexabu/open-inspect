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
