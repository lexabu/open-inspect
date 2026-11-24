import { env } from "cloudflare:test";
import { vi } from "vitest";
import type { GitHubMergeGate } from "@open-inspect/shared/types/integrations";
import type { StartGateReviewRequest } from "@open-inspect/shared/types/github-review-gate";
import { ReviewGate, type GateSessions } from "../../src/github-review/gate";
import type { CheckRunState, GateGitHub, LivePull } from "../../src/github-review/github";
import { ReviewGateStore } from "../../src/github-review/store";
import type { Logger } from "../../src/logger";

/** A review gate over the test D1, with GitHub and the reviewer sessions faked. */
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);
export const NEW_HEAD = "c".repeat(40);
export const NEW_BASE = "d".repeat(40);
export const HAIKU = "anthropic/claude-haiku-4-5";
export const SOL = "openai/gpt-5.6-sol";
export const repository = { owner: "acme", name: "widgets", id: 99 };
export const pullKey = { repoId: 99, prNumber: 42 };
/** Stands for the nonce of whichever session the message is completed for. */
const NONCE = "<<the session's nonce>>";
export const verdictBlock = (verdict: string, summary = "Reads well.") =>
  "Review submitted.\n\n```json\n" + JSON.stringify({ attempt: NONCE, verdict, summary }) + "\n```";

export function createLogger(): Logger {
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log;
}

/** GitHub as the gate sees it: one pull request, its diffs, and the check runs written. */
export function fakeGitHub() {
  const world = {
    pull: {
      number: 42,
      open: true,
      draft: false,
      author: "alice",
      headSha: HEAD,
      headLabel: "acme:feature/cache",
      baseRef: "main",
      baseSha: BASE,
    } as LivePull | null,
    /** Hash of `base...head`; a pair not listed has the pull request's usual diff. */
    diffs: new Map<string, string | null>(),
    shared: null as string | null,
    /** Runs once, inside the gate's next read of the pull request: something else happens meanwhile. */
    duringNextRead: null as (() => Promise<unknown>) | null,
    /** Runs once, inside the gate's next diff hash: something else happens meanwhile. */
    duringNextHash: null as (() => Promise<unknown>) | null,
    /** Runs once, inside the gate's next look for other pull requests on the head. */
    duringNextShared: null as (() => Promise<unknown>) | null,
    /** Runs once, right after the next check run is created. */
    afterNextCreate: null as (() => Promise<unknown>) | null,
    /** GitHub is unwell: no check run can be created or updated. */
    createFails: false,
    updateFails: false,
    /**
     * Runs once, inside the next update of a check run; the update then lands and its
     * answer is lost, as when a request outlives its caller.
     */
    duringNextUpdateThenLost: null as (() => Promise<unknown>) | null,
    /** GitHub will not take a change to an existing run, as for a run that is gone. */
    updateRefused: false,
    /** Every check run, with the states written to it, newest state last. */
    checks: [] as { id: number; headSha: string; externalId: string; states: CheckRunState[] }[],
  };
  const github: GateGitHub = {
    getPull: async () => {
      const meanwhile = world.duringNextRead;
      world.duringNextRead = null;
      await meanwhile?.();
      return world.pull;
    },
    hashPullDiff: async (baseSha, headSha) => {
      const meanwhile = world.duringNextHash;
      world.duringNextHash = null;
      await meanwhile?.();
      const key = `${baseSha}...${headSha}`;
      return world.diffs.has(key) ? (world.diffs.get(key) ?? null) : "hash-of-the-usual-diff";
    },
    sharedHeadReason: async () => {
      const meanwhile = world.duringNextShared;
      world.duringNextShared = null;
      await meanwhile?.();
      return world.shared;
    },
    findCheck: async (headSha, externalId) =>
      world.checks
        .filter((check) => check.headSha === headSha && check.externalId === externalId)
        .at(-1)?.id ?? null,
    createCheck: async (run, state) => {
      if (world.createFails) return null;
      const id = world.checks.length + 1;
      world.checks.push({ id, headSha: run.headSha, externalId: run.externalId, states: [state] });
      const then = world.afterNextCreate;
      world.afterNextCreate = null;
      await then?.();
      return id;
    },
    updateCheck: async (id, state) => {
      if (world.updateFails) throw new Error("GitHub answered 502");
      if (world.updateRefused) return false;
      const meanwhile = world.duringNextUpdateThenLost;
      world.duringNextUpdateThenLost = null;
      await meanwhile?.();
      world.checks.find((check) => check.id === id)?.states.push(state);
      if (meanwhile) throw new Error("GitHub did not answer");
      return true;
    },
  };
  const latest = (id: number) => world.checks.find((check) => check.id === id)?.states.at(-1);
  /** What GitHub shows for a head: the newest state of the newest AI Review run on it. */
  const state = (headSha: string) =>
    world.checks
      .filter((check) => check.headSha === headSha)
      .at(-1)
      ?.states.at(-1);
  const shown = (headSha: string) => {
    const current = state(headSha);
    return current?.status === "completed" ? current.conclusion : current?.status;
  };
  return { world, github, latest, state, shown };
}

