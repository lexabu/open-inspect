import { mintBedrockApiKey, type AwsAccessKey } from "@open-inspect/shared/bedrock-api-key";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { extractProviderAndModel } from "@open-inspect/shared/models";
import type {
  SessionProviderAuthMode,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";

/** The deployment's Bedrock signing key and Region (see `resolveBedrockSandboxConfig`). */
export interface BedrockSandboxConfig {
  accessKey: AwsAccessKey;
  region: string;
}

/** OpenCode's provider id for Amazon Bedrock models (`amazon-bedrock/<model>`). */
const OPENCODE_BEDROCK_PROVIDER = "amazon-bedrock";

function isOpenCodeBedrockModel(model: string): boolean {
  return extractProviderAndModel(model).provider === OPENCODE_BEDROCK_PROVIDER;
}

/**
 * Why a prompt cannot run `model` on OpenCode's Bedrock provider in this
 * session, or null when it can (or the model is not a Bedrock model). The key
 * is minted at sandbox launch from the session model, so a session that started
 * on another model has no key for a later per-message switch to Bedrock.
 */
export function bedrockModelUnavailableReason(
  config: BedrockSandboxConfig | null,
  session: { harness: HarnessId; model: string },
  model: string
): string | null {
  if (!isOpenCodeBedrockModel(model)) return null;
  if (!config) return "Amazon Bedrock is not configured for this deployment.";
  if (session.harness !== "opencode" || !isOpenCodeBedrockModel(session.model)) {
    return "Amazon Bedrock models need a Bedrock key from the start of the session. Start a new session with this model.";
  }
  return null;
}

/**
 * The variables that put a session on Bedrock, with a short-term key minted
 * now, or none when Bedrock is off or the session does not run on it:
 * - a Claude Agent API-key session (Claude Code reads CLAUDE_CODE_USE_BEDROCK);
 * - an OpenCode session whose model is on OpenCode's `amazon-bedrock` provider.
 *
 * The IAM key never leaves the control plane; only the 12-hour Bedrock-only key
 * reaches the sandbox, so every launch (create or snapshot restore) must mint a
 * fresh one.
 */
export async function bedrockSandboxEnv(
  config: BedrockSandboxConfig | null,
  session: {
    harness: HarnessId;
    model: string;
    providerAuthModes: Readonly<Record<SubscriptionProviderId, SessionProviderAuthMode>>;
  },
  now: Date = new Date()
): Promise<Record<string, string>> {
  if (!config) return {};
  const mint = () => mintBedrockApiKey(config.accessKey, config.region, now);

  if (session.harness === "claude") {
    if (session.providerAuthModes.anthropic !== "api_key") return {};
    return {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: config.region,
      AWS_BEARER_TOKEN_BEDROCK: await mint(),
    };
  }

  if (session.harness === "opencode" && isOpenCodeBedrockModel(session.model)) {
    return { AWS_REGION: config.region, AWS_BEARER_TOKEN_BEDROCK: await mint() };
  }

  return {};
}
