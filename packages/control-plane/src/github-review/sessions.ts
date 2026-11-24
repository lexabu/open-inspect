import { reviewVerdictInstructions } from "@open-inspect/shared/github-review-verdict";
import { checkHarnessCompatibility } from "@open-inspect/shared/harnesses";
import { sendPromptResponseSchema } from "@open-inspect/shared/types/session-api";
import { generateId } from "../auth/crypto";
import { resolveHarnessSelection } from "../harness-admission";
import { createSessionMemorySelector } from "../memory/session-memory-selector-factory";
import type { RequestContext } from "../routes/shared";
import { SessionInternalPaths } from "../session/contracts";
import type { EnqueuePromptRequest } from "../session/enqueue-prompt-contract";
import { initializeSession } from "../session/initialize";
import { resolveSessionScopedSettings } from "../session/integration-settings-resolution";
import { resolvedPin } from "../session/pinned";
import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { resolveManagedSkills } from "../session/skill-resolution";
import type { Env } from "../types";
import { GITHUB_REVIEW_CALLBACK_SOURCE } from "./callback";
import type { GateSessions } from "./gate";

/** The participant a reviewer session's prompt is attributed to: the platform, not a person. */
const REVIEWER_PARTICIPANT = "github-review";

/**
 * Reviewer sessions for the AI Review gate. Each is platform-held: private, with no owner
 * and no team, so the pull request's author, like everyone else, can neither read its
 * prompt nor send it a message. It works on the pull request's repository alone.
 */
export function createGateSessions(
  env: Env,
  ctx: RequestContext,
  repository: { owner: string; name: string; id: number; defaultBranch: string }
): GateSessions {
  const members = [
    { repoOwner: repository.owner, repoName: repository.name, repoId: repository.id },
  ];
  return {
    async create(reviewer) {
      const { harness } = reviewer;
      const { model, reasoningEffort } = await resolveHarnessSelection(ctx.db, {
        harness,
        model: reviewer.model,
        reasoningEffort: reviewer.reasoningEffort ?? undefined,
      });
      const providerAuth = await resolveSessionProviderAuth(ctx.db, {
        explicit: undefined,
        unattended: true,
        harness,
      });
      const incompatibility = checkHarnessCompatibility(
        harness,
        model,
        Object.fromEntries(providerAuth.map((auth) => [auth.provider, auth.authMode]))
      );
      if (incompatibility) throw new Error(incompatibility.message);

      const [settings, skills, memory] = await Promise.all([
        resolveSessionScopedSettings(ctx.db, members, null),
        resolveManagedSkills(
          ctx.db,
          { repositories: members, environmentId: null },
          { mode: "all" },
          null
        ),
        createSessionMemorySelector(ctx).select({
          principal: { userId: null, ownerTeamId: null },
          repositories: members,
          environmentId: null,
          includePersonalMemories: false,
        }),
      ]);
      const sessionId = generateId();
      await initializeSession(
        env,
        {
          sessionId,
          platformHeld: true,
          visibility: "private",
          ownerTeamId: null,
          platformUserId: null,
          participantUserId: REVIEWER_PARTICIPANT,
          participantCanonicalUserId: null,
          repoOwner: repository.owner,
          repoName: repository.name,
          repoId: repository.id,
          defaultBranch: repository.defaultBranch,
          title: reviewer.title,
          harness,
          model,
          reasoningEffort,
          codeServerEnabled: settings.codeServerEnabled,
          vncEnabled: settings.vncEnabled,
          sandboxSettings: settings.sandboxSettings,
          spawnSource: "github-bot",
          memory: resolvedPin(memory),
          managedSkills: resolvedPin(skills),
          providerAuth,
        },
        ctx
      );
      return sessionId;
    },

    async prompt(sessionId, reviewer, nonce) {
      const body: EnqueuePromptRequest = {
        // The verdict instructions come last and from here, not from the bot: only this
        // session's prompt, which nobody can read, carries its nonce.
        content: `${reviewer.prompt}\n## Verdict for the AI Review check\n${reviewVerdictInstructions(nonce)}\n`,
        authorId: REVIEWER_PARTICIPANT,
        canonicalUserId: null,
        source: "github",
        callbackContext: { source: GITHUB_REVIEW_CALLBACK_SOURCE },
        clientRequestId: `github-review:${sessionId}`,
      };
      const response = await createSessionRuntimeClient(env, ctx).fetch(
        sessionId,
        SessionInternalPaths.prompt,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!response.ok) throw new Error(`Reviewer prompt was refused: ${response.status}`);
      return sendPromptResponseSchema.parse(await response.json()).messageId;
    },
  };
}
