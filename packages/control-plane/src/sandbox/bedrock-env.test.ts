import { describe, expect, it } from "vitest";
import { mintBedrockApiKey } from "@open-inspect/shared/bedrock-api-key";
import { bedrockSandboxEnv, type BedrockSandboxConfig } from "./bedrock-env";

const CONFIG: BedrockSandboxConfig = {
  accessKey: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
  region: "us-west-2",
};
const API_KEY_MODES = { openai: "api_key", xai: "api_key", anthropic: "api_key" } as const;
const NOW = new Date("2026-11-17T12:00:00Z");
const CLAUDE_MODEL = "anthropic/claude-opus-4-5";
const BEDROCK_GPT = "amazon-bedrock/openai.gpt-6.2-sol";

describe("bedrockSandboxEnv", () => {
  it("routes a Claude Agent API-key session to Bedrock with a key minted now", async () => {
    await expect(
      bedrockSandboxEnv(
        CONFIG,
        { harness: "claude", model: CLAUDE_MODEL, providerAuthModes: API_KEY_MODES },
        NOW
      )
    ).resolves.toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: await mintBedrockApiKey(CONFIG.accessKey, "us-west-2", NOW),
    });
  });

  it("gives an OpenCode session on a Bedrock model the Region and a key minted now", async () => {
    await expect(
      bedrockSandboxEnv(
        CONFIG,
        { harness: "opencode", model: BEDROCK_GPT, providerAuthModes: API_KEY_MODES },
        NOW
      )
    ).resolves.toEqual({
      AWS_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: await mintBedrockApiKey(CONFIG.accessKey, "us-west-2", NOW),
    });
  });

  it.each([
    {
      label: "Bedrock is off",
      config: null,
      harness: "claude" as const,
      model: CLAUDE_MODEL,
      modes: API_KEY_MODES,
    },
    {
      label: "Bedrock is off for an OpenCode Bedrock model",
      config: null,
      harness: "opencode" as const,
      model: BEDROCK_GPT,
      modes: API_KEY_MODES,
    },
    {
      label: "OpenCode runs a non-Bedrock model",
      config: CONFIG,
      harness: "opencode" as const,
      model: CLAUDE_MODEL,
      modes: API_KEY_MODES,
    },
    {
      label: "Codex",
      config: CONFIG,
      harness: "codex" as const,
      model: "openai/gpt-6-sol",
      modes: API_KEY_MODES,
    },
    {
      label: "a connected Claude account",
      config: CONFIG,
      harness: "claude" as const,
      model: CLAUDE_MODEL,
      modes: { ...API_KEY_MODES, anthropic: "provider_account" as const },
    },
  ])("adds nothing when $label", async ({ config, harness, model, modes }) => {
    await expect(
      bedrockSandboxEnv(config, { harness, model, providerAuthModes: modes }, NOW)
    ).resolves.toEqual({});
  });
});
