/**
 * `@bot override <commit> <reason>`: someone with write access who did not author the
 * pull request passes the head's AI Review check, on the record.
 */
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  botHandle,
  containsBotMention,
  lineTriggerSource,
} from "@open-inspect/shared/github-mention";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { checkSenderPermission, postIssueComment, postReaction } from "./github-auth";
import { mergeGateEnabled, repositoryClient, type GateRepository } from "./review-gate";
import { requestGateOverride } from "./review-gate-client";
import type { HandlerResult } from "./session-startup";

const MAX_OVERRIDE_REASON_LENGTH = 1_000;
const OVERRIDE_RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface OverrideCommand {
  /** At least seven hex characters of the commit being overridden. */
  commit: string;
  /** Empty when the comment gave none. */
  reason: string;
}

/**
 * The override in a comment: a line of its own, outside code fences, that reads
 * `<trigger> override <commit> <reason>`, where the trigger is `@bot` or the bot's short
 * command. Anything looser is not a command, so a request in prose ("@bot override the
 * retry limit for this client") stays a request to the bot.
 */
export function parseOverrideCommand(
  body: string,
  botUsername: string,
  botCommand: string | undefined
): OverrideCommand | null {
  if (!containsBotMention(body, botUsername, botCommand)) return null;
  const command = new RegExp(
    `^${lineTriggerSource(botUsername, botCommand)}[ \\t]+override[ \\t]+([0-9a-f]{7,64})(?:[ \\t]+(.*))?$`,
    "i"
  );
  let fenced = false;
  for (const line of body.split("\n")) {
    const text = line.trim();
    if (/^(?:```|~~~)/.test(text)) {
      fenced = !fenced;
      continue;
    }
    const match = fenced ? null : command.exec(text);
    if (match) {
      return {
        commit: match[1].toLowerCase(),
        reason: (match[2] ?? "").trim().slice(0, MAX_OVERRIDE_REASON_LENGTH),
      };
    }
  }
  return null;
}

/**
 * Applies an override comment. Returns null where the gate is off: the comment is then
 * an ordinary mention.
 */
export async function handleOverrideComment(
  env: Env,
  log: Logger,
  traceId: string,
  params: {
    repository: GateRepository;
    pullNumber: number;
    commentId: number;
    sender: { login: string; type?: string };
    command: OverrideCommand;
  }
): Promise<HandlerResult | null> {
  const { repository, pullNumber, sender, command } = params;
  if (!(await mergeGateEnabled(env, log, repository))) return null;
  const skipped = (skip_reason: string): HandlerResult => ({ outcome: "skipped", skip_reason });
  // Another bot gets no reply: two bots answering each other would loop.
  if (sender.type === "Bot") return skipped("override_not_authorized");

  // Each comment overrides once, however often its webhook is delivered.
  const store = createKvCacheStore(env.GITHUB_KV);
  const fullName = `${repository.owner.login}/${repository.name}`.toLowerCase();
  const appliedKey = `ai-review:override:${fullName}#${params.commentId}`;
  if ((await store.get(appliedKey)) !== null) return skipped("override_already_applied");

  const { token, userAgent, repoUrl } = await repositoryClient(env, repository);
  const meta = { trace_id: traceId, repo: fullName, pull_number: pullNumber, sender: sender.login };
  const refuse = async (skip_reason: string, reply: string): Promise<HandlerResult> => {
    const commentsUrl = `${repoUrl}/issues/${pullNumber}/comments`;
    if (!(await postIssueComment(token, commentsUrl, reply, userAgent))) {
      log.warn("review_gate.override_reply_failed", { ...meta, skip_reason });
    }
    log.info("review_gate.override_refused", { ...meta, skip_reason });
    return skipped(skip_reason);
  };

  if (!command.reason) {
    return refuse(
      "override_missing_reason",
      `An override needs a reason: \`@${botHandle(env.GITHUB_BOT_USERNAME)} override <commit> <reason>\`.`
    );
  }
  const permission = await checkSenderPermission(
    token,
    repository.owner.login,
    repository.name,
    sender.login,
    userAgent
  );
  if (permission.error) return skipped("permission_check_failed");
  if (!permission.hasPermission) {
    return refuse(
      "override_not_authorized",
      "Only someone with write access to this repository can override the AI Review check."
    );
  }

  const response = await requestGateOverride(env, traceId, {
    repository: { owner: repository.owner.login, name: repository.name },
    pullNumber,
    commit: command.commit,
    reason: command.reason,
    overriddenBy: sender.login,
  });
  if (response.outcome === "refused") {
    const skip_reason =
      response.reason === "pr_not_open" || response.reason === "merge_gate_off"
        ? response.reason
        : `override_${response.reason}`;
    return response.detail ? refuse(skip_reason, response.detail) : skipped(skip_reason);
  }

  await store.put(appliedKey, response.headSha, { ttlMs: OVERRIDE_RECORD_TTL_MS });
  const reactionsUrl = `${repoUrl}/issues/comments/${params.commentId}/reactions`;
  if (!(await postReaction(token, reactionsUrl, "+1", userAgent))) {
    log.warn("acknowledgment.failed", meta);
  }
  log.info("review_gate.overridden", { ...meta, head_sha: response.headSha });
  return { outcome: "processed", sessions: [], handler_action: "check_overridden" };
}
