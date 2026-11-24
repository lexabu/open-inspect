import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppConfig } from "./github-app";
import type * as GitHubAppAuth from "./github-app";

let privateKey: string;
let auth: typeof GitHubAppAuth;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected a PKCS#8 byte buffer");
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`;
});

beforeEach(async () => {
  // A fresh module per test: installation tokens are cached in module memory.
  vi.resetModules();
  auth = await import("./github-app");
});

afterEach(() => vi.restoreAllMocks());

function config(): GitHubAppConfig {
  return { appId: "gate-test-app", installationId: "gate-test-installation", privateKey };
}

const INSTALLATION = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  actions: "read",
  checks: "write",
  statuses: "write",
};

/** GitHub's token endpoint: grants what the request names, else everything installed. */
function mockGitHub() {
  let minted = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/installation/token")) return new Response(null, { status: 204 });
    const body: { permissions?: Record<string, string> } = init?.body
      ? JSON.parse(String(init.body))
      : {};
    minted += 1;
    return Response.json({
      token: `token-${minted}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: body.permissions ?? INSTALLATION,
    });
  });
}

describe("sandbox and session installation tokens", () => {
  it("never carry write access to checks or commit statuses", async () => {
    const fetchMock = mockGitHub();

    const token = await auth.getCachedInstallationToken(config(), undefined, {
      scope: { kind: "repositories", repositoryIds: [7] },
    });

    const mints = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"));
    expect(mints).toHaveLength(2);
    const requested = JSON.parse(String(mints[1][1]?.body));
    expect(requested).toEqual({
      repository_ids: [7],
      permissions: { ...INSTALLATION, checks: "read", statuses: "read" },
    });
    expect(Object.values(requested.permissions)).toContain("write");
    expect(requested.permissions.checks).not.toBe("write");
    expect(requested.permissions.statuses).not.toBe("write");
    // The caller gets the capped token; the uncapped one is revoked unused.
    expect(token).toBe("token-2");
    const revoke = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/installation/token")
    );
    expect(revoke?.[1]).toMatchObject({ method: "DELETE" });
    expect(new Headers(revoke?.[1]?.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("caps an installation-wide token the same way", async () => {
    const fetchMock = mockGitHub();

    await auth.getCachedInstallationToken(config(), undefined, { scope: { kind: "all" } });

    const mints = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"));
    expect(JSON.parse(String(mints[1][1]?.body))).toEqual({
      permissions: { ...INSTALLATION, checks: "read", statuses: "read" },
    });
  });

  it("refuses a token GitHub did not cap", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        token: "uncapped",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: INSTALLATION,
      })
    );

    await expect(
      auth.getCachedInstallationToken(config(), undefined, { scope: { kind: "all" } })
    ).rejects.toThrow("gate permissions were not capped");
  });

  it("refuses a token whose permissions GitHub does not state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        token: "unknown",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    );

    await expect(
      auth.getCachedInstallationToken(config(), undefined, { scope: { kind: "all" } })
    ).rejects.toThrow("invalid response");
  });

  it("takes one request when the installation cannot write checks or statuses", () => {
    expect(auth.capGatePermissions({ contents: "write", checks: "read" })).toBeNull();
    expect(auth.capGatePermissions({ contents: "write" })).toBeNull();
    expect(auth.capGatePermissions({ contents: "write", statuses: "write" })).toEqual({
      contents: "write",
      statuses: "read",
    });
  });
});
