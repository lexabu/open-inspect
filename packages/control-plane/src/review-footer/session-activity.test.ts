import { describe, expect, it } from "vitest";
import { singleCommandWords } from "./session-activity";
import {
  bash,
  call,
  COMMENT_URL,
  createdComment,
  createdReview,
  postsOf,
} from "./session-activity.test-support";

describe("the posts a turn created", () => {
  it("takes a review submitted with gh api --method POST and a here-document", () => {
    const posts = postsOf([
      bash(
        'gh api repos/acme/widgets/pulls/7/reviews \\\n  --method POST \\\n  --input - <<\'JSON\'\n{"body": "a; b && c | d"}\nJSON',
        createdReview(111)
      ),
    ]);
    expect(posts).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("takes a conversation comment posted with -f (an implicit POST)", () => {
    const posts = postsOf([
      bash(
        `gh api repos/acme/widgets/issues/7/comments -f body='Done; all set'`,
        createdComment(222)
      ),
    ]);
    expect(posts).toEqual([{ kind: "comment", pullNumber: 7, id: 222 }]);
  });

  it("takes gh's {owner}/{repo} placeholders and a leading slash", () => {
    const posts = postsOf([
      bash(
        "gh api -XPOST /repos/{owner}/{repo}/pulls/7/reviews --input r.json",
        createdReview(111)
      ),
    ]);
    expect(posts).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("takes a new comment from the PR comment command, whose output is its URL", () => {
    const posts = postsOf([bash("gh pr comment 7 --body 'Done'", `${COMMENT_URL}\n`)]);
    expect(posts).toEqual([{ kind: "comment", pullNumber: 7, id: 222 }]);
  });

  it("lists a post once however often its receipt appears", () => {
    const receipt = bash(
      "gh api repos/acme/widgets/issues/7/comments -f body=x",
      createdComment(222)
    );
    expect(postsOf([receipt, { ...receipt, callId: "again" }])).toEqual([
      { kind: "comment", pullNumber: 7, id: 222 },
    ]);
  });

  it("ignores failed calls and calls that are not shell commands", () => {
    const posts = postsOf([
      bash("gh api repos/acme/widgets/issues/7/comments -f body=x", createdComment(222), "error"),
      call("webfetch", { url: COMMENT_URL }, createdComment(222)),
    ]);
    expect(posts).toEqual([]);
  });
});

describe("singleCommandWords", () => {
  it("splits one command into words, honouring quotes and escapes", () => {
    expect(singleCommandWords(`gh api x -f body='a "b"; c' -f q="d e" f\\ g 2>&1`)).toEqual([
      "gh",
      "api",
      "x",
      "-f",
      `body=a "b"; c`,
      "-f",
      "q=d e",
      "f g",
      "2>&1",
    ]);
  });

  it.each([
    "gh pr view 7; gh api x -f a=b",
    "gh pr view 7 && gh api x",
    "gh pr view 7 || gh api x",
    "gh api x | jq .",
    "gh api x &",
    "(gh api x)",
    "gh api x -f body=$(gh pr view 7)",
    "gh api x -f body=`gh pr view 7`",
    "gh pr view 7\ngh api x",
    "gh api x -f body='unclosed",
  ])("refuses %j, which is not one simple command", (command) => {
    expect(singleCommandWords(command)).toBeNull();
  });
});
