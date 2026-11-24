/**
 * A turn's tool calls are read a small page at a time within a budget, and reduced to facts
 * as they are read (Sol H2).
 */
import { describe, expect, it } from "vitest";
import { eventTimelineCursorFromRow } from "../session/event-cursor";
import type { EventPage, ListEventPageOptions } from "../session/event-repository";
import type { EventRow } from "../session/types";
import { TurnActivity } from "./session-activity";
import { bash, createdReview, TARGET } from "./session-activity.test-support";
import { scanTurnToolCalls } from "./tool-call-scan";

const MEGABYTE = 1024 * 1024;

function row(index: number, output: string, command = "cat big.log"): EventRow {
  return {
    id: `tool_call:${index}`,
    type: "tool_call",
    data: JSON.stringify(bash(command, output)),
    message_id: "msg-1",
    created_at: 1_000 - index,
    timeline_sequence: 1_000 - index,
  };
}

/** The event repository's paging over `rows`, newest first, recording each request. */
function pagedEvents(rows: EventRow[]) {
  const requests: ListEventPageOptions[] = [];
  return {
    requests,
    listEventPage(options: ListEventPageOptions): EventPage {
      requests.push(options);
      const cursor = options.cursor;
      const start =
        cursor?.kind === "timeline"
          ? rows.findIndex((candidate) => candidate.timeline_sequence === cursor.sequence) + 1
          : 0;
      const events = rows.slice(start, start + options.limit);
      const hasMore = start + options.limit < rows.length;
      const last = events.at(-1);
      const nextCursor = last ? eventTimelineCursorFromRow(last) : null;
      return { events, hasMore, nextCursor };
    },
  };
}

describe("scanTurnToolCalls", () => {
  it("reads every page of the turn's tool calls, a few rows at a time", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(index, `line ${index}`));
    const events = pagedEvents(rows);
    const seen: string[] = [];

    const complete = scanTurnToolCalls(events, "msg-1", (call) => seen.push(call.output ?? ""));

    expect(complete).toBe(true);
    expect(seen).toHaveLength(20);
    expect(events.requests).toHaveLength(3);
    expect(events.requests.every((request) => request.limit === 8)).toBe(true);
    expect(events.requests[0]).toMatchObject({ type: "tool_call", messageId: "msg-1" });
    expect(events.requests[1].cursor).toMatchObject({ kind: "timeline", sequence: 993 });
  });

  it("keeps only the facts: a turn of very large tool results still finds its post", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) => row(index, "x".repeat(MEGABYTE))),
      row(
        12,
        createdReview(111),
        "gh api -X POST repos/acme/widgets/pulls/7/reviews --input r.json"
      ),
    ];
    const activity = new TurnActivity(TARGET, []);

    expect(scanTurnToolCalls(pagedEvents(rows), "msg-1", (call) => activity.add(call))).toBe(true);
    expect(activity.posts()).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("stops once the stored events read pass the budget, and says so", () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index, "x".repeat(MEGABYTE)));
    const events = pagedEvents(rows);
    let visited = 0;

    const complete = scanTurnToolCalls(events, "msg-1", () => (visited += 1));

    expect(complete).toBe(false);
    expect(visited).toBe(15);
    expect(events.requests).toHaveLength(2);
  });

  it("fails loudly on a stored row that is not a tool call", () => {
    const broken: EventRow = { ...row(0, "x"), data: JSON.stringify({ type: "token" }) };
    expect(() => scanTurnToolCalls(pagedEvents([broken]), "msg-1", () => {})).toThrow(
      "Malformed persisted tool_call event"
    );
  });
});
