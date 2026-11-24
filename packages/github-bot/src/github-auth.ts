import { DEFAULT_APP_NAME } from "@open-inspect/shared/app-name";
import { z } from "zod";

export const GITHUB_API_REQUEST_TIMEOUT_MS = 10_000;

const collaboratorPermissionResponseSchema = z.object({
  permission: z.string(),
});

const installationTokenResponseSchema = z.object({
  token: z.string(),
});

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string;
  /** User-Agent header sent on outbound GitHub API requests. */
  userAgent?: string;
}

function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parsePemPrivateKey(pem: string): Uint8Array {
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemPrivateKey(pem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Unable to import private key. Ensure it is in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }
}

export async function generateAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function getInstallationToken(
  jwt: string,
  installationId: string,
  userAgent: string
): Promise<string> {
  const url = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    },
    signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${error}`);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error("Failed to get installation token: invalid response");
  }

  const parsed = installationTokenResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Failed to get installation token: invalid response");
  }
  return parsed.data.token;
}

export async function generateInstallationToken(config: GitHubAppConfig): Promise<string> {
  const jwt = await generateAppJwt(config.appId, config.privateKey);
  return getInstallationToken(jwt, config.installationId, config.userAgent || DEFAULT_APP_NAME);
}

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export interface PermissionCheckResult {
  hasPermission: boolean;
  error?: boolean;
}

export async function checkSenderPermission(
  token: string,
  owner: string,
  repo: string,
  username: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<PermissionCheckResult> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}/permission`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) return { hasPermission: false, error: true };
    const parsed = collaboratorPermissionResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { hasPermission: false, error: true };
    const data = parsed.data;
    return { hasPermission: WRITE_PERMISSIONS.has(data.permission) };
  } catch {
    return { hasPermission: false, error: true };
  }
}

export async function postReaction(
  token: string,
  url: string,
  content: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function postIssueComment(
  token: string,
  url: string,
  body: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const pullRequestReviewsResponseSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable(),
    commit_id: z.string().nullable(),
    state: z.string(),
    body: z.string().nullable(),
    html_url: z.string(),
    // Absent on a pending review, which is not submitted yet.
    submitted_at: z.string().nullish(),
  })
);

export interface PullRequestReview {
  login: string;
  commitId: string;
  state: string;
  body: string;
  url: string;
  submittedAt: string;
}

const REVIEWS_PAGE_SIZE = 100;
const MAX_REVIEW_PAGES = 10;

/** Every submitted review on a pull request, oldest first, or null when GitHub cannot be read. */
export async function listPullRequestReviews(
  token: string,
  reviewsUrl: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<PullRequestReview[] | null> {
  const reviews: PullRequestReview[] = [];
  try {
    for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
      const response = await fetch(`${reviewsUrl}?per_page=${REVIEWS_PAGE_SIZE}&page=${page}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": userAgent,
        },
        signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const parsed = pullRequestReviewsResponseSchema.safeParse(await response.json());
      if (!parsed.success) return null;
      for (const review of parsed.data) {
        if (review.user && review.commit_id && review.submitted_at) {
          reviews.push({
            login: review.user.login,
            commitId: review.commit_id,
            state: review.state,
            body: review.body ?? "",
            url: review.html_url,
            submittedAt: review.submitted_at,
          });
        }
      }
      if (parsed.data.length < REVIEWS_PAGE_SIZE) return reviews;
    }
    return null;
  } catch {
    return null;
  }
}

const pullRequestResponseSchema = z.object({
  number: z.number(),
  state: z.string(),
  draft: z.boolean(),
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string(), sha: z.string() }),
});

export type LivePullRequest = z.infer<typeof pullRequestResponseSchema>;

/** A pull request as GitHub has it now, or null when unreadable. */
export async function getPullRequest(
  token: string,
  pullUrl: string,
  userAgent: string = DEFAULT_APP_NAME
): Promise<LivePullRequest | null> {
  try {
    const response = await fetch(pullUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent,
      },
      signal: AbortSignal.timeout(GITHUB_API_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = pullRequestResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
