/**
 * Memory is counted from validated results (Sol M4) and per source, so built-in memory is
 * never labelled Hindsight (Sol M5).
 */
import { describe, expect, it } from "vitest";
import { memoryPhrases, renderFooterLine } from "./render";
import { call, memoryOf } from "./session-activity.test-support";

const recall = (tool: string, response: unknown, status?: string) =>
  call(tool, { query: "q" }, JSON.stringify(response), status);
const facts = (count: number) => ({ results: Array.from({ length: count }, (_, id) => ({ id })) });
const activeFact = {
  id: "m1",
  status: "active",
  memoryType: "fact",
  scope: { type: "personal" },
  title: "t",
  description: "d",
  content: "body",
  revisionId: "r",
  revisionNumber: 1,
  authorKind: "agent",
  authorUserId: null,
  authorSessionId: "session-1",
};
const archivedFact = {
  id: "m2",
  status: "archived",
  archiveKind: "manual",
  archivedAt: 1,
  archiveNote: null,
};
const phrases = (...args: Parameters<typeof memoryOf>) => {
  const memory = memoryOf(...args);
  return memory ? memoryPhrases(memory) : [];
};

describe("Hindsight results are validated before they count", () => {
  it("counts recalled facts under each harness's tool names", () => {
    expect(
      phrases(
        [
          recall("mcp__hindsight-team-memory__recall", facts(2)),
          recall("hindsight-code_recall", facts(1)),
          recall("mcp__other-server__recall", facts(5)),
        ],
        ["hindsight-team-memory", "hindsight-code"]
      )
    ).toEqual(["Hindsight memory: searched, 3 facts used"]);
  });

  it("reads an empty recall as searched, nothing relevant", () => {
    expect(phrases([recall("hindsight-code_recall", facts(0))], ["hindsight-code"])).toEqual([
      "Hindsight memory: searched, nothing relevant",
    ]);
  });

  it("counts a recall answered with an error, or without results, as failed", () => {
    expect(
      phrases(
        [
          recall("hindsight-code_recall", { error: "bank not found", results: [{ id: 1 }] }),
          recall("hindsight-code_recall", { detail: "unexpected" }),
          call("hindsight-code_recall", { query: "q" }, "Internal Server Error"),
          recall("hindsight-code_recall", facts(1), "error"),
        ],
        ["hindsight-code"]
      )
    ).toEqual(["Hindsight memory: unavailable"]);
  });

  it("counts a retain answered with an error as failed, otherwise as an update", () => {
    expect(
      memoryOf(
        [
          recall("hindsight-code_retain", { error: "rejected" }),
          recall("hindsight-code_retain", { success: true }),
        ],
        ["hindsight-code"]
      )?.hindsight
    ).toMatchObject({ updated: 1, failed: 1 });
  });
});

describe("built-in memory results are validated before they count", () => {
  it("counts only a read that returned an active fact's body as a fact used", () => {
    expect(
      phrases([
        call("memory_search", { query: "q" }, JSON.stringify({ results: [], hasMore: false })),
        call("memory_read", { memoryId: "m1" }, JSON.stringify(activeFact)),
        call("memory_read", { memoryId: "m2" }, JSON.stringify(archivedFact)),
        call("memory_read", { memoryId: "m3" }, "{}"),
      ])
    ).toEqual(["built-in memory: searched, 1 fact used"]);
  });

  it("counts active and proposed writes, and rejects a write result of the wrong shape", () => {
    expect(
      memoryOf([
        call("memory_write", {}, JSON.stringify({ id: "m", status: "active", revisionId: "r" })),
        call("memory_write", {}, JSON.stringify({ id: "m", status: "proposed", revisionId: "r" })),
        call("memory_write", {}, "memory_write failed (403): opted out"),
      ])?.builtIn
    ).toEqual({ searched: false, factsUsed: 0, matched: 0, updated: 1, proposed: 1, failed: 1 });
  });

  it("reads a turn whose built-in calls all failed as unavailable", () => {
    expect(phrases([call("memory_search", { query: "q" }, "boom", "error")])).toEqual([
      "built-in memory: unavailable",
    ]);
  });
});

describe("memory is reported per source", () => {
  it("never labels built-in memory as Hindsight", () => {
    expect(
      phrases(
        [call("memory_read", { memoryId: "m1" }, JSON.stringify(activeFact))],
        ["hindsight-code"]
      )
    ).toEqual(["Hindsight memory: not used", "built-in memory: 1 fact used"]);
  });

  it("names both sources when both ran", () => {
    expect(
      renderFooterLine({
        kind: "review",
        modelId: "amazon-bedrock/openai.gpt-6.2-sol",
        totalCostUsd: 0.05,
        memory: memoryOf(
          [
            recall("hindsight-code_recall", facts(2)),
            call("memory_search", { query: "q" }, JSON.stringify({ results: [], hasMore: false })),
          ],
          ["hindsight-code"]
        ),
      })
    ).toBe(
      "Findings via GPT-6.2 Sol · Hindsight memory: searched, 2 facts used · built-in memory: searched, nothing relevant · Bedrock cost: $0.05"
    );
  });

  it("reads configured but idle Hindsight as not used, and leaves out an unused built-in", () => {
    expect(phrases([], ["hindsight-code"])).toEqual(["Hindsight memory: not used"]);
  });

  it("leaves memory out when no Hindsight server is configured and no built-in tool ran", () => {
    expect(memoryOf([recall("hindsight-code_recall", facts(2))], [])).toBeNull();
  });
});

describe("memory activity is not overstated or understated", () => {
  it("reads a built-in search with matches as searched, not nothing relevant", () => {
    const match = {
      results: [
        { id: "m1", revisionId: "r", scope: { type: "personal" }, title: "t", description: "d" },
      ],
      hasMore: false,
    };
    expect(phrases([call("memory_search", { query: "q" }, JSON.stringify(match))])).toEqual([
      "built-in memory: searched",
    ]);
  });

  it("counts an empty Hindsight retain or reflect as failed", () => {
    expect(
      memoryOf(
        [
          call("hindsight-code_retain", { content: "x" }, ""),
          call("hindsight-code_reflect", { query: "q" }, "  "),
        ],
        ["hindsight-code"]
      )?.hindsight
    ).toMatchObject({ searched: false, updated: 0, failed: 2 });
  });
});
