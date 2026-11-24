import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRecordStore } from "../../src/db/memory-records";
import { cleanD1Tables } from "./cleanup";
import { initSession, routeRequest, seedActiveUser, seedSandboxAuthHash } from "./helpers";

const BASE = "https://test.local";
const REPO = { repoOwner: "acme", repoName: "web-app", repoId: 12345 };
const MEMORY = {
  memoryType: "fact" as const,
  title: "Deploy setup",
  description: "How deployment works",
  content: "Use the staging environment",
};

/** A session with its sandbox's token on record; `platformHeld` as the AI Review gate creates it. */
async function sessionWithSandbox(name: string, platformHeld: boolean) {
  const { sessionName, stub } = await initSession({ ...REPO, userId: `owner-of-${name}` });
  await seedSandboxAuthHash(stub, { authToken: `token-${name}`, sandboxId: `sandbox-${name}` });
  if (platformHeld) {
    await env.DB.prepare(
      "UPDATE sessions SET platform_held = 1, visibility = 'private', user_id = NULL WHERE id = ?"
    )
      .bind(sessionName)
      .run();
  }
  const call = (path: string, method = "GET", body?: unknown, token = `token-${name}`) =>
    routeRequest(
      new Request(`${BASE}/sessions/${sessionName}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      createExecutionContext()
    );
  return { id: sessionName, call };
}

describe("a platform-held session's own sandbox", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser("owner-of-ordinary");
    await seedActiveUser("owner-of-held");
  });

  it("loads its memory at boot", async () => {
    const held = await sessionWithSandbox("held", true);

    const response = await held.call("/sandbox-memory");

    expect(response.status).toBe(200);
  });

  it("searches, reads and writes its repository's memory", async () => {
    const held = await sessionWithSandbox("held", true);
    const saved = await new MemoryRecordStore(env.DB).create(
      {
        partition: { type: "repository", repoId: REPO.repoId },
        scope: { type: "repository", repoOwner: REPO.repoOwner, repoName: REPO.repoName },
        content: MEMORY,
      },
      { kind: "user", userId: "owner-of-ordinary", requestId: "setup" }
    );

    const search = await held.call("/sandbox-memory/search", "POST", { query: "staging" });
    expect(search.status).toBe(200);
    expect((await search.json<{ results: { id: string }[] }>()).results).toEqual([
      expect.objectContaining({ id: saved.id }),
    ]);
    expect((await held.call(`/sandbox-memory/${saved.id}`)).status).toBe(200);
    const written = await held.call("/sandbox-memory", "POST", {
      ...MEMORY,
      title: "Review notes",
      description: "What the reviewers look for",
      content: "Migrations are reviewed against the staging schema",
      scopeType: "repository",
    });
    expect(written.status).toBe(201);
    // No person reviews for it: what it writes waits for a person's approval.
    expect((await written.json<{ status: string }>()).status).toBe("proposed");
  });

  it("has no personal memory to reach", async () => {
    const held = await sessionWithSandbox("held", true);

    const written = await held.call("/sandbox-memory", "POST", {
      ...MEMORY,
      scopeType: "personal",
    });

    expect(written.status).toBe(403);
  });

  // Every other route a sandbox authenticates to with its own token. None of them asks who
  // owns the session, so a platform-held session gets what an ordinary one gets.
  it.each([
    ["GET", "/sandbox-skills", undefined, 200],
    ["GET", "/commit-signing", undefined, 200],
    ["POST", "/provider-auth/anthropic/access-token", {}, 409],
    ["POST", "/provider-auth/anthropic/runtime-credential", {}, 404],
    ["POST", "/openai-token-refresh", {}, 404],
    ["POST", "/xai-token-refresh", {}, 404],
    ["POST", "/scm-credentials", {}, 500],
    ["POST", "/mcp/some-server", {}, 403],
    ["POST", "/mcp-context/close", {}, 503],
    ["GET", "/children", undefined, 200],
    ["GET", "/tunnel-urls", undefined, 200],
    ["POST", "/pr", {}, 400],
    ["POST", "/slack-notify", {}, 400],
    ["POST", "/media", {}, 400],
    ["GET", "/attachments/none", undefined, 404],
  ] as const)(
    "is answered like an ordinary session's on %s %s",
    async (method, path, body, status) => {
      const ordinary = await sessionWithSandbox("ordinary", false);
      const held = await sessionWithSandbox("held", true);

      const [expected, actual] = [
        await ordinary.call(path, method, body),
        await held.call(path, method, body),
      ];

      // The status this test environment gives (no provider, GitHub App or MCP server is
      // configured), which is past authentication and the session's own access checks.
      expect(expected.status).toBe(status);
      expect(actual.status).toBe(status);
      expect(await actual.text()).toBe(await expected.text());
    }
  );

  it("still cannot spawn a child session", async () => {
    const held = await sessionWithSandbox("held", true);

    const response = await held.call("/children", "POST", {
      title: "Second opinion",
      prompt: "Review this again.",
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const children = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ?"
    )
      .bind(held.id)
      .first<{ n: number }>();
    expect(children?.n).toBe(0);
  });

  it("is closed to another session's sandbox", async () => {
    const held = await sessionWithSandbox("held", true);
    await sessionWithSandbox("ordinary", false);

    for (const [path, method] of [
      ["/sandbox-memory", "GET"],
      ["/sandbox-memory/search", "POST"],
      ["/sandbox-skills", "GET"],
      ["/scm-credentials", "POST"],
      ["/mcp/some-server", "POST"],
    ] as const) {
      const response = await held.call(
        path,
        method,
        method === "POST" ? {} : undefined,
        "token-ordinary"
      );
      expect([401, 403]).toContain(response.status);
    }
  });
});
