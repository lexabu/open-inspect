import { vi } from "vitest";
import type { Logger } from "../logger";
import type { MessageRow, SessionRow } from "../session/types";
import type { FooterCall, FooterGitHub, PostContent } from "./github";
import { ReviewFooter, type ReviewFooterDeps } from "./service";
import type { SessionPost, ToolCallEvent } from "./session-activity";

const BOT = "nativepath-ai[bot]";
const SOL = "amazon-bedrock/openai.gpt-6.2-sol";
export const OPUS = "anthropic/claude-opus-4-5";

export function session(overrides: Partial<SessionRow> = {}): SessionRow {
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

export function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    author_id: "github:1",
    content: "You are reviewing Pull Request #7 in acme/widgets.\nThe repository has been cloned.",
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

let callSequence = 0;

export function bash(command: string, output: string): ToolCallEvent {
  callSequence += 1;
  return {
    type: "tool_call",
    messageId: "msg-1",
    callId: `call-${callSequence}`,
    tool: "bash",
    args: { command },
    status: "completed",
    output,
    sandboxId: "sb",
    timestamp: 1,
  };
}
export const postedReview = (id: number) =>
  bash(
    "gh api repos/acme/widgets/pulls/7/reviews --method POST --input -",
    JSON.stringify({
      id,
      html_url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
    })
  );
export const postedComment = (id: number) =>
  bash("gh pr comment 7 --body x", `https://github.com/acme/widgets/pull/7#issuecomment-${id}`);
export const recalled = (facts: number): ToolCallEvent => ({
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

export type Answer = "refused" | "failed";

/** GitHub as a map of posts; scripted answers come first, one per call. */
export class FakeGitHub implements FooterGitHub {
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

export function footer(
  github: FakeGitHub | null,
  toolCalls: ToolCallEvent[] | null,
  overrides: Partial<ReviewFooterDeps> = {}
) {
  const log = fakeLog();
  const sleep = vi.fn(async () => {});
  const deps: ReviewFooterDeps = {
    getSession: () => session(),
    getMessage: (id) => message({ id }),
    scanToolCalls: (_messageId, visit) => {
      if (toolCalls === null) return false;
      toolCalls.forEach(visit);
      return true;
    },
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
