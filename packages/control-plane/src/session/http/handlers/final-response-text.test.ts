import { describe, expect, it } from "vitest";
import type { EventRow } from "../../types";
import { finalResponseText } from "./child-session-summary";

let sequence = 0;
/** An event row; rows get rising sequence numbers in the order they are made, as when stored. */
function event(type: string, createdAt: number, data: Record<string, unknown> = {}): EventRow {
  sequence += 1;
  return {
    id: `${type}:${sequence}`,
    type,
    data: JSON.stringify({ type, ...data }),
    message_id: "message-1",
    created_at: createdAt,
    timeline_sequence: sequence,
  };
}
const token = (createdAt: number, content: string) => event("token", createdAt, { content });
const toolCall = (createdAt: number) =>
  event("tool_call", createdAt, { tool: "bash", args: {}, callId: `call-${createdAt}` });
const toolResult = (createdAt: number) =>
  event("tool_result", createdAt, { callId: "c", result: "x" });
const done = (createdAt: number) =>
  event("execution_complete", createdAt, { messageId: "message-1", success: true });

/** Reads through a page source that returns rows as the event repository does: newest first. */
function textOf(events: EventRow[]): string | null {
  const newestFirst = [...events].sort(
    (a, b) => b.created_at - a.created_at || (b.timeline_sequence ?? 0) - (a.timeline_sequence ?? 0)
  );
  return finalResponseText(
    { listEventPage: () => ({ events: newestFirst, hasMore: false, nextCursor: null }) },
    "message-1"
  );
}

describe("finalResponseText", () => {
  it("is the text the turn ended with", () => {
    expect(textOf([toolCall(1), token(2, "All done: approve."), done(3)])).toBe(
      "All done: approve."
    );
  });

  it("is nothing when the turn ended with tool activity after its last text", () => {
    // Text from the middle of the turn is not the agent's final word.
    expect(textOf([token(1, "I will approve this."), toolCall(2), done(3)])).toBeNull();
    expect(textOf([token(1, "Interim."), toolResult(2), done(3)])).toBeNull();
  });

  it("is nothing when the turn produced no text at all", () => {
    expect(textOf([toolCall(1), done(2)])).toBeNull();
  });

  it("orders events stamped in the same millisecond by the order they were stored in", () => {
    // Events often arrive in one batch and share a timestamp.
    expect(textOf([toolResult(5), token(5, "Final: approve."), done(5)])).toBe("Final: approve.");
    expect(textOf([token(5, "Interim."), toolResult(5), done(5)])).toBeNull();
  });
});
