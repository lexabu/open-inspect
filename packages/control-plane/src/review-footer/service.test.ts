import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { MessageRow, SessionRow } from "../session/types";
import type { FooterCall, FooterGitHub, PostContent } from "./github";
import { REVIEW_FOOTER_MARKER } from "./render";
import { ReviewFooter, type ReviewFooterDeps } from "./service";
import type { SessionPost, ToolCallEvent } from "./session-activity";

const BOT = "nativepath-ai[bot]";
const SOL = "amazon-bedrock/openai.gpt-6.2-sol";
const OPUS = "anthropic/claude-opus-4-5";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-1",
    title: null,
    repo_owner: "acme",
    repo_name: "widgets",
    repo_id: 99,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    agent_session_id: null,
    harness: "opencode",
    model: SOL,
    reasoning_effort: null,
    status: "active",
    status_revision: 1,
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0.0512,
    max_cost_usd: null,
    budget_exhausted: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    author_id: "github:1",
    content: "Review",
    source: "github",
    model: null,
    reasoning_effort: null,
    attachments: null,
    callback_context: null,
    client_request_id: null,
    request_fingerprint: null,
    autofix_feedback_key: null,
    autofix_pr_key: null,
    origin_context: null,
    status: "completed",
    error_message: null,
    stop_confirmation_deadline: null,
    reported_cost_usd: 0,
    created_at: 1,
    started_at: 2,
    completed_at: 3,
    ...overrides,
  };
}

function bash(command: string, output: string): ToolCallEvent {
  return {
    type: "tool_call",
    messageId: "msg-1",
    callId: command,
    tool: "bash",
    args: { command },
    status: "completed",
    output,
    sandboxId: "sb",
    timestamp: 1,
  };
}
const postedReview = (id: number) =>
  bash(
    `gh api repos/acme/widgets/pulls/7/reviews --method POST --input - # ${id}`,
    JSON.stringify({
      id,
      html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
    })
  );
const postedComment = (id: number) =>
  bash(
    `gh pr comment 7 --body x # ${id}`,
    `https://github.com/acme/widgets/pull/7#issuecomment-${id}`
  );
const recalled = (facts: number): ToolCallEvent => ({
  type: "tool_call",
  messageId: "msg-1",
  callId: `recall-${facts}`,
  tool: "mcp__hindsight-team-memory__recall",
  args: { query: "q" },
  status: "completed",
  output: JSON.stringify({ results: Array.from({ length: facts }, (_, id) => ({ id })) }),
  sandboxId: "sb",
  timestamp: 1,
});

type Answer = "refused" | "failed";

/** GitHub as a map of posts; scripted answers come first, one per call. */
class FakeGitHub implements FooterGitHub {
  readonly posts = new Map<string, PostContent>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readAnswers: Answer[] = [];
  writeAnswers: Answer[] = [];

  add(kind: SessionPost["kind"], id: number, body: string, author: string | null = BOT): this {
    this.posts.set(`${kind}:${id}`, { author, body });
    return this;
  }
  body(kind: SessionPost["kind"], id: number): string | undefined {
    return this.posts.get(`${kind}:${id}`)?.body;
  }

  async readPost(post: SessionPost): Promise<FooterCall<PostContent>> {
    const key = `${post.kind}:${post.id}`;
    this.reads.push(key);
    const answer = this.readAnswers.shift();
    if (answer === "refused") return { outcome: "refused", status: 404 };
    if (answer === "failed") return { outcome: "failed", reason: "HTTP 502" };
    const found = this.posts.get(key);
    return found ? { outcome: "ok", value: { ...found } } : { outcome: "refused", status: 404 };
  }

  async writePost(post: SessionPost, body: string): Promise<FooterCall<null>> {
    const key = `${post.kind}:${post.id}`;
    this.writes.push(key);
    const answer = this.writeAnswers.shift();
    if (answer === "refused") return { outcome: "refused", status: 422 };
    if (answer === "failed") return { outcome: "failed", reason: "HTTP 502" };
    const found = this.posts.get(key);
    if (!found) return { outcome: "refused", status: 404 };
    this.posts.set(key, { ...found, body });
    return { outcome: "ok", value: null };
  }
}

