import { describe, expect, it } from "vitest";
import {
  buildService,
  inlineComment,
  OPEN_INSPECT_REVIEW_ENVELOPE,
  openInspectReview,
} from "./service.test-support";

const human = { id: "7", login: "alice", type: "User" };

/** The review comment bodies the session was asked to address. */
function queuedCommentBodies(h: ReturnType<typeof buildService>): string[] {
  const [, , init] = h.sessions.fetch.mock.calls.at(-1) as unknown as [
    string,
    string,
    { body: string },
  ];
  const command = JSON.parse(init.body);
  return command.origin.feedback.comments.map((comment: { body: string }) => comment.body);
}

describe("AutofixService and inline comments that call the bot", () => {
  it("drops a review's inline comment that calls the bot and keeps the rest", async () => {
    const h = buildService();
    h.github.getPullRequestFeedback.mockResolvedValueOnce({
      ...openInspectReview({
        state: "COMMENTED",
        body: "",
        comments: [
          inlineComment({ id: "1", body: "oi bugs" }),
          inlineComment({ id: "2", body: "Rename this to `limit`." }),
        ],
      }),
      author: human,
    });

    const result = await h.service.process(OPEN_INSPECT_REVIEW_ENVELOPE);

    expect(result).toMatchObject({ decision: "queued" });
    expect(queuedCommentBodies(h)).toEqual(["Rename this to `limit`."]);
  });

  it("skips a review whose only feedback calls the bot", async () => {
    const h = buildService();
    h.github.getPullRequestFeedback.mockResolvedValueOnce({
      ...openInspectReview({
        state: "COMMENTED",
        body: "",
        comments: [inlineComment({ body: "@open-inspect security" })],
      }),
      author: human,
    });

    const result = await h.service.process(OPEN_INSPECT_REVIEW_ENVELOPE);

    expect(result).toMatchObject({ decision: "skipped", reason: "empty_feedback" });
    expect(h.sessions.fetch).not.toHaveBeenCalled();
  });
});