export function harness(mode: GitHubMergeGate = "required") {
  const { world, github, latest, state, shown } = fakeGitHub();
  const settings = { mode };
  const clock = { now: Date.parse("2026-11-23T10:00:00.000Z") };
  const store = new ReviewGateStore(env.DB);
  const log = createLogger();
  const gate = new ReviewGate({
    store,
    github: () => github,
    mode: async () => settings.mode,
    botUsername: "test-bot[bot]",
    now: () => (clock.now += 1),
    log,
  });
  let created = 0;
  const sessions: GateSessions & {
    prompted: string[];
    nonces: Map<string, string>;
    failOn: number | null;
  } = {
    prompted: [],
    nonces: new Map(),
    failOn: null,
    create: async () => {
      created += 1;
      if (sessions.failOn === created) throw new Error("sandbox quota exceeded");
      return `session-${created}`;
    },
    prompt: async (sessionId, _reviewer, nonce) => {
      sessions.prompted.push(sessionId);
      sessions.nonces.set(sessionId, nonce);
      return `message-for-${sessionId}`;
    },
  };
  const request = (
    models = [HAIKU],
    headSha = world.pull?.headSha ?? HEAD
  ): StartGateReviewRequest => ({
    repository: { owner: "acme", name: "widgets" },
    pullNumber: 42,
    headSha,
    base: { ref: world.pull?.baseRef ?? "main", sha: world.pull?.baseSha ?? BASE },
    reviewers: models.map((model) => ({
      model,
      harness: "opencode",
      reasoningEffort: null,
      title: "Review",
      prompt: "Review this pull request.",
    })),
  });
  const start = (models?: string[]) => gate.start(request(models), repository, sessions);
  const complete = (sessionId: string, finalMessage: string, success = true) =>
    gate.sessionCompleted({
      sessionId,
      success,
      finalMessage: finalMessage.replace(NONCE, sessions.nonces.get(sessionId) ?? "unknown"),
    });
  const change = (kind: "head" | "base" | "reopened" | "review_not_started", detail?: string) =>
    gate.pullChanged(
      {
        repository: { owner: "acme", name: "widgets" },
        pullNumber: 42,
        change: kind,
        headSha: world.pull?.headSha ?? HEAD,
        ...(detail ? { detail } : {}),
      },
      repository
    );
  const override = (commit = "aaaaaaa", overriddenBy = "bob") =>
    gate.override(
      {
        repository: { owner: "acme", name: "widgets" },
        pullNumber: 42,
        commit,
        reason: "verified by hand",
        overriddenBy,
      },
      repository
    );
  /** The database fails once, on the next record of what was published. */
  const loseNextPublicationRecord = () => {
    const record = store.recordPublished.bind(store);
    store.recordPublished = async () => {
      store.recordPublished = record;
      throw new Error("D1 unavailable");
    };
  };
  const attemptStatus = async (id: string) => (await store.getAttempt(id))?.status;
  /** What a head's check rests on, as the database has it. */
  const evidence = async (headSha = world.pull?.headSha ?? HEAD) =>
    (await store.getHead({ ...pullKey, headSha }))?.evidence;
  return {
    gate,
    store,
    world,
    latest,
    state,
    shown,
    settings,
    clock,
    sessions,
    log,
    request,
    start,
    complete,
    change,
    override,
    attemptStatus,
    evidence,
    loseNextPublicationRecord,
  };
}

/** Starts a single-reviewer review and returns the attempt id; its check run is id 1. */
export async function started(h: ReturnType<typeof harness>, models?: string[]): Promise<string> {
  const response = await h.start(models);
  if (response.outcome !== "started") throw new Error(`not started: ${response.reason}`);
  return response.attemptId;
}
