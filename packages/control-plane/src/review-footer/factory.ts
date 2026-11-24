import { resolveAppName } from "@open-inspect/shared/app-name";
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
import { scanTurnToolCalls } from "./tool-call-scan";

const HINDSIGHT = /hindsight/i;

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
    scanToolCalls: (messageId, visit) => scanTurnToolCalls(deps.events, messageId, visit),
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
