/**
 * `@bot override <commit> <reason>`: someone with write access who did not author the
 * pull request passes the head's AI Review check, on the record.
 */
import { botHandle, containsBotMention } from "@open-inspect/shared/github-mention";
import { escapeRegExp } from "@open-inspect/shared/regex";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { checkSenderPermission, postIssueComment, postReaction } from "./github-auth";
import { hashPullRequestDiff } from "./ai-review-diff";
import {
  deleteAttempt,
  openGate,
  overrideHint,
  postCheck,
  processed,
  readPullRequest,
  sharedHeadReason,
  short,
  skipped,
  writeVerdict,
  type Repository,
} from "./ai-review-gate";
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
 * `@bot override <commit> <reason>`. Anything looser is not a command, so a request in
 * prose ("@bot override the retry limit for this client") stays a request to the bot.
 */
export function parseOverrideCommand(body: string, botUsername: string): OverrideCommand | null {
  if (!containsBotMention(body, botUsername)) return null;
  const command = new RegExp(
    `^@${escapeRegExp(botHandle(botUsername))}(?:\\[bot\\])?[ \\t]+override[ \\t]+([0-9a-f]{7,64})(?:[ \\t]+(.*))?$`,
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
    repository: Repository;
    pullNumber: number;
    commentId: number;
    sender: { login: string; type?: string };
    command: OverrideCommand;
  }
): Promise<HandlerResult | null> {
  const { repository, pullNumber, sender, command } = params;
  const gate = await openGate(env, log, repository);
  if (!gate) return null;
  // Another bot gets no reply: two bots answering each other would loop.
  if (sender.type === "Bot") return skipped("override_not_authorized");

  // Each comment overrides once, however often its webhook is delivered.
  const appliedKey = `ai-review:override:${gate.repo}#${params.commentId}`;
  if ((await gate.store.get(appliedKey)) !== null) return skipped("override_already_applied");

  const { token, userAgent, repoUrl } = gate.client;
  const meta = {
    trace_id: traceId,
    repo: gate.repo,
    pull_number: pullNumber,
    sender: sender.login,
  };
  const refuse = async (skip_reason: string, reply: string): Promise<HandlerResult> => {
    const commentsUrl = `${repoUrl}/issues/${pullNumber}/comments`;
    if (!(await postIssueComment(token, commentsUrl, reply, userAgent))) {
      log.warn("check.override_reply_failed", { ...meta, skip_reason });
    }
    log.info("check.override_refused", { ...meta, skip_reason });
    return skipped(skip_reason);
  };

  if (!command.reason) {
    return refuse("override_missing_reason", `An override needs a reason: ${overrideHint(env)}.`);
  }
  const pr = await readPullRequest(gate, pullNumber);
  if (pr.state !== "open") return skipped("pr_not_open");
  const headSha = pr.head.sha;
  if (!headSha.startsWith(command.commit)) {
    return refuse(
      "override_wrong_commit",
      `\`${command.commit}\` is not the head of this pull request. The head is \`${short(headSha)}\`; an override applies only to the commit it names.`
    );
  }
  if (sender.login.toLowerCase() === pr.user.login.toLowerCase()) {
    return refuse(
      "override_by_author",
      "The author of a pull request can't override its AI Review check."
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
  const shared = await sharedHeadReason(gate, pullNumber, headSha);
  if (shared !== null)
    return refuse("override_shared_head", `${shared} The check can't be overridden.`);

  const summary = `@${sender.login} overrode the AI Review check on commit \`${short(headSha)}\`.\n\nReason: ${command.reason}`;
  // A new check run, and no attempt left to conclude: a review still in flight on this
  // head can no longer change the check.
  await deleteAttempt(gate, pullNumber);
  await postCheck(gate, pullNumber, headSha, {
    status: "completed",
    conclusion: "success",
    output: { title: `Overridden by @${sender.login}`, summary },
    reviewAction: false,
  });
  const diffHash = await hashPullRequestDiff(gate.client, pr.base.sha, headSha);
  await writeVerdict(gate, pullNumber, {
    sha: headSha,
    reviewedSha: headSha,
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    diffHash,
    approved: true,
    summary,
    attemptId: null,
  });
  await gate.store.put(appliedKey, headSha, { ttlMs: OVERRIDE_RECORD_TTL_MS });
  const reactionsUrl = `${repoUrl}/issues/comments/${params.commentId}/reactions`;
  if (!(await postReaction(token, reactionsUrl, "+1", userAgent))) {
    log.warn("acknowledgment.failed", meta);
  }
  log.info("check.overridden", { ...meta, head_sha: headSha });
  return processed("check_overridden");
}
