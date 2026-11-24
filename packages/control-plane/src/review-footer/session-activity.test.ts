import { describe, expect, it } from "vitest";
import { countMemoryActivity, findSessionPosts, type ToolCallEvent } from "./session-activity";

const REPO = { owner: "Acme", name: "widgets" };
const REVIEW_URL = "https://github.com/acme/widgets/pull/7#pullrequestreview-111";
const COMMENT_URL = "https://github.com/acme/widgets/pull/7#issuecomment-222";

let seq = 0;
function call(
  tool: string,
  args: Record<string, unknown>,
  output: string,
  status = "completed"
): ToolCallEvent {
  seq += 1;
  return {
    type: "tool_call",
    messageId: "msg-1",
    callId: `call-${seq}`,
    tool,
    args,
    output,
    status,
    sandboxId: "sb",
    timestamp: 1,
  };
}
const bash = (command: string, output: string, status?: string) =>
  call("bash", { command }, output, status);

/** What `gh api` prints for a created review: the review, its body echoed back. */
const createdReview = (id: number, body = "LGTM") =>
  JSON.stringify({
    id,
    user: { login: "nativepath-ai[bot]", html_url: "https://github.com/apps/nativepath-ai" },
    body,
    state: "COMMENTED",
    html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
    _links: { html: { href: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}` } },
  });
const createdComment = (id: number) =>
  JSON.stringify({
    url: `https://api.github.com/repos/acme/widgets/issues/comments/${id}`,
    html_url: `https://github.com/acme/widgets/pull/7#issuecomment-${id}`,
    id,
    body: "Done",
  });

describe("findSessionPosts", () => {
  it("finds a review submitted with gh api --method POST --input", () => {
    const posts = findSessionPosts(
      [
        bash(
          "gh api repos/acme/widgets/pulls/7/reviews \\\n  --method POST \\\n  --input - <<'JSON'\n{}\nJSON",
          createdReview(111)
        ),
      ],
      REPO
    );
    expect(posts).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("finds a conversation comment posted with -f (an implicit POST)", () => {
    const posts = findSessionPosts(
      [bash(`gh api repos/acme/widgets/issues/7/comments -f body='Done'`, createdComment(222))],
      REPO
    );
    expect(posts).toEqual([{ kind: "comment", pullNumber: 7, id: 222 }]);
  });

  it("finds a post whose URL is the whole output (gh pr comment, --jq .html_url)", () => {
    const posts = findSessionPosts(
      [
        bash("gh pr comment 7 --body 'Done'", `${COMMENT_URL}\n`),
        bash(
          "gh api -X POST repos/acme/widgets/pulls/7/reviews --input r.json --jq .html_url",
          REVIEW_URL
        ),
      ],
      REPO
    );
    expect(posts).toEqual([
      { kind: "comment", pullNumber: 7, id: 222 },
      { kind: "review", pullNumber: 7, id: 111 },
    ]);
  });

  it("ignores reads, even of another reviewer's review", () => {
    const posts = findSessionPosts(
      [
        bash("gh api repos/acme/widgets/pulls/7/reviews/333", createdReview(333)),
        bash(
          "gh api -X GET repos/acme/widgets/pulls/7/reviews -f per_page=100",
          `[${createdReview(333)}]`
        ),
        bash("gh pr view 7 --comments", `see ${COMMENT_URL}`),
      ],
      REPO
    );
    expect(posts).toEqual([]);
  });

  it("never takes a post linked from inside its own body for its own", () => {
    const body = `Agrees with the other reviewer:\n${"https://github.com/acme/widgets/pull/7#pullrequestreview-333"}`;
    const posts = findSessionPosts(
      [
        bash(
          "gh api --method POST repos/acme/widgets/pulls/7/reviews --input -",
          createdReview(111, body)
        ),
      ],
      REPO
    );
    expect(posts).toEqual([{ kind: "review", pullNumber: 7, id: 111 }]);
  });

  it("ignores inline review comments, other repositories, failed and non-shell calls", () => {
    const posts = findSessionPosts(
      [
        bash(
          "gh api repos/acme/widgets/pulls/7/comments/5/replies --method POST -f body=x",
          JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/7#discussion_r5" })
        ),
        bash(
          "gh api repos/acme/other/issues/7/comments -f body=x",
          "https://github.com/acme/other/pull/7#issuecomment-9"
        ),
        bash("gh pr comment 7 --body x", COMMENT_URL, "error"),
        call("webfetch", { url: COMMENT_URL }, COMMENT_URL),
      ],
      REPO
    );
    expect(posts).toEqual([]);
  });

  it("lists a post once however often its URL appears", () => {
    const posts = findSessionPosts(
      [
        bash("gh pr comment 7 --body x", COMMENT_URL),
        bash("gh pr comment 7 --body x", `${COMMENT_URL}\n${COMMENT_URL}`),
      ],
      REPO
    );
    expect(posts).toEqual([{ kind: "comment", pullNumber: 7, id: 222 }]);
  });
});

const recall = (tool: string, facts: number) =>
  call(
    tool,
    { query: "q" },
    JSON.stringify({ results: Array.from({ length: facts }, (_, i) => ({ id: i })) })
  );

describe("countMemoryActivity", () => {
  it("leaves memory out when none is configured and none was used", () => {
    expect(countMemoryActivity([bash("ls", "a")], [])).toBeNull();
  });

  it("reports configured Hindsight that was never called as not used", () => {
    expect(countMemoryActivity([], ["hindsight-team-memory"])).toEqual({
      label: "Hindsight memory",
      searched: false,
      factsUsed: 0,
      updated: 0,
      proposed: 0,
      failed: 0,
    });
  });

  it("counts Hindsight recalls and retains under each harness's tool names", () => {
    const activity = countMemoryActivity(
      [
        recall("mcp__hindsight-team-memory__recall", 2),
        recall("hindsight-company_recall", 1),
        call("mcp__hindsight-team-memory__retain", { content: "x" }, "ok"),
        recall("mcp__other-server__recall", 5),
        call("mcp__hindsight-team-memory__recall", { query: "q" }, "", "error"),
      ],
      ["hindsight-team-memory", "hindsight-company"]
    );
    expect(activity).toEqual({
      label: "Hindsight memory",
      searched: true,
      factsUsed: 3,
      updated: 1,
      proposed: 0,
      failed: 1,
    });
  });

  it("counts memory calls that errored, so a failing server shows as unavailable", () => {
    expect(
      countMemoryActivity(
        [call("hindsight-code_recall", { query: "q" }, "connection refused", "error")],
        ["hindsight-code"]
      )
    ).toMatchObject({ searched: false, factsUsed: 0, failed: 1 });
    expect(
      countMemoryActivity([call("memory_search", { query: "q" }, "boom", "error")], [])
    ).toMatchObject({ label: "Memory", failed: 1 });
  });

  it("counts a recall whose output is not the usual shape as a search with no facts", () => {
    expect(
      countMemoryActivity([call("mcp__hindsight-a__recall", {}, "not json")], ["hindsight-a"])
    ).toMatchObject({ searched: true, factsUsed: 0 });
  });

  it("counts built-in memory searches, reads and writes, active or proposed", () => {
    const activity = countMemoryActivity(
      [
        call("memory_search", { query: "q" }, "[]"),
        call("memory_read", { memoryId: "m1" }, "{}"),
        call("memory_read", { memoryId: "m2" }, "{}"),
        call("memory_write", {}, JSON.stringify({ id: "m3", status: "active", revisionId: "r" })),
        call("memory_write", {}, JSON.stringify({ id: "m4", status: "proposed", revisionId: "r" })),
      ],
      []
    );
    expect(activity).toEqual({
      label: "Memory",
      searched: true,
      factsUsed: 2,
      updated: 1,
      proposed: 1,
      failed: 0,
    });
  });
});
