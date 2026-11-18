/**
 * Eager environment validation shared by worker routes and the session graph.
 *
 * Misconfigured deployments fail loudly at the first touch instead of running
 * degraded (the #1602 posture). Secrets-at-rest encryption in particular must
 * never silently fall back to plaintext: Terraform requires the keys, so their
 * absence always means a broken deployment.
 */

import { readBedrockAccessKey } from "@open-inspect/shared/bedrock-api-key";
import type { BedrockSandboxConfig } from "./sandbox/bedrock-env";
import type { EnvConfig } from "./types";

/** Strict base64 — rejects whitespace and stray characters `atob` may accept. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const AES_256_KEY_BYTES = 32;
const KEY_GENERATION_HINT = "generate with: openssl rand -base64 32";

/**
 * Validates the full key contract, not just presence: `encryptToken` imports
 * the base64-decoded bytes as raw AES material, so a malformed key would
 * otherwise survive graph construction and throw at the first secret write —
 * mid-spawn — while a short key would silently downgrade to AES-128/192.
 */
function requireEncryptionKey(key: string | undefined, name: string, protects: string): string {
  if (!key) {
    throw new Error(
      `${name} is not configured; refusing to operate on ${protects} without encryption at rest`
    );
  }
  let decodedBytes: number | null = null;
  if (BASE64_PATTERN.test(key)) {
    try {
      decodedBytes = atob(key).length;
    } catch {
      decodedBytes = null;
    }
  }
  if (decodedBytes === null) {
    throw new Error(`${name} is not valid base64 (${KEY_GENERATION_HINT})`);
  }
  if (decodedBytes !== AES_256_KEY_BYTES) {
    throw new Error(
      `${name} must decode to ${AES_256_KEY_BYTES} bytes for AES-256, got ${decodedBytes} (${KEY_GENERATION_HINT})`
    );
  }
  return key;
}

export function requireRepoSecretsEncryptionKey(
  env: Pick<EnvConfig, "REPO_SECRETS_ENCRYPTION_KEY">
): string {
  return requireEncryptionKey(
    env.REPO_SECRETS_ENCRYPTION_KEY,
    "REPO_SECRETS_ENCRYPTION_KEY",
    "secrets"
  );
}

export function requireTokenEncryptionKey(env: Pick<EnvConfig, "TOKEN_ENCRYPTION_KEY">): string {
  return requireEncryptionKey(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY", "OAuth tokens");
}

/** AWS Region code such as `us-east-1`; the classifier's Bedrock model ids use the same shape. */
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;

/**
 * The IAM access key and Region that mint sandboxes' short-term Bedrock keys,
 * or null when the deployment leaves Bedrock off (all three unset). A partial
 * or malformed configuration throws rather than quietly running Claude
 * sessions on another credential.
 */
export function resolveBedrockSandboxConfig(
  env: Pick<
    EnvConfig,
    "BEDROCK_AWS_ACCESS_KEY_ID" | "BEDROCK_AWS_SECRET_ACCESS_KEY" | "BEDROCK_AWS_REGION"
  >
): BedrockSandboxConfig | null {
  const accessKey = readBedrockAccessKey(env);
  const region = env.BEDROCK_AWS_REGION?.trim() ?? "";
  if (!accessKey && !region) return null;
  if (!accessKey) {
    throw new Error(
      "BEDROCK_AWS_REGION is set without BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY"
    );
  }
  if (!AWS_REGION_PATTERN.test(region)) {
    throw new Error(`BEDROCK_AWS_REGION must be an AWS Region such as us-east-1, got "${region}"`);
  }
  return { accessKey, region };
}
