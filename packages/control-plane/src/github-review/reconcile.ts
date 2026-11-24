/**
 * What a head's AI Review check should say, computed from the facts in the database, and
 * the one place that writes it to GitHub.
 *
 * Events never write a check. They record a fact and call `reconcile`, which reads the
 * facts as they are now, computes the single state they imply, and writes it to the
 * head's one check run. Whatever order events and writes happen in, the head ends up
 * showing what the facts say.
 */
import { botHandle } from "@open-inspect/shared/github-mention";
import { getModelDisplayName } from "@open-inspect/shared/models";
import { reviewCheckExternalId } from "@open-inspect/shared/types/github-review-gate";
import type { GitHubMergeGate } from "@open-inspect/shared/types/integrations";
import type { Logger } from "../logger";
import type { CheckRunState, GateGitHub, LivePull } from "./github";
import type { HeadKey, ReviewAttempt, ReviewGateStore, ReviewHead } from "./store";

/** How long one reconciler may hold a head; a lease left by a worker that died expires. */
const LEASE_MS = 60_000;
/** Facts can change while a state is being written; the write is redone this many times. */
const MAX_PASSES = 3;

export interface GateRepository {
  owner: string;
  name: string;
  id: number;
}

export interface ReconcilerDeps {
  store: ReviewGateStore;
  github(repository: GateRepository): GateGitHub;
  /** The repository's `mergeGate` setting; `off` also where the bot is not enabled. */
  mode(repository: GateRepository): Promise<GitHubMergeGate>;
  botUsername: string;
  now(): number;
  log: Logger;
}

type ActiveMode = Exclude<GitHubMergeGate, "off">;
const short = (sha: string) => sha.slice(0, 7);

function modeNote(mode: ActiveMode): string {
  return mode === "shadow"
    ? "\n\nShadow mode: this check reports the verdict and never blocks merging."
    : "";
}

/** The check for a head no review covers: it asks for one instead of failing. */
function needsReview(mode: ActiveMode, headSha: string, why: string): CheckRunState {
  return {
    status: "completed",
    conclusion: mode === "required" ? "action_required" : "neutral",
    output: {
      title: "Re-run the AI review before merging",
      summary: `${why} Click **Review now**, or re-run this check, when commit \`${short(headSha)}\` is ready to merge.${modeNote(mode)}`,
    },
    reviewAction: true,
  };
}

function notApproved(mode: ActiveMode) {
  return mode === "required" ? ("failure" as const) : ("neutral" as const);
}

const VERDICT_LABELS = {
  approve: "approve",
  request_changes: "changes requested",
  failed: "no verdict",
} as const;

/** What a concluded attempt's reviewers said. */
interface AttemptResult {
  /** Every reviewer gave a verdict; false when a session failed or none ever ran. */
  finished: boolean;
  approved: boolean;
  summary: string;
}

