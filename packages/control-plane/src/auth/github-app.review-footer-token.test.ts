import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintReviewFooterToken } from "./github-app";

let privateKey: string;

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

afterEach(() => vi.restoreAllMocks());

describe("the review footer's token", () => {
  it("is minted for one repository with pull request write and nothing else", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      Response.json({
        token: "footer-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
      })
    );

    const token = await mintReviewFooterToken(
      { appId: "footer-app", installationId: "footer-installation", privateKey },
      "Acme",
      7
    );

    expect(token).toBe("footer-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.github.com/app/installations/footer-installation/access_tokens"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      repository_ids: [7],
      permissions: { pull_requests: "write", metadata: "read" },
    });
  });
});
