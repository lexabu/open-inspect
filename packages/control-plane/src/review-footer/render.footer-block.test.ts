/**
 * Only a complete footer block at the very end of a body is the footer; a marker anywhere
 * else is body text (Claude M1, Sol M3).
 */
import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import { describe, expect, it } from "vitest";
import { applyFooter, REVIEW_FOOTER_MARKER } from "./render";

const line = "Findings via GPT-6.2 Sol · Bedrock cost: $0.05";
const earlier = "Findings via GPT-6.2 Sol · Bedrock cost: $0.01";

describe("applyFooter and the footer marker", () => {
  it("leaves a marker in the middle of a body, and the lines after it, untouched", () => {
    const body = `Intro\n${REVIEW_FOOTER_MARKER}\nimportant finding\nmore text`;
    expect(applyFooter(body, line)).toBe(`${body}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
  });

  it("leaves a marker inside fenced code untouched, even at the end of the body", () => {
    const inside = `Example:\n\`\`\`html\n${REVIEW_FOOTER_MARKER}\n${earlier}\n\`\`\``;
    expect(applyFooter(inside, line)).toBe(`${inside}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
    const unclosed = `Example:\n~~~\n${REVIEW_FOOTER_MARKER}\n${earlier}`;
    expect(applyFooter(unclosed, line)).toBe(`${unclosed}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
  });

  it("leaves a quoted marker untouched", () => {
    const body = `As noted:\n> ${REVIEW_FOOTER_MARKER}\n> ${earlier}`;
    expect(applyFooter(body, line)).toBe(`${body}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
  });

  it("does not take a marker followed by a line that is not a footer line for a footer", () => {
    const body = `Findings\n${REVIEW_FOOTER_MARKER}\nNot a footer`;
    expect(applyFooter(body, line)).toBe(`${body}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
  });

  it("replaces the trailing footer on a re-run, keeping a marker earlier in the body", () => {
    const body = `See ${REVIEW_FOOTER_MARKER} above\n\n${REVIEW_FOOTER_MARKER}\n${earlier}\n`;
    expect(applyFooter(body, line)).toBe(
      `See ${REVIEW_FOOTER_MARKER} above\n\n${REVIEW_FOOTER_MARKER}\n${line}`
    );
  });

  it("replaces the trailing footer just before the advisory marker, which stays last", () => {
    const body = `Approve.\n\n${REVIEW_FOOTER_MARKER}\n${earlier}\n${ADVISORY_APPROVE_MARKER}\n`;
    expect(applyFooter(body, line)).toBe(
      `Approve.\n\n${REVIEW_FOOTER_MARKER}\n${line}\n${ADVISORY_APPROVE_MARKER}`
    );
  });

  it("treats the advisory marker as such only on its own last line", () => {
    const body = `ok ${ADVISORY_APPROVE_MARKER}`;
    expect(applyFooter(body, line)).toBe(`${body}\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
  });
});
