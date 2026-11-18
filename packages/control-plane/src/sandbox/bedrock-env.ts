import { mintBedrockApiKey, type AwsAccessKey } from "@open-inspect/shared/bedrock-api-key";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import type {
  SessionProviderAuthMode,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

/** The deployment's Bedrock signing key and Region (see `resolveBedrockSandboxConfig`). */
export interface BedrockSandboxConfig {
  accessKey: AwsAccessKey;
  region: string;
}

/**
 * The variables that put a Claude Agent API-key session on Bedrock, with a
 * short-term key minted now, or none when Bedrock is off or the session runs
 * another harness or a connected Claude account. The IAM key never leaves the
 * control plane; only the 12-hour Bedrock-only key reaches the sandbox, so
 * every launch (create or snapshot restore) must mint a fresh one.
 */
export async function claudeBedrockEnv(
  config: BedrockSandboxConfig | null,
  session: {
    harness: HarnessId;
    providerAuthModes: Readonly<Record<SubscriptionProviderId, SessionProviderAuthMode>>;
  },
  now: Date = new Date()
): Promise<Record<string, string>> {
  if (!config || session.harness !== "claude") return {};
  if (session.providerAuthModes.anthropic !== "api_key") return {};
  return {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: config.region,
    AWS_BEARER_TOKEN_BEDROCK: await mintBedrockApiKey(config.accessKey, config.region, now),
  };
}
