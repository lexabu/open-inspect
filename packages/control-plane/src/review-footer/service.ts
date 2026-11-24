/**
 * After a GitHub-triggered turn completes, ends each review or conversation comment the
 * turn posted with the footer line. Best effort and bounded: anything it cannot do is
 * logged and left as it was, and nothing is thrown into completion handling.
 */
import { isBotLogin } from "@open-inspect/shared/github-mention";
import type { Logger } from "../logger";
import type { MessageRow, SessionRow } from "../session/types";
import type { FooterGitHub } from "./github";
import { applyFooter, renderFooterLine } from "./render";
import {
  countMemoryActivity,
  findSessionPosts,
  type SessionPost,
  type ToolCallEvent,
} from "./session-activity";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

type PostOutcome = "updated" | "unchanged" | "not_bot_post" | "refused" | "failed";

/** A repository as the footer needs it; `fullName` is lower case. */
interface FooterRepository {
  owner: string;
  name: string;
  id: number;
  fullName: string;
}

export interface ReviewFooterDeps {
  getSession(): SessionRow | null;
  getMessage(messageId: string): MessageRow | null;
  /** The turn's tool calls, or null when there are too many to read them all. */
  listToolCalls(messageId: string): ToolCallEvent[] | null;
  /** Whether the repository has the `reviewFooter` setting on. */
  footerEnabled(repository: FooterRepository): Promise<boolean>;
  /** Names of the Hindsight MCP servers the repository's sessions get. */
  hindsightServers(repository: FooterRepository): Promise<string[]>;
  /** GitHub for the repository, or null when the GitHub App is not configured. */
  github(repository: FooterRepository): FooterGitHub | null;
  botUsername: string;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export class ReviewFooter {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ReviewFooterDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Footers the posts of the turn `messageId`. Never throws. */
  async apply(messageId: string): Promise<void> {
    try {
      await this.run(messageId);
    } catch (error) {
      this.deps.log.error("review_footer", {
        message_id: messageId,
        outcome: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  private async run(messageId: string): Promise<void> {
    const { log } = this.deps;
    const skip = (reason: string, fields: Record<string, unknown> = {}) =>
      log.info("review_footer", { message_id: messageId, outcome: "skipped", reason, ...fields });

    const message = this.deps.getMessage(messageId);
    if (message?.source !== "github") {
      log.debug("review_footer", {
        message_id: messageId,
        outcome: "skipped",
        reason: "not_github",
      });
      return;
    }
    const session = this.deps.getSession();
    if (!session?.repo_owner || !session.repo_name || session.repo_id === null) {
      return skip("no_repository");
    }
    const repository: FooterRepository = {
      owner: session.repo_owner,
      name: session.repo_name,
      id: session.repo_id,
      fullName: `${session.repo_owner}/${session.repo_name}`.toLowerCase(),
    };
    if (!(await this.deps.footerEnabled(repository))) {
      log.debug("review_footer", { message_id: messageId, outcome: "skipped", reason: "disabled" });
      return;
    }
    const github = this.deps.github(repository);
    if (!github) return skip("github_app_not_configured");
    const toolCalls = this.deps.listToolCalls(messageId);
    if (!toolCalls) return skip("too_many_tool_calls");
    const posts = findSessionPosts(toolCalls, repository);
    if (posts.length === 0) return skip("no_post");

    const memory = countMemoryActivity(toolCalls, await this.deps.hindsightServers(repository));
    const modelId = message.model ?? session.model;
    const outcomes: Record<string, PostOutcome> = {};
    for (const post of posts) {
      const line = renderFooterLine({
        kind: post.kind,
        modelId,
        totalCostUsd: session.total_cost,
        memory,
      });
      outcomes[`${post.kind}:${post.id}`] = await this.footerPost(github, post, line);
    }
    const fields = { message_id: messageId, repo: repository.fullName, posts: outcomes };
    const failed = Object.values(outcomes).some(
      (outcome) => outcome !== "updated" && outcome !== "unchanged"
    );
    if (failed) log.warn("review_footer", { ...fields, outcome: "partial" });
    else log.info("review_footer", { ...fields, outcome: "success" });
  }

  /** One edit per post: read it, check it is the App's, write the footer; retried a few times. */
  private async footerPost(
    github: FooterGitHub,
    post: SessionPost,
    line: string
  ): Promise<PostOutcome> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(RETRY_DELAY_MS * (attempt - 1));
      const read = await github.readPost(post);
      if (read.outcome === "refused") return "refused";
      if (read.outcome === "failed") continue;
      if (!isBotLogin(read.value.author, this.deps.botUsername)) return "not_bot_post";
      const body = applyFooter(read.value.body, line);
      if (body === read.value.body) return "unchanged";
      const write = await github.writePost(post, body);
      if (write.outcome === "ok") return "updated";
      if (write.outcome === "refused") return "refused";
    }
    return "failed";
  }
}
