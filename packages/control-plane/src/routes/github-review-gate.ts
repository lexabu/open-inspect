/**
 * The GitHub bot's side of the AI Review merge gate. The bot decides who may ask for a
 * review and writes its prompts; everything after that happens here, where the pull
 * request's author cannot reach it.
 */
import { Hono } from "hono";
import {
  gateOverrideRequestSchema,
  gatePullChangeRequestSchema,
  startGateReviewRequestSchema,
} from "@open-inspect/shared/types/github-review-gate";
import type { z } from "zod";
import { createReviewGate } from "../github-review/factory";
import type { GateRepository, ReviewGate } from "../github-review/gate";
import { createGateSessions } from "../github-review/sessions";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  GITHUB_SERVICE_ROUTE,
  json,
  requirePermission,
  resolveRepoOrError,
  type RouteContext,
} from "./shared";

const logger = createLogger("router:github-review-gate");
type GateContext = RouteContext<{ kind: "service" }>;
type Resolved = GateRepository & { defaultBranch: string };

/** Parses the body and resolves its repository, then runs the gate; only the bot itself may call. */
function gateRoute<T extends { repository: { owner: string; name: string } }>(
  schema: z.ZodType<T>,
  run: (
    gate: ReviewGate,
    request: T,
    repository: Resolved,
    env: Env,
    ctx: GateContext
  ) => Promise<unknown>
) {
  return async (
    request: Request,
    env: Env,
    _params: Record<string, string>,
    ctx: GateContext
  ): Promise<Response> => {
    if (ctx.principal.service !== "github-bot" || ctx.principal.actor !== null) {
      return error("Actorless github-bot authentication required", 403);
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return error("Invalid review gate request", 400);
    const { owner, name } = parsed.data.repository;
    const resolved = await resolveRepoOrError(env, owner, name, ctx, logger);
    const repository = {
      owner,
      name,
      id: resolved.repoId,
      defaultBranch: resolved.defaultBranch,
    };
    return json(await run(createReviewGate(env, ctx.db), parsed.data, repository, env, ctx));
  };
}

const startReview = gateRoute(startGateReviewRequestSchema, (gate, request, repository, env, ctx) =>
  gate.start(request, repository, createGateSessions(env, ctx, repository))
);
const pullChanged = gateRoute(gatePullChangeRequestSchema, (gate, request, repository) =>
  gate.pullChanged(request, repository)
);
const override = gateRoute(gateOverrideRequestSchema, (gate, request, repository) =>
  gate.override(request, repository)
);

const BOT_ONLY = {
  ...GITHUB_SERVICE_ROUTE,
  authorization: requirePermission("sessions.create", {
    actorlessGrants: [{ service: "github-bot" }],
  }),
  cacheControl: "private, no-store" as const,
  // Admission runs this before enrolling an actor on permission-bearing routes.
  serviceActorClaims: async () => ({
    kind: "rejected" as const,
    response: error("Actorless github-bot authentication required", 403),
  }),
};

export const githubReviewGateRoutes = new Hono<ControlPlaneHonoEnv>();

githubReviewGateRoutes.post("/github/review-gate/reviews", admit(BOT_ONLY), (c) =>
  dispatch(c, startReview)
);
githubReviewGateRoutes.post("/github/review-gate/pull-changes", admit(BOT_ONLY), (c) =>
  dispatch(c, pullChanged)
);
githubReviewGateRoutes.post("/github/review-gate/overrides", admit(BOT_ONLY), (c) =>
  dispatch(c, override)
);
