/**
 * Environment bindings for the GitHub Bot Cloudflare Worker.
 */
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import type { GitHubAutofixEnvelope } from "@open-inspect/shared";

export interface Env {
  /** KV namespace for deduplicating webhook deliveries. */
  GITHUB_KV: KVNamespace;

  /** Durable handoff for pull request feedback that may trigger Autofix. */
  AUTOFIX_QUEUE: Queue<GitHubAutofixEnvelope>;

  /** Service binding to the control plane worker. */
  CONTROL_PLANE: ControlPlaneFetcher;

  /** Deployment name for logging/identification. */
  DEPLOYMENT_NAME: string;

  /** Display name shown in user-visible bot messages and HTTP User-Agent headers. */
  APP_NAME?: string;

  /** Default model ID for new sessions. */
  DEFAULT_MODEL: string;

  /** GitHub App bot username (e.g., "open-inspect-bot[bot]"). */
  GITHUB_BOT_USERNAME: string;

  /** The web app's public URL, where a GitHub sender signs in once before using the bot. */
  WEB_APP_URL?: string;

  /** Short command that also calls the bot (e.g., "npai" for `/npai` and `npai`); unset for none. */
  GITHUB_BOT_COMMAND?: string;

  /** GitHub App ID for JWT generation. */
  GITHUB_APP_ID: string;

  /** GitHub App private key (PKCS#8 PEM) for JWT signing. */
  GITHUB_APP_PRIVATE_KEY: string;

  /** GitHub App installation ID for token exchange. */
  GITHUB_APP_INSTALLATION_ID: string;

  /** Webhook secret for verifying GitHub webhook signatures. */
  GITHUB_WEBHOOK_SECRET: string;

  /** Per-service sig1 signing secret. */
  SERVICE_AUTH_SECRET?: string;

  /** Optional log level override. */
  LOG_LEVEL?: string;
}

export type {
  CheckRunPayload,
  IssueCommentPayload,
  PullRequestOpenedPayload,
  PullRequestChangedPayload,
  ReviewCommentPayload,
  ReviewRequestedPayload,
  CheckSuitePayload,
} from "./payload-schemas";
