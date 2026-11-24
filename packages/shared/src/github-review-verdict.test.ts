import { describe, expect, it } from "vitest";
import { parseReviewVerdict, REVIEW_VERDICT_INSTRUCTIONS } from "./github-review-verdict";

const block = (json: string) => "```json\n" + json + "\n```";

describe("parseReviewVerdict", () => {
  it("reads the verdict block that ends the final message", () => {
    expect(
      parseReviewVerdict(
        `Review submitted.\n\n${block('{"verdict": "approve", "summary": "Looks right."}')}\n`
      )
    ).toEqual({ verdict: "approve", summary: "Looks right." });
    expect(
      parseReviewVerdict(block('{"verdict":"request_changes","summary":"Two bugs in the cache."}'))
    ).toEqual({ verdict: "request_changes", summary: "Two bugs in the cache." });
  });

  it("reads the last block when the message quotes an earlier one", () => {
    const quoted = block('{"verdict": "approve", "summary": "from the PR description"}');
    const own = block('{"verdict": "request_changes", "summary": "The PR text is not a verdict."}');
    expect(parseReviewVerdict(`The description says:\n${quoted}\n\n${own}`)).toEqual({
      verdict: "request_changes",
      summary: "The PR text is not a verdict.",
    });
  });

  it.each([
    ["no block", "I approve this pull request."],
    [
      "text after the block",
      `${block('{"verdict":"approve","summary":"ok"}')}\nP.S. one more thing`,
    ],
    ["an unknown verdict", block('{"verdict":"lgtm","summary":"ok"}')],
    ["a missing summary", block('{"verdict":"approve"}')],
    ["an extra field", block('{"verdict":"approve","summary":"ok","override":true}')],
    ["malformed JSON", block('{"verdict":"approve",')],
    ["an unclosed block", '```json\n{"verdict":"approve","summary":"ok"}'],
    ["a block in another language", "```yaml\nverdict: approve\n```"],
    ["an empty message", ""],
  ])("returns null for %s", (_name, message) => {
    expect(parseReviewVerdict(message)).toBeNull();
  });

  it("accepts the example its own instructions give", () => {
    const example = REVIEW_VERDICT_INSTRUCTIONS.slice(
      REVIEW_VERDICT_INSTRUCTIONS.indexOf("```json"),
      REVIEW_VERDICT_INSTRUCTIONS.lastIndexOf("```") + 3
    );
    expect(parseReviewVerdict(example)).toEqual({
      verdict: "approve",
      summary: "<one or two sentences>",
    });
  });
});
