import { ADVISORY_APPROVE_MARKER } from "@open-inspect/shared/github-review-verdict";
import { describe, expect, it } from "vitest";
import {
  applyFooter,
  renderFooterLine,
  REVIEW_FOOTER_MARKER,
  type MemorySourceActivity,
} from "./render";

const IDLE: MemorySourceActivity = {
  searched: false,
  factsUsed: 0,
  matched: 0,
  updated: 0,
  proposed: 0,
  failed: 0,
};

describe("renderFooterLine", () => {
  it("names a Bedrock model without its catalog suffix and labels the cost Bedrock cost", () => {
    expect(
      renderFooterLine({
        kind: "review",
        modelId: "amazon-bedrock/openai.gpt-6.2-sol",
        totalCostUsd: 0.0512,
        memory: { hindsight: { ...IDLE, searched: true, factsUsed: 2 }, builtIn: null },
      })
    ).toBe(
      "Findings via GPT-6.2 Sol · Hindsight memory: searched, 2 facts used · Bedrock cost: $0.05"
    );
  });

  it("labels other models' cost Cost, and a reply as a reply", () => {
    expect(
      renderFooterLine({
        kind: "comment",
        modelId: "anthropic/claude-opus-4-5",
        totalCostUsd: 0.28,
        memory: null,
      })
    ).toBe("Reply via Claude Opus 4.5 · Cost: $0.28");
  });

  it("falls back to the model id for a model no longer in the catalog", () => {
    expect(
      renderFooterLine({ kind: "review", modelId: "acme/retired-1", totalCostUsd: 1, memory: null })
    ).toBe("Findings via acme/retired-1 · Cost: $1.00");
  });

  it.each([
    [0, "$0.00"],
    [0.0001, "<$0.01"],
    [0.0049, "<$0.01"],
    [0.005, "$0.01"],
    [0.126, "$0.13"],
    [12.3, "$12.30"],
  ])("shows a cost of %s as %s", (cost, shown) => {
    expect(
      renderFooterLine({ kind: "review", modelId: "acme/x", totalCostUsd: cost, memory: null })
    ).toBe(`Findings via acme/x · Cost: ${shown}`);
  });
});

describe("applyFooter", () => {
  const line = "Findings via GPT-6.2 Sol · Bedrock cost: $0.05";

  it("appends the footer under its marker", () => {
    expect(applyFooter("**Verdict: Approve.**\n", line)).toBe(
      `**Verdict: Approve.**\n\n${REVIEW_FOOTER_MARKER}\n${line}`
    );
  });

  it("is idempotent: applying the same footer again changes nothing", () => {
    const once = applyFooter("Body", line);
    expect(applyFooter(once, line)).toBe(once);
  });

  it("replaces an earlier footer instead of adding a second", () => {
    const earlier = applyFooter("Body", "Findings via X · Cost: $0.01");
    const updated = applyFooter(earlier, line);
    expect(updated).toBe(`Body\n\n${REVIEW_FOOTER_MARKER}\n${line}`);
    expect(updated.split(REVIEW_FOOTER_MARKER)).toHaveLength(2);
  });

  it("keeps an advisory approval marker as the last line", () => {
    const body = `Approve.\n\n${ADVISORY_APPROVE_MARKER}`;
    const footered = applyFooter(body, line);
    expect(footered).toBe(
      `Approve.\n\n${REVIEW_FOOTER_MARKER}\n${line}\n${ADVISORY_APPROVE_MARKER}`
    );
    expect(applyFooter(footered, line)).toBe(footered);
  });

  it("footers an empty body with the footer alone", () => {
    expect(applyFooter("", line)).toBe(`${REVIEW_FOOTER_MARKER}\n${line}`);
  });
});
