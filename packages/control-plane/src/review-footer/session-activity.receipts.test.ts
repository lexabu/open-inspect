/**
 * A post is the session's only from a creation receipt in the turn, on the pull request
 * the session was started for (Sol H1, Claude M2).
 */
import { describe, expect, it } from "vitest";
import {
  bash,
  createdComment,
  createdReview,
  postsOf,
  REVIEW_URL,
  SIBLING_REVIEW_URL,
} from "./session-activity.test-support";

describe("creation receipts only", () => {
  it("does not claim a GraphQL read that returns review URLs", () => {
    const query =
      'query { repository(owner:"acme", name:"widgets") { pullRequest(number:7) { reviews(first:5) { nodes { url } } } } }';
    expect(
      postsOf([
        bash(
          `gh api graphql -f query='${query}' --jq '.data.repository.pullRequest.reviews.nodes[0].url'`,
          SIBLING_REVIEW_URL
        ),
        bash(
          `gh api graphql -f query='${query}'`,
          JSON.stringify({ html_url: SIBLING_REVIEW_URL })
        ),
      ])
    ).toEqual([]);
  });

  it("does not claim a post from a read chained before a write", () => {
    expect(
      postsOf([
        bash(
          "gh pr view 7 --comments; gh api --method POST repos/acme/widgets/pulls/7/reviews --input r.json",
          createdReview(333)
        ),
        bash(
          "gh pr view 7 --json url --jq .url && gh api repos/acme/widgets/issues/7/comments -f body=x",
          `${SIBLING_REVIEW_URL}\n${createdComment(222)}`
        ),
      ])
    ).toEqual([]);
  });

  it("does not claim the comment an edit-last command changed", () => {
    expect(
      postsOf([
        bash(
          "gh pr comment 7 --edit-last --body x",
          "https://github.com/acme/widgets/pull/7#issuecomment-222"
        ),
        bash(
          "gh pr comment 7 --edit-last=true --create-if-none --body x",
          "https://github.com/acme/widgets/pull/7#issuecomment-222"
        ),
      ])
    ).toEqual([]);
  });

  it("does not claim a post through PATCH or PUT", () => {
    expect(
      postsOf([
        bash(
          "gh api -X PATCH repos/acme/widgets/issues/comments/222 -f body=x",
          createdComment(222)
        ),
        bash(
          "gh api --method=PUT repos/acme/widgets/pulls/7/reviews/111 -f body=x",
          createdReview(111)
        ),
      ])
    ).toEqual([]);
  });

  it("does not claim a sibling reviewer's review it read, or one its body links to", () => {
    expect(
      postsOf([
        bash("gh api repos/acme/widgets/pulls/7/reviews/333", createdReview(333)),
        bash("gh api repos/acme/widgets/pulls/7/reviews", `[${createdReview(333)}]`),
      ])
    ).toEqual([]);
    expect(
      postsOf([
        bash(
          "gh api --method POST repos/acme/widgets/pulls/7/reviews --input r.json",
          createdReview(111, `Agrees with the other reviewer:\n${SIBLING_REVIEW_URL}`)
        ),
      ])
    ).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("does not claim a post on a different pull request", () => {
    expect(
      postsOf([
        bash(
          "gh api -X POST repos/acme/widgets/pulls/8/reviews --input r.json",
          createdReview(444, "x", 8)
        ),
        bash("gh api repos/acme/widgets/issues/8/comments -f body=x", createdComment(555, 8)),
        bash("gh pr comment 8 --body x", "https://github.com/acme/widgets/pull/8#issuecomment-555"),
        // A receipt for #7 can only come from a request to #7.
        bash("gh api repos/acme/widgets/issues/8/comments -f body=x", createdComment(222)),
      ])
    ).toEqual([]);
  });

  it("does not claim a receipt whose output is anything but the one created object", () => {
    expect(
      postsOf([
        // --jq output, response headers, and a URL that is not the whole output.
        bash(
          "gh api -X POST repos/acme/widgets/pulls/7/reviews --input r.json --jq .html_url",
          REVIEW_URL
        ),
        bash(
          "gh api -i -X POST repos/acme/widgets/pulls/7/reviews --input r.json",
          `HTTP/2.0 200 OK\n\n${createdReview(111)}`
        ),
        bash(
          "gh pr comment 7 --body x",
          `posted\nhttps://github.com/acme/widgets/pull/7#issuecomment-222`
        ),
        // A review receipt from the comments endpoint, or the other way round.
        bash("gh api repos/acme/widgets/issues/7/comments -f body=x", createdReview(111)),
      ])
    ).toEqual([]);
  });

  it("does not claim posts from other GitHub calls or other repositories", () => {
    expect(
      postsOf([
        bash(
          "gh api repos/acme/widgets/pulls/7/comments/5/replies -f body=x",
          JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/7#discussion_r5" })
        ),
        bash("gh api repos/acme/other/issues/7/comments -f body=x", createdComment(222)),
        bash(
          "GH_TOKEN=x gh api repos/acme/widgets/issues/7/comments -f body=x",
          createdComment(222)
        ),
      ])
    ).toEqual([]);
  });
});
