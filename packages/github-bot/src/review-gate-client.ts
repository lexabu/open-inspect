/**
 * The bot's calls to the control plane's AI Review merge gate. The bot handles GitHub's
 * webhooks and decides who may ask for a review; the control plane owns the review
 * attempts, runs their sessions out of everyone's reach, and writes the check run.
 */
import {
  gateOverrideResponseSchema,
  gatePullChangeResponseSchema,
  startGateReviewResponseSchema,
  type GateOverrideRequest,
  type GateOverrideResponse,
  type GatePullChangeRequest,
  type GatePullChangeResponse,
  type StartGateReviewRequest,
  type StartGateReviewResponse,
} from "@open-inspect/shared/types/github-review-gate";
import type { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

async function post<T>(
  env: Env,
  traceId: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>
): Promise<T> {
  const response = await signedControlPlaneFetch(env, {
    method: "POST",
    url: `https://internal/github/review-gate/${path}`,
    body: JSON.stringify(body),
    traceId,
  });
  if (!response.ok) {
    throw new Error(`Review gate ${path} failed: ${response.status} ${await response.text()}`);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Review gate ${path} failed: invalid response`);
  return parsed.data;
}

export function startGateReview(
  env: Env,
  traceId: string,
  request: StartGateReviewRequest
): Promise<StartGateReviewResponse> {
  return post(env, traceId, "reviews", request, startGateReviewResponseSchema);
}

export function reportPullChange(
  env: Env,
  traceId: string,
  request: GatePullChangeRequest
): Promise<GatePullChangeResponse> {
  return post(env, traceId, "pull-changes", request, gatePullChangeResponseSchema);
}

export function requestGateOverride(
  env: Env,
  traceId: string,
  request: GateOverrideRequest
): Promise<GateOverrideResponse> {
  return post(env, traceId, "overrides", request, gateOverrideResponseSchema);
}
