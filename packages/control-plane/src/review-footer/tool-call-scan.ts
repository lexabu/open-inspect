import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { EventTimelineCursor } from "../session/event-cursor";
import type { EventRepository } from "../session/event-repository";
import type { ToolCallEvent } from "./session-activity";

/** Few rows per page: one tool_call event can hold up to a megabyte of output. */
const TOOL_CALL_PAGE_SIZE = 8;
/** Stored event text a turn's scan may read in all, well beyond a review turn's. */
const TOOL_CALL_SCAN_BUDGET_CHARS = 16 * 1024 * 1024;

function parseToolCall(data: string): ToolCallEvent {
  const parsed = sandboxEventSchema.safeParse(JSON.parse(data));
  if (!parsed.success || parsed.data.type !== "tool_call") {
    throw new Error("Malformed persisted tool_call event");
  }
  return parsed.data;
}

/**
 * Hands each of a turn's tool calls to `visit`, one small page at a time, keeping none of
 * them. Returns false, having stopped, once the stored events read pass the budget.
 */
export function scanTurnToolCalls(
  events: Pick<EventRepository, "listEventPage">,
  messageId: string,
  visit: (call: ToolCallEvent) => void,
  limits: { pageSize: number; budgetChars: number } = {
    pageSize: TOOL_CALL_PAGE_SIZE,
    budgetChars: TOOL_CALL_SCAN_BUDGET_CHARS,
  }
): boolean {
  let read = 0;
  let cursor: EventTimelineCursor | null = null;
  do {
    const page = events.listEventPage({
      type: "tool_call",
      messageId,
      limit: limits.pageSize,
      cursor,
    });
    for (const row of page.events) {
      read += row.data.length;
      if (read > limits.budgetChars) return false;
      visit(parseToolCall(row.data));
    }
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor !== null);
  return true;
}