function fakeLog() {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  return log;
}

function footer(
  github: FakeGitHub | null,
  toolCalls: ToolCallEvent[] | null,
  overrides: Partial<ReviewFooterDeps> = {}
) {
  const log = fakeLog();
  const sleep = vi.fn(async () => {});
  const deps: ReviewFooterDeps = {
    getSession: () => session(),
    getMessage: (id) => message({ id }),
    listToolCalls: () => toolCalls,
    footerEnabled: async () => true,
    hindsightServers: async () => ["hindsight-team-memory"],
    github: () => github,
    botUsername: BOT,
    log,
    sleep,
    ...overrides,
  };
  return { footer: new ReviewFooter(deps), log, sleep };
}

const SOL_REVIEW_FOOTER =
  "Findings via GPT-6.2 Sol · Hindsight memory: searched, 2 facts used · Bedrock cost: $0.05";

describe("ReviewFooter", () => {
  it("footers the review a GitHub-triggered turn posted, with platform data", async () => {
    const github = new FakeGitHub().add("review", 111, "**Verdict: Approve.**");
    const { footer: subject, log } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");

    expect(github.body("review", 111)).toBe(
      `**Verdict: Approve.**\n\n${REVIEW_FOOTER_MARKER}\n${SOL_REVIEW_FOOTER}`
    );
    expect(log.info).toHaveBeenCalledWith(
      "review_footer",
      expect.objectContaining({ outcome: "success", posts: { "review:111": "updated" } })
    );
  });

  it("footers a reply comment, using the message's own model over the session's", async () => {
    const github = new FakeGitHub().add("comment", 222, "Done.");
    const { footer: subject } = footer(github, [postedComment(222)], {
      getMessage: (id) => message({ id, model: OPUS }),
      getSession: () => session({ total_cost: 0.28 }),
      hindsightServers: async () => [],
    });

    await subject.apply("msg-1");

    expect(github.body("comment", 222)).toBe(
      `Done.\n\n${REVIEW_FOOTER_MARKER}\nReply via Claude Opus 4.5 · Cost: $0.28`
    );
  });

  it("is idempotent: a re-run or redelivery leaves one footer and makes no second edit", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    const { footer: subject } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");
    await subject.apply("msg-1");

    expect(github.body("review", 111)?.split(REVIEW_FOOTER_MARKER)).toHaveLength(2);
    expect(github.writes).toEqual(["review:111"]);
  });

  it("replaces an older footer, such as one written at an earlier cost", async () => {
    const github = new FakeGitHub().add(
      "review",
      111,
      `Body\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.01`
    );
    const { footer: subject } = footer(github, [recalled(2), postedReview(111)]);

    await subject.apply("msg-1");

    expect(github.body("review", 111)).toBe(
      `Body\n\n${REVIEW_FOOTER_MARKER}\n${SOL_REVIEW_FOOTER}`
    );
  });

  it("gives each reviewer's session a footer on its own post only", async () => {
    const github = new FakeGitHub()
      .add("review", 111, "**Reviewer: GPT-6.2 Sol**")
      .add("review", 333, "**Reviewer: Claude Opus 4.5**");
    // The Opus reviewer also read the Sol review; reading is not posting.
    const solTurn = [postedReview(111)];
    const opusTurn = [
      bash(
        "gh api repos/acme/widgets/pulls/7/reviews/111",
        JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-111" })
      ),
      postedReview(333),
    ];
    const sol = footer(github, solTurn, { hindsightServers: async () => [] }).footer;
    const opus = footer(github, opusTurn, {
      getSession: () => session({ id: "session-2", model: OPUS, total_cost: 0.26 }),
      hindsightServers: async () => [],
    }).footer;

    await Promise.all([sol.apply("msg-1"), opus.apply("msg-1")]);

    expect(github.body("review", 111)).toBe(
      `**Reviewer: GPT-6.2 Sol**\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.05`
    );
    expect(github.body("review", 333)).toBe(
      `**Reviewer: Claude Opus 4.5**\n\n${REVIEW_FOOTER_MARKER}\nFindings via Claude Opus 4.5 · Cost: $0.26`
    );
  });

  describe("changes nothing and logs why", () => {
    it.each<[string, Partial<ReviewFooterDeps>, string, "debug" | "info"]>([
      [
        "a turn that did not come from GitHub",
        { getMessage: (id) => message({ id, source: "web" }) },
        "not_github",
        "debug",
      ],
      ["an unknown message", { getMessage: () => null }, "not_github", "debug"],
      [
        "a repository with the setting off",
        { footerEnabled: async () => false },
        "disabled",
        "debug",
      ],
      [
        "a session without a repository id",
        { getSession: () => session({ repo_id: null }) },
        "no_repository",
        "info",
      ],
      [
        "a deployment without the GitHub App",
        { github: () => null },
        "github_app_not_configured",
        "info",
      ],
      [
        "a turn with too many tool calls to read",
        { listToolCalls: () => null },
        "too_many_tool_calls",
        "info",
      ],
    ])("for %s", async (_case, overrides, reason, level) => {
      const github = new FakeGitHub().add("review", 111, "Body");
      const { footer: subject, log } = footer(github, [postedReview(111)], overrides);

      await subject.apply("msg-1");

      expect(github.body("review", 111)).toBe("Body");
      expect(github.reads).toEqual([]);
      expect(log[level]).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "skipped", reason })
      );
    });

    it("for a turn that posted nothing", async () => {
      const github = new FakeGitHub();
      const { footer: subject, log } = footer(github, [bash("ls", "README.md")]);

      await subject.apply("msg-1");

      expect(github.reads).toEqual([]);
      expect(log.info).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "skipped", reason: "no_post" })
      );
    });

    it("for a post that is not the App's", async () => {
      const github = new FakeGitHub().add("comment", 222, "Mine", "alice");
      const { footer: subject, log } = footer(github, [postedComment(222)]);

      await subject.apply("msg-1");

      expect(github.body("comment", 222)).toBe("Mine");
      expect(github.writes).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "partial", posts: { "comment:222": "not_bot_post" } })
      );
    });

    it("for a post GitHub refuses, without retrying", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      github.writeAnswers = ["refused"];
      const { footer: subject, log, sleep } = footer(github, [postedReview(111)]);

      await subject.apply("msg-1");

      expect(github.body("review", 111)).toBe("Body");
      expect(github.writes).toEqual(["review:111"]);
      expect(sleep).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ posts: { "review:111": "refused" } })
      );
    });

    it("when GitHub keeps failing, after a bounded number of attempts", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      github.readAnswers = ["failed", "failed", "failed", "failed"];
      const { footer: subject, log, sleep } = footer(github, [postedReview(111)]);

      await subject.apply("msg-1");

      expect(github.reads).toHaveLength(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(github.body("review", 111)).toBe("Body");
      expect(log.warn).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ posts: { "review:111": "failed" } })
      );
    });

    it("when a dependency throws, without throwing into completion handling", async () => {
      const github = new FakeGitHub().add("review", 111, "Body");
      const { footer: subject, log } = footer(github, [postedReview(111)], {
        footerEnabled: async () => {
          throw new Error("D1 unavailable");
        },
      });

      await expect(subject.apply("msg-1")).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(
        "review_footer",
        expect.objectContaining({ outcome: "error", error: new Error("D1 unavailable") })
      );
    });
  });

  it("retries a transient write failure and then footers the post", async () => {
    const github = new FakeGitHub().add("review", 111, "Body");
    github.writeAnswers = ["failed"];
    const { footer: subject } = footer(github, [postedReview(111)], {
      hindsightServers: async () => [],
    });

    await subject.apply("msg-1");

    expect(github.writes).toEqual(["review:111", "review:111"]);
    expect(github.body("review", 111)).toBe(
      `Body\n\n${REVIEW_FOOTER_MARKER}\nFindings via GPT-6.2 Sol · Bedrock cost: $0.05`
    );
  });
});
