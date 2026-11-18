/**
 * Short-term Amazon Bedrock API keys minted from AWS IAM access keys.
 *
 * A short-term key is a SigV4 query-presigned `CallWithBearerToken` request,
 * base64-encoded, that Bedrock accepts as a bearer token
 * (`AWS_BEARER_TOKEN_BEDROCK`, or `x-api-key` on the Messages API). It grants
 * only what the signing principal may do in Bedrock and expires after
 * {@link BEDROCK_API_KEY_TTL_SECONDS}, so it can travel where the IAM keys
 * that sign it must not.
 *
 * This is the format AWS's `aws-bedrock-token-generator` package produces;
 * the unit test pins it byte-for-byte against that package's output. Session
 * tokens are not supported: the signing keys are long-term IAM user keys held
 * as deployment secrets.
 */

import { bytesToHex } from "./auth";

/** Longest lifetime Bedrock accepts for a short-term key (12 hours). */
export const BEDROCK_API_KEY_TTL_SECONDS = 43_200;

const HOST = "bedrock.amazonaws.com";
const SERVICE = "bedrock";
const ALGORITHM = "AWS4-HMAC-SHA256";
const KEY_PREFIX = "bedrock-api-key-";
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** An IAM user's long-term access key pair. */
export interface AwsAccessKey {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Deployment bindings holding the IAM access key that signs short-term keys. */
export interface BedrockAccessKeyEnv {
  BEDROCK_AWS_ACCESS_KEY_ID?: string;
  BEDROCK_AWS_SECRET_ACCESS_KEY?: string;
}

/**
 * The configured signing key, or null when neither half is set. A half-set
 * pair is a broken deployment, so it throws rather than reading as "off".
 */
export function readBedrockAccessKey(env: BedrockAccessKeyEnv): AwsAccessKey | null {
  const accessKeyId = env.BEDROCK_AWS_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = env.BEDROCK_AWS_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "BEDROCK_AWS_ACCESS_KEY_ID and BEDROCK_AWS_SECRET_ACCESS_KEY must be set together"
    );
  }
  return { accessKeyId, secretAccessKey };
}

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* bare). */
function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(digest));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

/**
 * Mint a short-term Bedrock API key valid for {@link BEDROCK_API_KEY_TTL_SECONDS}
 * from `now`. The value is a credential: never log it.
 */
export async function mintBedrockApiKey(
  key: AwsAccessKey,
  region: string,
  now: Date = new Date()
): Promise<string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  // Already in canonical (code-point) order, so this is both the canonical
  // query string and the URL's query.
  const query = [
    ["Action", "CallWithBearerToken"],
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${key.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(BEDROCK_API_KEY_TTL_SECONDS)],
    ["X-Amz-SignedHeaders", "host"],
  ]
    .map(([name, value]) => `${awsUriEncode(name)}=${awsUriEncode(value)}`)
    .join("&");

  const canonicalRequest = [
    "POST",
    "/",
    query,
    `host:${HOST}\n`,
    "host",
    EMPTY_PAYLOAD_SHA256,
  ].join("\n");
  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let signingKey = await hmac(new TextEncoder().encode(`AWS4${key.secretAccessKey}`), dateStamp);
  for (const part of [region, SERVICE, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const signature = bytesToHex(new Uint8Array(await hmac(signingKey, stringToSign)));

  return `${KEY_PREFIX}${btoa(`${HOST}/?${query}&X-Amz-Signature=${signature}&Version=1`)}`;
}
