import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";

vi.mock("../harness-admission", () => ({
  resolveHarnessSelection: vi.fn(async (_db: unknown, selection: { model: string }) => ({
    model: selection.model,
    reasoningEffort: null,
  })),
}));
vi.mock("../session/provider-account-resolution", () => ({
  resolveSessionProviderAuth: vi.fn(async () => []),
}));
vi.mock("../session/integration-settings-resolution", () => ({
  resolveSessionScopedSettings: vi.fn(async () => ({
    codeServerEnabled: false,
    vncEnabled: false,
    sandboxSettings: {},
  })),
}));
vi.mock("../session/skill-resolution", () => ({ resolveManagedSkills: vi.fn(async () => ({})) }));
vi.mock("../memory/session-memory-selector-factory", () => ({
  createSessionMemorySelector: vi.fn(() => ({ select: memorySelect })),
}));
vi.mock("../session/initialize", () => ({ initializeSession: vi.fn(async () => ({})) }));
vi.mock("../session/runtime-client", () => ({
  createSessionRuntimeClient: vi.fn(() => ({ fetch: runtimeFetch })),
}));

const { memorySelect, runtimeFetch } = vi.hoisted(() => ({
  memorySelect: vi.fn(async () => ({})),
  runtimeFetch: vi.fn(),
}));

import { resolveSessionProviderAuth } from "../session/provider-account-resolution";
import { initializeSession } from "../session/initialize";
import { createGateSessions } from "./sessions";

const env = {} as Env;
const ctx = { db: {}, trace_id: "trace", request_id: "request" } as unknown as RequestContext;
const repository = { owner: "acme", name: "widgets", id: 99, defaultBranch: "main" };
const reviewer = {
  model: "anthropic/claude-haiku-4-5",
  harness: "opencode" as const,
  reasoningEffort: null,
  title: "GitHub: Review PR #42",
  prompt: "Review this pull request.",
};

beforeEach(() => vi.clearAllMocks());

describe("reviewer sessions of the AI Review gate", () => {
  it("are created platform-held: private, with no owner, no team and no person as participant", async () => {
    const sessionId = await createGateSessions(env, ctx, repository).create(reviewer);

    expect(initializeSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        sessionId,
        platformHeld: true,
        visibility: "private",
        ownerTeamId: null,
        platformUserId: null,
        participantCanonicalUserId: null,
        participantUserId: "github-review",
        repoOwner: "acme",
        repoName: "widgets",
        repoId: 99,
        defaultBranch: "main",
        title: "GitHub: Review PR #42",
        model: "anthropic/claude-haiku-4-5",
      }),
      ctx
    );
    const input = vi.mocked(initializeSession).mock.calls[0][1];
    // Nothing of a person's goes in: no SCM identity, no personal memory.
    expect(input.scmLogin).toBeUndefined();
    expect(input.scmUserId).toBeUndefined();
    expect(memorySelect).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { userId: null, ownerTeamId: null },
        includePersonalMemories: false,
      })
    );
    expect(resolveSessionProviderAuth).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({ unattended: true })
    );
  });

  it("prompts as the platform, ends the prompt with the verdict bound to the session's nonce, and routes completion to the gate", async () => {
    runtimeFetch.mockResolvedValue(Response.json({ messageId: "message-1", status: "queued" }));

    const messageId = await createGateSessions(env, ctx, repository).prompt(
      "session-1",
      reviewer,
      "n0nce-7f3a"
    );

    expect(messageId).toBe("message-1");
    const [sessionId, , init] = runtimeFetch.mock.calls[0];
    expect(sessionId).toBe("session-1");
    const { content, ...rest } = JSON.parse(init.body);
    expect(rest).toEqual({
      authorId: "github-review",
      canonicalUserId: null,
      source: "github",
      callbackContext: { source: "github-review" },
      clientRequestId: "github-review:session-1",
    });
    expect(
      content.startsWith("Review this pull request.\n## Verdict for the AI Review check\n")
    ).toBe(true);
    expect(content).toContain('{"attempt": "n0nce-7f3a", "verdict": "approve"');
    // Nothing follows the verdict instructions.
    expect(content.trimEnd().endsWith("review you submitted.")).toBe(true);
  });

  it("fails the start when the session refuses its prompt", async () => {
    runtimeFetch.mockResolvedValue(new Response("nope", { status: 409 }));

    await expect(
      createGateSessions(env, ctx, repository).prompt("session-1", reviewer, "n0nce-7f3a")
    ).rejects.toThrow("Reviewer prompt was refused: 409");
  });
});
