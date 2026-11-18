import { describe, expect, it } from "vitest";
import { mintBedrockApiKey, readBedrockAccessKey } from "./bedrock-api-key";

// Generated with aws-bedrock-token-generator 1.1.0 (`_generate_token`, 12 h
// expiry) with botocore's clock frozen at each `now`.
const PYTHON_VECTORS = [
  {
    key: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    region: "us-east-1",
    now: "2026-11-17T12:34:56.789Z",
    token:
      "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSUFJT1NGT0ROTjdFWEFNUExFJTJGMjAyNjExMTclMkZ1cy1lYXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNjExMTdUMTIzNDU2WiZYLUFtei1FeHBpcmVzPTQzMjAwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZYLUFtei1TaWduYXR1cmU9NGQ5OTFjNDhhMmY5NTgxMzM3OWZhMzdiODZiYjQxZjJkMGRhNGNhZTJhZDRjMjdmMjNkNDRmNDIxYmY1MTcxMCZWZXJzaW9uPTE=",
  },
  {
    key: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s3cr3t+/=Key!With'Chars" },
    region: "eu-west-1",
    now: "2027-01-02T03:04:05.000Z",
    token:
      "bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFLSURFWEFNUExFJTJGMjAyNzAxMDIlMkZldS13ZXN0LTElMkZiZWRyb2NrJTJGYXdzNF9yZXF1ZXN0JlgtQW16LURhdGU9MjAyNzAxMDJUMDMwNDA1WiZYLUFtei1FeHBpcmVzPTQzMjAwJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZYLUFtei1TaWduYXR1cmU9YmQ5ZmRhOGY0YzhjNmEwNjEwMjIzNjYxY2ZlMWRkY2JmYjRmNmNmYmI2ZmZlZWViMDhkODgzOTY3YjQ3Mjc5NCZWZXJzaW9uPTE=",
  },
];

describe("mintBedrockApiKey", () => {
  it.each(PYTHON_VECTORS)(
    "matches AWS's token generator in $region at $now",
    async ({ key, region, now, token }) => {
      await expect(mintBedrockApiKey(key, region, new Date(now))).resolves.toBe(token);
    }
  );
});

describe("readBedrockAccessKey", () => {
  it("is off when neither half is set", () => {
    expect(readBedrockAccessKey({})).toBeNull();
    expect(
      readBedrockAccessKey({ BEDROCK_AWS_ACCESS_KEY_ID: " ", BEDROCK_AWS_SECRET_ACCESS_KEY: "" })
    ).toBeNull();
  });

  it("reads a complete pair", () => {
    expect(
      readBedrockAccessKey({
        BEDROCK_AWS_ACCESS_KEY_ID: "AKIA",
        BEDROCK_AWS_SECRET_ACCESS_KEY: "s",
      })
    ).toEqual({ accessKeyId: "AKIA", secretAccessKey: "s" });
  });

  it.each([{ BEDROCK_AWS_ACCESS_KEY_ID: "AKIA" }, { BEDROCK_AWS_SECRET_ACCESS_KEY: "s" }])(
    "throws on a half-set pair %o",
    (env) => {
      expect(() => readBedrockAccessKey(env)).toThrow(/must be set together/);
    }
  );
});
