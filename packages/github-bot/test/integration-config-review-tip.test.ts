import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { getGitHubConfig } from "../src/utils/integration-config";
import { createLogger } from "./review-gate-fixtures";

function envAnswering(config: Record<string, unknown>): Env {
  const body = JSON.stringify({
    config: {
      model: null,
      reasoningEffort: null,
      autoReviewOnOpen: true,
      enabledRepos: null,
      allowedTriggerUsers: null,
      codeReviewInstructions: null,
      commentActionInstructions: null,
      ...config,
    },
  });
  return {
    CONTROL_PLANE: { fetch: vi.fn(async () => new Response(body, { status: 200 })) },
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    SERVICE_AUTH_SECRET: "test-secret",
  } as unknown as Env;
}

describe("getGitHubConfig reviewTip", () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])("reads reviewTip %s from the control plane as %s", async (sent, expected) => {
    const env = envAnswering(sent === undefined ? {} : { reviewTip: sent });

    const config = await getGitHubConfig(env, "acme/widgets", createLogger());

    expect(config.reviewTip).toBe(expected);
  });

  it("fails closed on a reviewTip that is not a boolean", async () => {
    const config = await getGitHubConfig(
      envAnswering({ reviewTip: "yes" }),
      "acme/widgets",
      createLogger()
    );

    expect(config).toMatchObject({ reviewTip: false, enabledRepos: [] });
  });
});
