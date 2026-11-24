/**
 * Open-Inspect GitHub Bot Worker
 *
 * Cloudflare Worker that handles GitHub webhook events and provides
 * automated code review and comment-triggered actions via the coding agent.
 */

import { Hono } from "hono";
import type { Env } from "./types";
import type { Logger } from "./logger";
import { createLogger, parseLogLevel } from "./logger";
import { verifyWebhookSignature } from "./verify";
import { normalizeGitHubEvent } from "@open-inspect/shared/triggers";
import { signedControlPlaneFetch } from "./internal-auth";
import {
  baseChangePayloadSchema,
  checkRunPayloadSchema,
  issueCommentPayloadSchema,
  pullRequestOpenedPayloadSchema,
  pullRequestChangedPayloadSchema,
  reviewCommentPayloadSchema,
  reviewRequestedPayloadSchema,
  reviewSubmittedPayloadSchema,
  webhookActionPayloadSchema,
  webhookSummaryPayloadSchema,
  type WebhookSummaryPayload,
} from "./payload-schemas";
import {
  handlePullRequestOpened,
  handleReviewRequested,
  handleCheckRunReviewRequested,
  handleIssueComment,
  handleReviewComment,
  isReviewRequestedForBot,
  isReviewByBot,
  type HandlerResult,
} from "./handlers";
import {
  concludeStuckCheck,
  handleBotReviewSubmitted,
  handlePullRequestChanged,
} from "./ai-review-check";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { toAutofixEnvelope } from "./autofix-ingress";

const app = new Hono<{ Bindings: Env }>();
const DELIVERY_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_PROCESSING_TTL_MS = 5 * 60 * 1_000;
const DELIVERY_STATUS_PROCESSING = "processing";
const DELIVERY_STATUS_PROCESSED = "processed";

function getDeliveryDedupeKey(deliveryId: string): string {
  return `delivery:${deliveryId}`;
}

app.get("/health", (c) => c.json({ status: "healthy", service: "open-inspect-github-bot" }));

