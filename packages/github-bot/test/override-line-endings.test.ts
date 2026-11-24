import { describe, expect, it } from "vitest";
import { parseOverrideCommand } from "../src/review-gate-override";

const BOT = "nativepath-ai[bot]";
const OVERRIDE = "@nativepath-ai override abcdef1 verified by hand";
/** Prose that pushes a comment past the parser's limit, into the linear fallback. */
const FALLBACK_PADDING = "filler words ".repeat(900);

const endings = [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
] as const;

const underlines = [
  ["a setext heading", "---"],
  ["a table header", "|---|"],
] as const;

describe.each(endings)("an override above an underline line (%s endings)", (_name, eol) => {
  it.each(underlines)("is not read when it is %s", (_kind, underline) => {
    const body = `${OVERRIDE}${eol}${underline}${eol}`;
    expect(parseOverrideCommand(body, BOT, "npai")).toBeNull();
    const long = `${body}${eol}${FALLBACK_PADDING}`;
    expect(parseOverrideCommand(long, BOT, "npai")).toBeNull();
  });

  it("is read on its own line", () => {
    const long = `${OVERRIDE}${eol}${eol}${FALLBACK_PADDING}`;
    expect(parseOverrideCommand(long, BOT, "npai")).toEqual({
      commit: "abcdef1",
      reason: "verified by hand",
    });
  });
});
