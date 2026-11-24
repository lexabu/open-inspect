import { resolveAppName } from "@open-inspect/shared/app-name";
import { getGitHubAppConfig } from "../auth/github-app";
import { IntegrationSettingsStore } from "../db/integration-settings";
import type { SqlDatabase } from "../db/sql-database";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { ReviewGate } from "./gate";
import { createGateGitHub } from "./github";
import { ReviewGateStore } from "./store";

const log = createLogger("github-review");

/** The AI Review merge gate over this deployment's database, settings and GitHub App. */
export function createReviewGate(env: Env, db: SqlDatabase): ReviewGate {
  const settings = new IntegrationSettingsStore(db);
  return new ReviewGate({
    store: new ReviewGateStore(db),
    github: (repository) => {
      const config = getGitHubAppConfig(env);
      if (!config) throw new Error("GitHub App not configured - the AI Review gate cannot run");
      return createGateGitHub(config, repository, resolveAppName(env));
    },
    mode: async (repository) => {
      const repo = `${repository.owner}/${repository.name}`.toLowerCase();
      const resolved = await settings.getResolvedConfig("github", repo);
      if (resolved.enabledRepos !== null && !resolved.enabledRepos.includes(repo)) return "off";
      return resolved.settings.mergeGate ?? "off";
    },
    botUsername: env.GITHUB_BOT_USERNAME,
    now: () => Date.now(),
    log,
  });
}
