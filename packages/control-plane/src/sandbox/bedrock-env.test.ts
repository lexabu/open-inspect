import { describe, expect, it } from "vitest";
import { mintBedrockApiKey } from "@open-inspect/shared/bedrock-api-key";
import { claudeBedrockEnv, type BedrockSandboxConfig } from "./bedrock-env";

const CONFIG: BedrockSandboxConfig = {
  accessKey: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  region: "us-west-2",
};
const API_KEY_MODES = { openai: "api_key", xai: "api_key", anthropic: "api_key" } as const;
const NOW = new Date("2026-11-17T12:00:00Z");

describe("claudeBedrockEnv", () => {
  it("routes a Claude Agent API-key session to Bedrock with a key minted now", async () => {
    await expect(
      claudeBedrockEnv(CONFIG, { harness: "claude", providerAuthModes: API_KEY_MODES }, NOW)
    ).resolves.toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: await mintBedrockApiKey(CONFIG.accessKey, "us-west-2", NOW),
    });
  });

  it.each([
    { label: "Bedrock is off", config: null, harness: "claude" as const, modes: API_KEY_MODES },
    { label: "OpenCode", config: CONFIG, harness: "opencode" as const, modes: API_KEY_MODES },
    { label: "Codex", config: CONFIG, harness: "codex" as const, modes: API_KEY_MODES },
    {
      label: "a connected Claude account",
      config: CONFIG,
      harness: "claude" as const,
      modes: { ...API_KEY_MODES, anthropic: "provider_account" as const },
    },
  ])("adds nothing when $label", async ({ config, harness, modes }) => {
    await expect(
      claudeBedrockEnv(config, { harness, providerAuthModes: modes }, NOW)
    ).resolves.toEqual({});
  });
});
