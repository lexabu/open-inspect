import { describe, expect, it } from "vitest";
import { containsBotMention, stripBotMention } from "../src/github-mention";

const BOT = "nativepath-ai[bot]";

describe("containsBotMention", () => {
  it.each([
    "@nativepath-ai[bot] review this",
    "@nativepath-ai review this",
    "thanks @NativePath-AI, one more question",
    "(@nativepath-ai)",
  ])("matches %s", (body) => {
    expect(containsBotMention(body, BOT)).toBe(true);
  });

  it.each([
    "@nativepath-ai-other review this",
    "ask @nativepath-ai[bot]-clone instead",
    "@nativepath-aibot review this",
    "nativepath-ai review this",
    "email nativepath-ai@example.com",
  ])("does not match %s", (body) => {
    expect(containsBotMention(body, BOT)).toBe(false);
  });

  it("matches nothing without a configured bot", () => {
    expect(containsBotMention("@nativepath-ai review", undefined)).toBe(false);
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

  it("removes every mention of the bot", () => {
    expect(stripBotMention("@nativepath-ai fix this, then @nativepath-ai[bot] rerun", BOT)).toBe(
      "fix this, then  rerun"
    );
  });
});
