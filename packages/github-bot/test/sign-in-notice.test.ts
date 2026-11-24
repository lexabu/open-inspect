import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GitHubAuth from "../src/github-auth";

vi.mock("../src/github-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubAuth>()),
  generateInstallationToken: vi.fn(),
  postReaction: vi.fn(),
  postIssueComment: vi.fn(),
  checkSenderPermission: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock("../src/github-checks", () => ({ findSuiteReviewRun: vi.fn() }));

vi.mock("../src/utils/integration-config", () => ({ getGitHubConfig: vi.fn() }));

import { handleIssueComment, handlePullRequestOpened } from "../src/handlers";
import { postIssueComment } from "../src/github-auth";
import {
  alice,
  bob,
  createEnv,
  createLogger,
  opened,
  overrideComment,
  resetGateMocks,
  useConfig,
} from "./review-gate-fixtures";

beforeEach(resetGateMocks);

const WEB_APP_URL = "https://ai.example.test";
const NOTICE = `Sign in once at ${WEB_APP_URL} to use @test-bot here.`;

/** A control plane that refuses to create sessions for a sender with no account. */
function noAccountEnv() {
  const fixture = createEnv();
  fixture.env.WEB_APP_URL = WEB_APP_URL;
  const answer = fixture.controlPlaneFetch.getMockImplementation()!;
  fixture.controlPlaneFetch.mockImplementation(async (url, init) =>
    url === "https://internal/sessions"
      ? Response.json(
          { error: "Your account is not authorized", code: "actor_admission_denied" },
          { status: 403 }
        )
      : answer(url, init)
  );
  return fixture;
}

const noticesPosted = () =>
  vi.mocked(postIssueComment).mock.calls.filter(([, , body]) => body === NOTICE);

describe("a sender with no account", () => {
  it("gets one sign-in reply on a free-form mention instead of silence", async () => {
    useConfig({ mergeGate: "off" });
    const { env } = noAccountEnv();

    const result = await handleIssueComment(
      env,
      createLogger(),
      overrideComment("@test-bot why is this slow?"),
      "trace"
    );

    expect(result).toEqual({ outcome: "skipped", skip_reason: "actor_admission_denied" });
    expect(noticesPosted()).toEqual([
      [
        "installation-token",
        "https://api.github.com/repos/acme/widgets/issues/42/comments",
        NOTICE,
        expect.any(String),
      ],
    ]);
  });

  it("is told once per pull request, across redeliveries and later comments", async () => {
    useConfig({ mergeGate: "off" });
    const { env } = noAccountEnv();
    const log = createLogger();

    await handleIssueComment(env, log, overrideComment("@test-bot why?"), "t1");
    await handleIssueComment(env, log, overrideComment("@test-bot why?"), "t1-redelivery");
    await handleIssueComment(env, log, overrideComment("@test-bot and this?"), "t2");

    expect(noticesPosted()).toHaveLength(1);
  });

  it("is told separately for another sender on the same pull request", async () => {
    useConfig({ mergeGate: "off" });
    const { env } = noAccountEnv();
    const log = createLogger();

    await handleIssueComment(env, log, overrideComment("@test-bot why?", bob), "t1");
    await handleIssueComment(env, log, overrideComment("@test-bot why?", alice), "t2");

    expect(noticesPosted()).toHaveLength(2);
  });

  it("gets the reply when an opening review cannot start with the merge gate off", async () => {
    useConfig({ mergeGate: "off" });
    const { env } = noAccountEnv();

    const result = await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(result).toEqual({ outcome: "skipped", skip_reason: "actor_admission_denied" });
    expect(noticesPosted()).toHaveLength(1);
  });

  it("is not asked to sign in for a gate review, which needs no account", async () => {
    const { env, gateCalls } = noAccountEnv();

    await handlePullRequestOpened(env, createLogger(), opened, "trace");

    expect(gateCalls("reviews")).toHaveLength(1);
    expect(noticesPosted()).toHaveLength(0);
  });
});
