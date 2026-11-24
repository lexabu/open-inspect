import { describe, expect, it } from "vitest";
import type { EventRow } from "../../types";
import { finalResponseText } from "./child-session-summary";

let sequence = 0;
function event(type: string, createdAt: number, data: Record<string, unknown> = {}): EventRow {
  sequence += 1;
  return {
    id: `${type}:${sequence}`,
    type,
    data: JSON.stringify({ type, ...data }),
    message_id: "message-1",
    created_at: createdAt,
  };
}
const token = (createdAt: number, content: string) => event("token", createdAt, { content });
const toolCall = (createdAt: number) =>
  event("tool_call", createdAt, { tool: "bash", args: {}, callId: `call-${createdAt}` });
const done = (createdAt: number) =>
  event("execution_complete", createdAt, { messageId: "message-1", success: true });

function textOf(events: EventRow[]): string | null {
  return finalResponseText(
    { listEventPage: () => ({ events, hasMore: false, nextCursor: null }) },
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
    expect(
      textOf([token(1, "Interim."), event("tool_result", 2, { callId: "c", result: "x" }), done(3)])
    ).toBeNull();
  });

  it("is nothing when the turn produced no text at all", () => {
    expect(textOf([toolCall(1), done(2)])).toBeNull();
  });
});
