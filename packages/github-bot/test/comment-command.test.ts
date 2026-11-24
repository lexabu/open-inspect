import { describe, expect, it } from "vitest";
import { parseCommentCommand } from "../src/comment-command";

describe("parseCommentCommand", () => {
  it.each(["", "   ", "review", "Review", "  review  ", ": review", ", review"])(
    "reads %j as the default full review",
    (text) => {
      expect(parseCommentCommand(text)).toEqual({ kind: "review", focus: null });
    }
  );

  it.each(["security", "performance", "bugs", "tests"] as const)(
    "reads the focus area %s, alone or after review",
    (area) => {
      const focused = { kind: "review", focus: { kind: "area", area } };
      expect(parseCommentCommand(area)).toEqual(focused);
      expect(parseCommentCommand(`review ${area}`)).toEqual(focused);
      expect(parseCommentCommand(`REVIEW ${area.toUpperCase()}`)).toEqual(focused);
      expect(parseCommentCommand(`: ${area}`)).toEqual(focused);
    }
  );

  it("reads free text after review as a focus", () => {
    expect(parseCommentCommand("review the retry logic\nand its backoff")).toEqual({
      kind: "review",
      focus: { kind: "text", text: "the retry logic\nand its backoff" },
    });
  });

  it.each([
    "what does this change do?",
    "security please",
    "fix the failing test",
    "reviewer notes",
    "review:",
    "can you review this?",
  ])("reads %j as a free-form request", (text) => {
    expect(parseCommentCommand(text)).toEqual({ kind: "request", text });
  });

  it("keeps address punctuation in a request, so the request reads as written", () => {
    expect(parseCommentCommand(": why is this slow?")).toEqual({
      kind: "request",
      text: ": why is this slow?",
    });
  });

  it("reads a long body in linear time", () => {
    const text = `review ${"x ".repeat(30_000)}`;
    const started = performance.now();
    expect(parseCommentCommand(text).kind).toBe("review");
    expect(performance.now() - started).toBeLessThan(100);
  });
});
