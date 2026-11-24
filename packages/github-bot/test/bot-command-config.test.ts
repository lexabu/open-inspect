import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { Env } from "../src/types";
import app from "../src/index";

const SECRET = "test-webhook-secret";

async function sign(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function makeEnv(command: string) {
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => undefined), delete: vi.fn() };
  const queue = { send: vi.fn(async () => undefined) };
  const env = {
    GITHUB_KV: kv,
    AUTOFIX_QUEUE: queue,
    CONTROL_PLANE: { fetch: vi.fn(async () => new Response(null, { status: 204 })) },
    GITHUB_WEBHOOK_SECRET: SECRET,
    SERVICE_AUTH_SECRET: "test-internal-secret",
    GITHUB_BOT_USERNAME: "test-bot[bot]",
    GITHUB_BOT_COMMAND: command,
    DEPLOYMENT_NAME: "test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    LOG_LEVEL: "error",
  } as unknown as Env;
  return { env, kv, queue };
}

function makeCtx() {
  return {
    props: {},
    waitUntil: vi.fn<HonoExecutionContext["waitUntil"]>(),
    passThroughOnException: vi.fn<HonoExecutionContext["passThroughOnException"]>(),
  } satisfies HonoExecutionContext;
}

describe("GITHUB_BOT_COMMAND validation", () => {
  it("refuses every webhook with a clear error before touching delivery state", async () => {
    const { env, kv, queue } = makeEnv("np ai");
    const body = JSON.stringify({
      action: "created",
      issue: { number: 1, title: "t", pull_request: { url: "u" } },
      comment: { id: 5, body: "looks good", user: { login: "bob" } },
      repository: { id: 1, owner: { login: "acme" }, name: "widgets", private: false },
      sender: { login: "bob", id: 2, avatar_url: "a" },
    });

    const res = await app.fetch(
      new Request("https://bot.test/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "X-Hub-Signature-256": await sign(body),
          "X-GitHub-Event": "issue_comment",
          "X-GitHub-Delivery": "delivery-1",
        },
      }),
      env,
      makeCtx()
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "GITHUB_BOT_COMMAND is invalid" });
    expect(kv.put).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});