app.post("/webhooks/github", async (c) => {
  const log = createLogger("webhook", {}, parseLogLevel(c.env.LOG_LEVEL));
  const cacheStore = createKvCacheStore(c.env.GITHUB_KV);

  const rawBody = await c.req.text();
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const event = c.req.header("X-GitHub-Event");
  const deliveryId = c.req.header("X-GitHub-Delivery");

  const valid = await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    log.warn("webhook.signature_invalid", { delivery_id: deliveryId });
    return c.json({ error: "invalid signature" }, 401);
  }

  let dedupeKey: string | null = null;
  if (deliveryId) {
    dedupeKey = getDeliveryDedupeKey(deliveryId);
    const existing = await cacheStore.get(dedupeKey);
    if (existing) {
      log.info("webhook.duplicate_delivery", {
        delivery_id: deliveryId,
        event_type: event,
        dedupe_status: existing,
      });
      // The first attempt may still clear its marker, so don't acknowledge this one yet.
      if (existing === DELIVERY_STATUS_PROCESSING) {
        return c.json({ error: "Delivery still processing" }, 503);
      }
      return c.json({ ok: true, duplicate: true });
    }

    await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSING, {
      ttlMs: DELIVERY_PROCESSING_TTL_MS,
    });
  } else {
    log.warn("webhook.delivery_id_missing", { event_type: event });
  }

  const payload: unknown = JSON.parse(rawBody);
  const summaryResult = webhookSummaryPayloadSchema.safeParse(payload);
  const summary = summaryResult.success ? summaryResult.data : null;
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const action = summary?.action ?? (actionResult.success ? actionResult.data.action : undefined);
  const traceId = crypto.randomUUID();

  log.info("webhook.received", {
    event_type: event,
    delivery_id: deliveryId,
    trace_id: traceId,
    repo: summary?.repository
      ? `${summary.repository.owner.login}/${summary.repository.name}`
      : undefined,
    action,
  });

  const autofixEnvelope = toAutofixEnvelope({
    event,
    payload,
    deliveryId: deliveryId ?? `missing:${traceId}`,
    botUsername: c.env.GITHUB_BOT_USERNAME,
    receivedAt: new Date(),
  });
  let autofixEnqueueFailed = false;
  if (autofixEnvelope) {
    try {
      await c.env.AUTOFIX_QUEUE.send(autofixEnvelope);
    } catch (err) {
      autofixEnqueueFailed = true;
      log.error("webhook.autofix_queue_failed", {
        trace_id: traceId,
        delivery_id: deliveryId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  const clearDedupeMarker = async () => {
    if (!dedupeKey) return;
    try {
      await cacheStore.delete(dedupeKey);
    } catch (err) {
      log.warn("webhook.dedupe_clear_failed", {
        trace_id: traceId,
        delivery_id: deliveryId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  };

  c.executionCtx.waitUntil(
    handleWebhook(c.env, log, event, payload, traceId, deliveryId)
      .then(async () => {
        if (!dedupeKey) return;
        // Keep the in-flight lease until dispatch settles, then leave the delivery
        // redeliverable; its dispatch checkpoint prevents a second session.
        if (autofixEnqueueFailed) return clearDedupeMarker();

        try {
          await cacheStore.put(dedupeKey, DELIVERY_STATUS_PROCESSED, {
            ttlMs: DELIVERY_DEDUPE_TTL_MS,
          });
        } catch (err) {
          log.warn("webhook.dedupe_finalize_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      })
      .catch(async (err) => {
        await clearDedupeMarker();

        log.error("webhook.processing_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      })
  );

  // GitHub does not retry failed deliveries; a 5xx marks this one for manual redelivery.
  if (autofixEnqueueFailed) return c.json({ error: "Autofix enqueue failed" }, 503);
  return c.json({ ok: true });
});

/** Skips that already posted a PR comment explaining why no session started. */
const COMMENTED_SKIP_REASONS: ReadonlySet<string> = new Set([
  "not_member",
  "target_team_missing_grant",
  "team_archived",
  "invalid_inline_flags",
  "model_preferences_unavailable",
  "harness_model_incompatible",
  "override_missing_reason",
  "override_by_author",
  "override_not_authorized",
]);

async function handleWebhook(
  env: Env,
  log: Logger,
  event: string | undefined,
  payload: unknown,
  traceId: string,
  deliveryId: string | undefined
): Promise<void> {
  const parsed = webhookSummaryPayloadSchema.safeParse(payload);
  const actionResult = webhookActionPayloadSchema.safeParse(payload);
  const p: WebhookSummaryPayload = parsed.success
    ? parsed.data
    : { action: actionResult.success ? actionResult.data.action : undefined };
  const repo = p.repository ? `${p.repository.owner.login}/${p.repository.name}` : undefined;
  const sender = p.sender?.login;
  const pullNumber = p.pull_request?.number ?? p.issue?.number;

  const wideEventBase = {
    trace_id: traceId,
    delivery_id: deliveryId,
    event_type: event,
    action: p.action,
    repo,
    pull_number: pullNumber,
    sender,
  };

  const start = Date.now();
  const cacheStore = createKvCacheStore(env.GITHUB_KV);
  const dispatchKey = deliveryId ? `delivery-dispatch:${deliveryId}` : null;
  let result: HandlerResult | undefined;
  let dispatchFailure: { error: unknown } | undefined;

  try {
    if (dispatchKey && (await cacheStore.get(dispatchKey)) === DELIVERY_STATUS_PROCESSED) {
      result = { outcome: "skipped", skip_reason: "dispatch_completed" };
    } else {
      result = await dispatchHandler(env, log, event, p, payload, traceId);
      if (
        dispatchKey &&
        (result.outcome === "processed" || COMMENTED_SKIP_REASONS.has(result.skip_reason))
      ) {
        // Checkpoint completed external effects; preflight skips must be reevaluated.
        await cacheStore.put(dispatchKey, DELIVERY_STATUS_PROCESSED, {
          ttlMs: DELIVERY_DEDUPE_TTL_MS,
        });
      }
    }
  } catch (err) {
    dispatchFailure = { error: err };
    log.info("webhook.handled", {
      ...wideEventBase,
      outcome: "error",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  if (result !== undefined) {
    const wideEvent: Record<string, unknown> = {
      ...wideEventBase,
      outcome: result.outcome,
      duration_ms: Date.now() - start,
    };
    if (result.outcome === "skipped") {
      wideEvent.skip_reason = result.skip_reason;
    } else {
      wideEvent.session_ids = result.sessions.map((session) => session.session_id);
      wideEvent.message_ids = result.sessions.map((session) => session.message_id);
      wideEvent.models = result.sessions.map((session) => session.model);
      wideEvent.handler_action = result.handler_action;
    }
    log.info("webhook.handled", wideEvent);
  }

  // A review session that died without posting sends no webhook of its own, so any
  // webhook for its pull request closes an AI Review check left in progress.
  if (p.repository && pullNumber !== undefined) {
    try {
      await concludeStuckCheck(env, log, p.repository, pullNumber);
    } catch (err) {
      log.warn("webhook.stuck_check_failed", {
        ...wideEventBase,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // Forwarding and built-in dispatch are independent; both must run before a
  // failure reaches the waitUntil cleanup path. Use the passthrough parse so
  // nested lifecycle fields are not stripped by the summary schema.
  let forwardingFailure: { error: unknown } | undefined;
  if (event) {
    const normalizationPayload = actionResult.success ? actionResult.data : {};
    const normalizedEvent = normalizeGitHubEvent(event, normalizationPayload, deliveryId);
    if (normalizedEvent !== null) {
      try {
        const url = "https://internal/internal/github-event";
        const body = JSON.stringify(normalizedEvent);
        const response = await signedControlPlaneFetch(env, { method: "POST", url, body, traceId });
        if (!response.ok) {
          forwardingFailure = {
            error: new Error(`GitHub event forwarding failed: ${response.status}`),
          };
          log.warn("webhook.github_event_forward_failed", {
            trace_id: traceId,
            delivery_id: deliveryId,
            event_type: event,
            status: response.status,
          });
        }
      } catch (err) {
        forwardingFailure = { error: err };
        log.warn("webhook.github_event_forward_error", {
          trace_id: traceId,
          delivery_id: deliveryId,
          event_type: event,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  if (dispatchFailure !== undefined) throw dispatchFailure.error;
  if (forwardingFailure !== undefined) throw forwardingFailure.error;
}

function isBaseChange(payload: unknown): boolean {
  const parsed = baseChangePayloadSchema.safeParse(payload);
  return parsed.success && parsed.data.changes?.base !== undefined;
}

function dispatchHandler(
  env: Env,
  log: Logger,
  event: string | undefined,
  p: WebhookSummaryPayload,
  payload: unknown,
  traceId: string
): Promise<HandlerResult> {
  switch (event) {
    case "pull_request":
      if (p.action === "opened" || p.action === "ready_for_review") {
        const parsed = pullRequestOpenedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error(`Malformed pull_request ${p.action} payload`);
        return handlePullRequestOpened(env, log, parsed.data, traceId);
      }
      // A retargeted base changes the diff just as a push does; other edits do not.
      if (p.action === "synchronize" || (p.action === "edited" && isBaseChange(payload))) {
        const parsed = pullRequestChangedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error(`Malformed pull_request ${p.action} payload`);
        return handlePullRequestChanged(env, log, parsed.data, traceId);
      }
      if (p.action === "review_requested") {
        if (!isReviewRequestedForBot(payload, env.GITHUB_BOT_USERNAME)) {
          return Promise.resolve({ outcome: "skipped", skip_reason: "review_not_for_bot" });
        }
        const parsed = reviewRequestedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request review_requested payload");
        return handleReviewRequested(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "issue_comment":
      if (p.action === "created") {
        const parsed = issueCommentPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed issue_comment created payload");
        return handleIssueComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review":
      if (p.action === "submitted") {
        if (!isReviewByBot(payload, env.GITHUB_BOT_USERNAME)) {
          return Promise.resolve({ outcome: "skipped", skip_reason: "review_not_by_bot" });
        }
        const parsed = reviewSubmittedPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Malformed pull_request_review submitted payload");
        return handleBotReviewSubmitted(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "check_run":
      if (p.action === "rerequested" || p.action === "requested_action") {
        const parsed = checkRunPayloadSchema.safeParse(payload);
        if (!parsed.success) throw new Error(`Malformed check_run ${p.action} payload`);
        return handleCheckRunReviewRequested(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    case "pull_request_review_comment":
      if (p.action === "created") {
        const parsed = reviewCommentPayloadSchema.safeParse(payload);
        if (!parsed.success)
          throw new Error("Malformed pull_request_review_comment created payload");
        return handleReviewComment(env, log, parsed.data, traceId);
      }
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_action",
      });
    default:
      return Promise.resolve({
        outcome: "skipped",
        skip_reason: "unsupported_event",
      });
  }
}

export default app;
