import { describe, expect, it } from "vitest";
import {
  botTrigger,
  containsBotMention,
  lineTriggerSource,
  stripBotMention,
} from "./github-mention";

const BOT = "nativepath-ai[bot]";
const CMD = "npai";

describe("containsBotMention with a short command", () => {
  it.each([
    "npai",
    "npai review",
    "NPAI security",
    "npai: what does this do?",
    "npai, why is this slow?",
    "   npai review",
    "Thanks for the fix.\nnpai review",
    "Thanks.\r\nnpai review",
    "/npai",
    "/npai security",
    "please /npai review this",
    "(/npai)",
    // Like a mention, the slash command counts in quoted prose.
    "> /npai review",
    "ping /npai.",
    "```\ncode\n```\nnpai review",
    "<details><summary>log</summary>\n\nx\n</details>\n\nnpai review",
    "@nativepath-ai review",
  ])("matches %j", (body) => {
    expect(containsBotMention(body, BOT, CMD)).toBe(true);
  });

  it.each([
    "I asked npai about it yesterday",
    "the npai review was helpful",
    "npai's last review was wrong",
    "npai’s last review was wrong",
    "npai-cli is a different tool",
    "npais are not a thing",
    "write to npai@example.com",
    "npai@x",
    "see npai.dev for details",
    "the files live in src/npai/review.ts",
    "a/npai review",
    "https://example.com/npai",
    "me@x/npai",
    "~/npai review",
    "/npai-cli review",
    "/npai/review",
    "> npai review",
    "- npai review",
    "1. npai review",
    "# npai review",
    "    npai review",
    "`npai review`",
    "x `y` npai review",
    "```\nnpai review\n```",
    "~~~\n/npai security\n~~~",
    "<!-- npai review -->",
    "<code>\nnpai review\n</code>",
  ])("does not match %j", (body) => {
    expect(containsBotMention(body, BOT, CMD)).toBe(false);
  });

  it("ignores the command when none is configured", () => {
    expect(containsBotMention("npai review", BOT, undefined)).toBe(false);
    expect(containsBotMention("/npai review", BOT, "")).toBe(false);
    expect(containsBotMention("@nativepath-ai review", BOT, undefined)).toBe(true);
  });

  it("refuses a malformed command instead of ignoring it", () => {
    expect(() => containsBotMention("npai", BOT, "np ai")).toThrow('Invalid bot command "np ai"');
    expect(() => containsBotMention("npai", BOT, "-npai")).toThrow();
  });
});

describe("stripBotMention with a short command", () => {
  it.each([
    ["npai review", "review"],
    ["  npai security", "security"],
    ["/npai bugs", "bugs"],
    ["@nativepath-ai tests", "tests"],
    ["Looks good.\nnpai review", "Looks good.\nreview"],
    ["npai explain `npai review` usage", "explain `npai review` usage"],
    ["please /npai review", "please  review"],
    ["I mentioned npai once\nnpai why?", "I mentioned npai once\nwhy?"],
    ["```\nnpai review\n```\nnpai why?", "```\nnpai review\n```\nwhy?"],
  ])("strips %j to %j", (body, expected) => {
    expect(stripBotMention(body, BOT, CMD)).toBe(expected);
  });
});

describe("botTrigger", () => {
  it("prefers the short command and falls back to the mention", () => {
    expect(botTrigger(BOT, CMD)).toBe("npai");
    expect(botTrigger(BOT, undefined)).toBe("@nativepath-ai");
  });
});

describe("lineTriggerSource", () => {
  const line = (command: string | undefined) =>
    new RegExp(`^${lineTriggerSource(BOT, command)} override$`, "i");

  it("matches every trigger form at the start of a line", () => {
    for (const text of ["@nativepath-ai", "@nativepath-ai[bot]", "/npai", "npai"]) {
      expect(line(CMD).test(`${text} override`)).toBe(true);
    }
    expect(line(undefined).test("npai override")).toBe(false);
    expect(line(undefined).test("@nativepath-ai override")).toBe(true);
  });
});

describe("trigger matching cost", () => {
  // GitHub caps a comment at 65,536 characters; each shape is near that cap.
  it.each([
    ["bare commands on every line", "npai x\n".repeat(9_000)],
    ["slash commands", "/npai ".repeat(10_000)],
    ["near misses", "npaix /npai/ a/npai ".repeat(3_000)],
    ["indented lines", `${"   npaj\n".repeat(7_000)}npai`],
    ["one long line", `${"n".repeat(60_000)}npai`],
  ])("stays fast on %s", (_shape, body) => {
    const started = performance.now();
    containsBotMention(body, BOT, CMD);
    stripBotMention(body, BOT, CMD);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("grows linearly with the body", () => {
    const time = (lines: number) => {
      const body = "x npai /npaix npai@y\nnpai\n".repeat(lines);
      const started = performance.now();
      stripBotMention(body, BOT, CMD);
      return performance.now() - started;
    };
    time(200);
    const small = time(500);
    const large = time(2_500);
    // Five times the input; allow generous noise, but not quadratic growth (25x).
    expect(large).toBeLessThan(Math.max(small, 1) * 12);
  });
});
