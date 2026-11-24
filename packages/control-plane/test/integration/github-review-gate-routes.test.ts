import { beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const BASE = "https://test.local/github/review-gate";
const HEAD = "a".repeat(40);
const bodies = {
  reviews: {
    repository: { owner: "acme", name: "widgets" },
    pullNumber: 42,
    headSha: HEAD,
    reviewers: [
      {
        model: "anthropic/claude-haiku-4-5",
        harness: "opencode",
        reasoningEffort: null,
        title: "Review",
        prompt: "Review this pull request.",
      },
    ],
  },
  "pull-changes": {
    repository: { owner: "acme", name: "widgets" },
    pullNumber: 42,
    change: "head",
    headSha: HEAD,
  },
  overrides: {
    repository: { owner: "acme", name: "widgets" },
    pullNumber: 42,
    commit: "aaaaaaa",
    reason: "verified by hand",
    overriddenBy: "bob",
  },
} as const;
const endpoints = Object.keys(bodies) as (keyof typeof bodies)[];

function post(
  endpoint: keyof typeof bodies,
  init: Parameters<typeof serviceFetch>[1],
  body?: unknown
) {
  return serviceFetch(`${BASE}/${endpoint}`, {
    ...init,
    method: "POST",
    body: JSON.stringify(body ?? bodies[endpoint]),
  });
}

describe("AI Review gate routes", () => {
  beforeEach(cleanD1Tables);

  it.each(endpoints)(
    "%s is for the GitHub bot itself, never on anyone's behalf",
    async (endpoint) => {
      // A person, even an owner, cannot start, steer or override the gate through its API.
      expect((await post(endpoint, {})).status).toBe(403);
      expect((await post(endpoint, { service: "slack-bot" })).status).toBe(403);
      expect((await post(endpoint, { service: "linear-bot" })).status).toBe(403);
      expect((await post(endpoint, { service: "github-bot", actor: "github:1001" })).status).toBe(
        403
      );
    }
  );

  it.each(endpoints)(
    "%s refuses a malformed request before touching anything",
    async (endpoint) => {
      const malformed = { ...bodies[endpoint], pullNumber: "forty-two" };

      const response = await post(endpoint, { service: "github-bot" }, malformed);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid review gate request" });
    }
  );

  it("refuses an override that names no commit or gives no reason", async () => {
    for (const change of [{ commit: "abc" }, { reason: "   " }]) {
      const response = await post(
        "overrides",
        { service: "github-bot" },
        { ...bodies.overrides, ...change }
      );
      expect(response.status).toBe(400);
    }
  });
});
