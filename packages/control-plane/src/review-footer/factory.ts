import { resolveAppName } from "@open-inspect/shared/app-name";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import { getGitHubAppConfig } from "../auth/github-app";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { McpServerStore } from "../db/mcp-servers";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { EventRepository } from "../session/event-repository";
import type { MessageRepository } from "../session/message-repository";
import type { SessionCoreRepository } from "../session/session-core-repository";
import type { Env } from "../types";
import { createFooterGitHub } from "./github";
import { ReviewFooter } from "./service";
import type { ToolCallEvent } from "./session-activity";

/** More tool calls than a review turn makes; a turn beyond it is not footered. */
const MAX_TOOL_CALLS = 2_000;
const HINDSIGHT = /hindsight/i;

function parseToolCall(data: string): ToolCallEvent {
  const parsed = sandboxEventSchema.safeParse(JSON.parse(data));
  if (!parsed.success || parsed.data.type !== "tool_call") {
    throw new Error("Malformed persisted tool_call event");
  }
  return parsed.data;
}

/** The review footer over one session's own storage, this deployment's settings and GitHub App. */
export function createReviewFooter(deps: {
  env: Env;
  db: SqlDatabase;
  encryptionKey: string;
  log: Logger;
  sessions: Pick<SessionCoreRepository, "getSession">;
  messages: Pick<MessageRepository, "getMessageById">;
  events: Pick<EventRepository, "listEventPage">;
}): ReviewFooter {
  const { env, db, log } = deps;
  const settings = new IntegrationSettingsStore(db);
  return new ReviewFooter({
    getSession: () => deps.sessions.getSession(),
    getMessage: (messageId) => deps.messages.getMessageById(messageId),
    listToolCalls: (messageId) => {
      const page = deps.events.listEventPage({
        type: "tool_call",
        messageId,
        limit: MAX_TOOL_CALLS,
      });
      return page.hasMore ? null : page.events.map((row) => parseToolCall(row.data));
    },
    footerEnabled: async ({ fullName }) => {
      const resolved = await settings.getResolvedConfig("github", fullName);
      if (resolved.enabledRepos !== null && !resolved.enabledRepos.includes(fullName)) return false;
      return resolved.settings.reviewFooter ?? false;
    },
    hindsightServers: async ({ fullName }) =>
      (await new McpServerStore(db, deps.encryptionKey).list(fullName))
        .filter(
          (server) =>
            server.enabled && (HINDSIGHT.test(server.name) || HINDSIGHT.test(server.url ?? ""))
        )
        .map((server) => server.name),
    github: (repository) => {
      const config = getGitHubAppConfig(env);
      return config ? createFooterGitHub(config, repository, resolveAppName(env)) : null;
    },
    botUsername: env.GITHUB_BOT_USERNAME,
    log,
  });
}