export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  /**
   * Brings a head's check run in line with the facts. Safe to call at any time and from
   * anywhere: one caller at a time writes a head, the same state is not written twice,
   * and a write that fails leaves the head dirty for the recovery pass.
   */
  async reconcile(key: HeadKey): Promise<void> {
    const { store } = this.deps;
    const now = this.deps.now();
    // Whoever holds the lease sees this caller's fact too: it re-reads before it is done.
    if (!(await store.acquireLease(key, now, now + LEASE_MS))) return;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const head = await store.getHead(key);
        if (head === null) return;
        const published = await this.publish(head);
        // A fact written meanwhile is not in what was just published. The version it
        // bumped was not recorded as published, so the head is still dirty.
        if (published && (await store.getHead(key))?.version === head.version) return;
      }
    } finally {
      await store.releaseLease(key);
    }
  }

  /** Computes a head's state and writes it; false when the facts moved on meanwhile. */
  private async publish(head: ReviewHead): Promise<boolean> {
    const { store } = this.deps;
    const repository = { owner: head.repoOwner, name: head.repoName, id: head.repoId };
    const github = this.deps.github(repository);
    const state = await this.desiredState(head, repository, github);
    // A closed pull request shows nothing new; its head is simply no longer dirty.
    if (state === null) {
      await store.recordPublished(head, {
        version: head.version,
        state: head.publishedState,
        checkRunId: head.checkRunId,
      });
      return true;
    }
    // Computing took GitHub calls; a state the facts no longer imply is not written.
    if ((await store.getHead(head))?.version !== head.version) return false;

    const serialized = JSON.stringify(state);
    let checkRunId = head.checkRunId;
    if (checkRunId === null || serialized !== head.publishedState) {
      checkRunId = await this.write(github, head, state);
    }
    await store.recordPublished(head, { version: head.version, state: serialized, checkRunId });
    return true;
  }

  /**
   * Writes a state to the head's one check run, creating it the first time. A run that
   * cannot be updated (GitHub refuses the change, or the run is gone) is replaced by a
   * new one, which becomes the head's run.
   */
  private async write(github: GateGitHub, head: ReviewHead, state: CheckRunState): Promise<number> {
    if (head.checkRunId !== null && (await github.updateCheck(head.checkRunId, state))) {
      return head.checkRunId;
    }
    const created = await github.createCheck(
      {
        headSha: head.headSha,
        externalId: reviewCheckExternalId(head.prNumber),
        startedAt: new Date(this.deps.now()).toISOString(),
      },
      state
    );
    if (created === null) {
      throw new Error(`AI Review check could not be written for ${head.headSha}`);
    }
    if (head.checkRunId !== null) {
      this.deps.log.warn("github_review.check_run_replaced", {
        pull_number: head.prNumber,
        head_sha: head.headSha,
        replaced: head.checkRunId,
      });
    }
    return created;
  }

  /** The one state the facts imply for a head; null for a pull request that is closed. */
  private async desiredState(
    head: ReviewHead,
    repository: GateRepository,
    github: GateGitHub
  ): Promise<CheckRunState | null> {
    const { store } = this.deps;
    const setting = await this.deps.mode(repository);
    // A gate turned off still brings its checks to rest, without blocking anything.
    const mode: ActiveMode = setting === "off" ? "shadow" : setting;
    const pull = await github.getPull(head.prNumber);
    if (pull === null) throw new Error(`Pull request #${head.prNumber} unreadable`);
    if (!pull.open) return null;
    const ask = (why: string) => needsReview(mode, head.headSha, why);

    const { evidence } = head;
    switch (evidence.kind) {
      case "none":
        return ask(evidence.note ?? "No AI review covers this commit.");
      case "override": {
        const summary = `@${evidence.by} overrode the AI Review check on commit \`${short(head.headSha)}\`.\n\nReason: ${evidence.reason}`;
        const blocked = await this.passBlocked(github, pull, head, null);
        if (blocked !== null) return ask(`${summary}\n\n${blocked}`);
        return {
          status: "completed",
          conclusion: "success",
          output: { title: `Overridden by @${evidence.by}`, summary },
          reviewAction: false,
        };
      }
      case "review": {
        const attempt = await store.getAttempt(evidence.attemptId);
        if (attempt === null || attempt.status === "superseded") {
          return ask("No AI review covers this commit.");
        }
        if (attempt.status === "running") {
          return {
            status: "in_progress",
            output: {
              title: "AI review in progress",
              summary: `Reviewing commit \`${short(head.headSha)}\`.${modeNote(mode)}`,
            },
          };
        }
        const result = await this.attemptResult(attempt);
        if (!result.finished) {
          return {
            status: "completed",
            conclusion: notApproved(mode),
            output: {
              title: "The AI review did not finish",
              summary: `${result.summary}\n\nRe-run this check to review commit \`${short(head.headSha)}\` again.${modeNote(mode)}`,
            },
            reviewAction: true,
          };
        }
        if (!result.approved) {
          return {
            status: "completed",
            conclusion: notApproved(mode),
            output: {
              title: "Changes requested",
              summary: `${result.summary}\n\nAddress the findings and re-run this check, or ask someone with write access who is not the author to comment \`@${botHandle(this.deps.botUsername)} override ${short(head.headSha)} <reason>\`.${modeNote(mode)}`,
            },
            reviewAction: true,
          };
        }
        const blocked = await this.passBlocked(github, pull, head, attempt);
        if (blocked !== null) return ask(`${result.summary}\n\n${blocked}`);
        return {
          status: "completed",
          conclusion: "success",
          output: { title: "Approved", summary: `${result.summary}${modeNote(mode)}` },
          reviewAction: false,
        };
      }
      case "carried": {
        const attempt = await store.getAttempt(evidence.attemptId);
        if (attempt === null || attempt.status !== "concluded") {
          return ask("No AI review covers this diff.");
        }
        const result = await this.attemptResult(attempt);
        const summary = `Carried forward from commit \`${short(attempt.headSha)}\`: the pull request's own diff is unchanged.\n\n${result.summary}`;
        if (!result.approved) {
          return {
            status: "completed",
            conclusion: notApproved(mode),
            output: {
              title: "Not approved (carried forward)",
              summary: `${summary}${modeNote(mode)}`,
            },
            reviewAction: true,
          };
        }
        const blocked = await this.passBlocked(github, pull, head, attempt);
        if (blocked !== null) return ask(`${summary}\n\n${blocked}`);
        return {
          status: "completed",
          conclusion: "success",
          output: { title: "Approved (carried forward)", summary: `${summary}${modeNote(mode)}` },
          reviewAction: false,
        };
      }
    }
  }

  private async attemptResult(attempt: ReviewAttempt): Promise<AttemptResult> {
    const sessions = await this.deps.store.listSessions(attempt.id);
    return {
      finished:
        sessions.length > 0 &&
        sessions.every((session) => session.verdict !== null && session.verdict !== "failed"),
      approved: sessions.length > 0 && sessions.every((session) => session.verdict === "approve"),
      summary:
        sessions.length === 0
          ? "No reviewer session was started."
          : sessions
              .map(
                (session) =>
                  `- ${getModelDisplayName(session.model)}: ${VERDICT_LABELS[session.verdict ?? "failed"]}. ${session.summary ?? ""}`
              )
              .join("\n"),
    };
  }

  /**
   * Why a head must not pass although what it rests on approves, or null when it may.
   * The commit must be the pull request's head and the only open pull request on it, and
   * a review must still be of the pull request as it is: same base branch, and the same
   * diff if the base has moved on or the review was of another head.
   */
  private async passBlocked(
    github: GateGitHub,
    pull: LivePull,
    head: ReviewHead,
    attempt: ReviewAttempt | null
  ): Promise<string | null> {
    if (pull.headSha !== head.headSha) {
      return `Commit \`${short(head.headSha)}\` is no longer the head of #${head.prNumber}.`;
    }
    if (attempt !== null) {
      if (pull.baseRef !== attempt.baseRef) {
        return `The base branch changed from \`${attempt.baseRef}\` to \`${pull.baseRef}\` since the review.`;
      }
      if (pull.baseSha !== attempt.baseSha || head.headSha !== attempt.headSha) {
        const hash = await github.hashPullDiff(pull.baseSha, pull.headSha);
        if (hash === null || hash !== attempt.diffHash) {
          return `The pull request's diff against \`${pull.baseRef}\` could not be shown to be the one that was reviewed.`;
        }
      }
    }
    return github.sharedHeadReason(pull);
  }
}
