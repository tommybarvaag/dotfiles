/**
 * The forge-neutral model of a babysat pull request, and the pure decision that turns one
 * observation plus the remembered watch state into a snapshot with a prioritized action list.
 *
 * Forge adapters (github.ts, azure-devops.ts) build an {@link Observation}; nothing in this module
 * knows about `gh`, `az`, or their JSON.
 */
import { Schema } from "effect";
import type { Forge } from "./pr-target.ts";
import * as WatchState from "./watch-state.ts";

/** Lifecycle state of the pull request. `merged` and `closed` are terminal. */
export type PrState = "open" | "merged" | "closed";

/** Identity and lifecycle of the pull request. */
export type PullRequestInfo = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: PrState;
  readonly isDraft: boolean;
  /** Head commit of the source branch. */
  readonly headSha: string;
  readonly headBranch: string;
  readonly baseBranch: string;
};

/** Whether the forge would let the pull request merge, ignoring reviews and CI handled elsewhere. */
export type Mergeability = {
  readonly status: "clean" | "conflicting" | "behind" | "blocked" | "unknown";
  /** Forge wording or blocking policy names, for the user. */
  readonly detail: string | null;
};

/** Aggregate review verdict. `none` means no review is required and none blocks. */
export type ReviewDecision = "approved" | "changes_requested" | "review_required" | "none";

/** Normalized state of one CI check. */
export type CheckStatus = "passed" | "failed" | "pending" | "skipped";

/** What the forge adapter needs to rerun a failed check. */
export type RetryTarget =
  | { readonly _tag: "github_run"; readonly runId: number }
  | { readonly _tag: "azdo_policy"; readonly evaluationId: string };

/** A way to rerun a failed check. Several checks can share one handle (one workflow run). */
export type RetryHandle = {
  /** Deduplication key; checks with the same key are rerun together. */
  readonly key: string;
  /** Whether the forge accepts a rerun now (only once the run or build is terminal). */
  readonly ready: boolean;
  readonly target: RetryTarget;
};

/** Where to read a failed job's log, with a ready-to-run read-only command. */
export type LogLocator =
  | {
      readonly kind: "github_job";
      readonly runId: number;
      readonly jobId: number;
      /** REST path for the full job log. */
      readonly endpoint: string;
      readonly command: ReadonlyArray<string>;
    }
  | {
      readonly kind: "azdo_build_log";
      readonly buildId: number;
      readonly logId: number;
      readonly command: ReadonlyArray<string>;
    };

/** A failed unit of CI work (GitHub job, Azure Pipelines task) worth reading logs for. */
export type FailedJob = {
  readonly name: string;
  /** The check this job belongs to. */
  readonly check: string;
  readonly url: string | null;
  /** Error annotations the forge already extracted, if any. */
  readonly errors: ReadonlyArray<string>;
  readonly log: LogLocator | null;
};

/** One CI check on the head commit. */
export type Check = {
  readonly name: string;
  /** Workflow or pipeline name. */
  readonly group: string | null;
  /** Aggregate state; a still-running build with a failed task is `pending`. */
  readonly status: CheckStatus;
  /** The forge's own conclusion, for humans. */
  readonly conclusion: string;
  readonly required: boolean;
  readonly url: string | null;
  /** `null` when the watcher cannot rerun this check. */
  readonly retry: RetryHandle | null;
  /**
   * Failed jobs already visible, independent of `status`: a build can expose a failed task
   * while other jobs still run, and that is diagnosable at once.
   */
  readonly failedJobs: ReadonlyArray<FailedJob>;
};

/**
 * How much a review author is trusted. Adapters classify; the decision applies policy.
 * - `collaborator`: a human with write or membership rights on the repository.
 * - `bot`: an app, service principal, or other automation; trusted only when allow-listed.
 * - `outsider`: anyone else; surfaced only when it is the confirmed requester.
 */
export type AuthorRole = "collaborator" | "bot" | "outsider";

/** The author of a review item. */
export type ReviewAuthor = {
  /** Display name for humans to read. */
  readonly login: string;
  /**
   * Canonical lowercase identity matched against `--requester` and `--review-bot`: the GitHub
   * login (without `[bot]`); on Azure DevOps the sign-in name of a person, the identity ID of a bot.
   */
  readonly key: string;
  readonly role: AuthorRole;
};

/** The resolvable thread a review item belongs to. */
export type ReviewThread = {
  /** Forge thread ID (GitHub node ID, Azure DevOps thread ID). */
  readonly id: string;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly path: string | null;
  readonly line: number | null;
  /** Everyone who commented in the thread, deduplicated by login. */
  readonly participants: ReadonlyArray<ReviewAuthor>;
};

/** One piece of published review feedback. */
export type ReviewItem = {
  /** Stable, forge-prefixed ID used for deduplication. */
  readonly id: string;
  readonly kind: "inline_comment" | "review" | "conversation_comment";
  readonly author: ReviewAuthor;
  readonly body: string;
  readonly url: string | null;
  readonly createdAt: string;
  /** Review submissions only. */
  readonly verdict: "approved" | "changes_requested" | "commented" | null;
  readonly thread: ReviewThread | null;
};

/**
 * Whether the adapter saw everything. An incomplete observation (pagination cap, head moved
 * mid-read, a failed auxiliary read) can hide a failing check or another participant, so it never
 * yields a milestone or a thread write.
 */
export type Completeness =
  | { readonly _tag: "complete" }
  | { readonly _tag: "incomplete"; readonly reasons: ReadonlyArray<string> };

/** Everything an adapter observed about the pull request in one poll. */
export type Observation = {
  readonly forge: Forge;
  readonly pr: PullRequestInfo;
  readonly mergeability: Mergeability;
  readonly reviewDecision: ReviewDecision;
  readonly checks: ReadonlyArray<Check>;
  /** Published review items. Unpublished (pending) feedback is excluded by the adapter. */
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  /**
   * The login the forge CLI is authenticated as, when cheaply known. Advisory only: it marks the
   * agent's own `[babysit]` replies, never trust or write eligibility.
   */
  readonly viewer: string | null;
  readonly completeness: Completeness;
};

/** A thread as read on its own, for the fresh check before replying or resolving. */
export type ThreadObservation = { readonly thread: ReviewThread; readonly completeness: Completeness };

/** Whether the agent may reply in or resolve a thread without asking the user. */
export type ThreadWriteEligibility =
  | { readonly _tag: "eligible" }
  | { readonly _tag: "ineligible"; readonly reason: string };

/**
 * What the agent should do next, in priority order within a snapshot.
 * `stop_*` actions are terminal and exclusive: a snapshot with one has no other action.
 */
export const Action = Schema.Literals([
  "stop_pr_closed",
  "stop_merge_conflict",
  "process_review_comment",
  "diagnose_ci_failure",
  "retry_failed_checks",
  "celebrate_ci_green",
  "ready_to_merge",
  "idle",
]);

/** One next step for the agent; see {@link Action}. */
export type Action = typeof Action.Type;

/** Tunable policy for the decision. */
export type WatchPolicy = {
  /** Bot logins whose review feedback is surfaced (lowercase, without `[bot]`). */
  readonly reviewBots: ReadonlyArray<string>;
  /** Flaky-retry cycles allowed per head SHA. */
  readonly retryBudget: number;
  /**
   * The person who asked for babysitting, confirmed by them (canonical lowercase key), or `null`.
   * Only their own threads are auto-writable; without it no human thread is.
   */
  readonly requester: string | null;
  /** Prefix the agent puts on every comment it posts; such replies by the requester or viewer are skipped. */
  readonly replyMarker: string;
};

/** Aggregate CI state of the head commit. */
export type CiSummary = {
  readonly status: "passed" | "failed" | "pending" | "none";
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly skipped: number;
  readonly failedChecks: ReadonlyArray<{
    readonly name: string;
    readonly group: string | null;
    readonly conclusion: string;
    readonly required: boolean;
    readonly url: string | null;
    readonly retryable: boolean;
  }>;
  /** Failed jobs from every check, including checks still running. */
  readonly failedJobs: ReadonlyArray<FailedJob>;
  readonly retries: { readonly used: number; readonly budget: number; readonly exhausted: boolean };
};

/** A surfaced review item, with whether its thread may be written to automatically. */
export type SurfacedReviewItem = ReviewItem & { readonly threadWrite: ThreadWriteEligibility };

/** The JSON document the watcher prints: one per `--once`, one per line in `--watch`. */
export type Snapshot = {
  readonly forge: Forge;
  readonly pr: PullRequestInfo;
  readonly mergeability: Mergeability;
  readonly reviewDecision: ReviewDecision;
  readonly ci: CiSummary;
  readonly review: {
    /** Trusted, unresolved feedback not surfaced in an earlier snapshot. */
    readonly newItems: ReadonlyArray<SurfacedReviewItem>;
    /** Trusted review threads still unresolved, including already-surfaced ones. */
    readonly unresolvedThreads: number;
    /** Unresolved feedback hidden because its author is not trusted. */
    readonly ignoredUntrusted: number;
  };
  readonly completeness: Completeness;
  readonly actions: ReadonlyArray<Action>;
  readonly observedAt: string;
};

/** The result of one decision: what to print, what to remember, and what a retry would rerun. */
export type Decision = {
  readonly snapshot: Snapshot;
  readonly state: WatchState.WatchState;
  /** Targets `--retry-failed-now` reruns; empty unless `retry_failed_checks` is an action. */
  readonly retryTargets: ReadonlyArray<RetryTarget>;
};

/**
 * Decide the next actions for one observation.
 *
 * A strict stop (closed PR, merge conflict) is decided first and exclusively: no other action,
 * no retry plan, and the state is returned unchanged so nothing is marked seen or celebrated.
 *
 * @param observation - What the adapter saw this poll.
 * @param state - What the watcher remembered from earlier polls.
 * @param policy - Trust and retry policy.
 * @param observedAt - ISO timestamp of the poll.
 * @returns The snapshot to print, the state to persist, and the retry plan.
 */
export function decide(
  observation: Observation,
  state: WatchState.WatchState,
  policy: WatchPolicy,
  observedAt: string,
): Decision {
  const { pr } = observation;
  const surfaceable = observation.reviewItems.filter((item) => isSurfaceable(item, observation.viewer, policy));
  const newItems = surfaceable
    .filter((item) => !WatchState.hasSeen(state, item.id))
    .map((item) => ({ ...item, threadWrite: itemThreadWrite(item, observation, policy) }));
  const unresolvedThreads = new Set(
    surfaceable.flatMap((item) => (item.thread !== null && !item.thread.resolved ? [item.thread.id] : [])),
  ).size;
  const ignoredUntrusted = observation.reviewItems.filter(
    (item) => !isTrusted(item.author, policy) && (item.thread === null || !item.thread.resolved),
  ).length;

  const retriesUsed = WatchState.retriesUsed(state, pr.headSha);
  const ci = summarizeCi(observation.checks, retriesUsed, policy.retryBudget);
  const snapshotOf = (actions: ReadonlyArray<Action>): Snapshot => ({
    forge: observation.forge,
    pr,
    mergeability: observation.mergeability,
    reviewDecision: observation.reviewDecision,
    ci,
    review: { newItems, unresolvedThreads, ignoredUntrusted },
    completeness: observation.completeness,
    actions,
    observedAt,
  });

  const stop = strictStop(observation);
  if (stop !== null) return { snapshot: snapshotOf([stop]), state, retryTargets: [] };

  const complete = observation.completeness._tag === "complete";
  const retryTargets = readyRetryTargets(observation.checks);
  const canRetry = retryTargets.length > 0 && retriesUsed < policy.retryBudget;
  const actions: Action[] = [];
  let next = WatchState.markSeen(state, newItems.map((item) => item.id));

  if (newItems.length > 0) actions.push("process_review_comment");
  if (ci.failed > 0 || ci.failedJobs.length > 0) actions.push("diagnose_ci_failure");
  if (canRetry) actions.push("retry_failed_checks");
  if (complete && ci.status === "passed" && !WatchState.wasCelebrated(state, pr.headSha)) {
    actions.push("celebrate_ci_green");
    next = WatchState.markCelebrated(next, pr.headSha);
  }
  if (complete && isReadyToMerge(observation, ci, newItems.length, unresolvedThreads)) actions.push("ready_to_merge");
  if (actions.length === 0) actions.push("idle");

  return { snapshot: snapshotOf(actions), state: next, retryTargets: canRetry ? retryTargets : [] };
}

/**
 * Whether a snapshot ends the watch: the PR closed, or the user must step in.
 *
 * @param snapshot - A decided snapshot.
 * @returns `true` when the snapshot carries a `stop_*` action.
 */
export function isTerminal(snapshot: Snapshot): boolean {
  return snapshot.actions.some((action) => action.startsWith("stop_"));
}

/**
 * Whether the agent may reply in or resolve a thread on its own: only when the read was complete
 * and every participant is either the confirmed requester or an allow-listed bot.
 *
 * @param observation - A thread read in full, or the thread of a snapshot item.
 * @param policy - The requester and the bot allow-list.
 * @returns `eligible`, or `ineligible` with the reason.
 */
export function threadWriteEligibility(observation: ThreadObservation, policy: WatchPolicy): ThreadWriteEligibility {
  const { thread, completeness } = observation;
  if (thread.resolved) return { _tag: "ineligible", reason: "the thread is already resolved" };
  if (completeness._tag === "incomplete") {
    return { _tag: "ineligible", reason: `the read was incomplete: ${completeness.reasons.join("; ")}` };
  }
  const others = thread.participants.filter((author) =>
    author.role === "bot" ? !policy.reviewBots.includes(author.key) : author.key !== policy.requester,
  );
  if (others.length === 0) return { _tag: "eligible" };
  const humans = others.some((author) => author.role !== "bot");
  return {
    _tag: "ineligible",
    reason:
      humans && policy.requester === null
        ? "no --requester was confirmed, so no human thread is auto-writable"
        : `other participants: ${others.map((author) => author.login).join(", ")}`,
  };
}

/**
 * Whether a review author's feedback is surfaced under a policy.
 *
 * @param author - The author.
 * @param policy - The trust policy.
 * @returns `true` for collaborators, the confirmed requester, and allow-listed bots.
 */
export function isTrusted(author: ReviewAuthor, policy: WatchPolicy): boolean {
  if (author.key === policy.requester) return true;
  switch (author.role) {
    case "collaborator":
      return true;
    case "bot":
      return policy.reviewBots.includes(author.key);
    case "outsider":
      return false;
  }
}

/**
 * Canonical form of a `--requester` / `--review-bot` value or a GitHub login: trimmed, lowercase,
 * without a `[bot]` suffix.
 *
 * @param identity - An identity as typed by the user or reported by the forge.
 * @returns The canonical key.
 */
export function identityKey(identity: string): string {
  return identity.trim().toLowerCase().replace(/\[bot\]$/, "");
}

function strictStop(observation: Observation): Action | null {
  if (observation.pr.state !== "open") return "stop_pr_closed";
  if (observation.mergeability.status === "conflicting") return "stop_merge_conflict";
  return null;
}

function itemThreadWrite(item: ReviewItem, observation: Observation, policy: WatchPolicy): ThreadWriteEligibility {
  if (item.thread === null) return { _tag: "ineligible", reason: "not part of a resolvable thread" };
  return threadWriteEligibility({ thread: item.thread, completeness: observation.completeness }, policy);
}

function isSurfaceable(item: ReviewItem, viewer: string | null, policy: WatchPolicy): boolean {
  if (!isTrusted(item.author, policy)) return false;
  if (item.thread !== null && item.thread.resolved) return false;
  // The agent's own replies come back as items by the requester or the CLI's account; they need no answer.
  const ownAccount = item.author.key === policy.requester || (viewer !== null && item.author.key === identityKey(viewer));
  return !(ownAccount && item.body.trimStart().startsWith(policy.replyMarker));
}

function readyRetryTargets(checks: ReadonlyArray<Check>): ReadonlyArray<RetryTarget> {
  const byKey = new Map<string, RetryTarget>();
  for (const check of checks) {
    if (check.status === "failed" && check.retry !== null && check.retry.ready) {
      byKey.set(check.retry.key, check.retry.target);
    }
  }
  return [...byKey.values()];
}

function summarizeCi(checks: ReadonlyArray<Check>, retriesUsed: number, retryBudget: number): CiSummary {
  const count = (status: CheckStatus): number => checks.filter((check) => check.status === status).length;
  const failed = checks.filter((check) => check.status === "failed");
  const counts = { passed: count("passed"), failed: failed.length, pending: count("pending"), skipped: count("skipped") };
  const status =
    checks.length === 0 ? "none" : counts.failed > 0 ? "failed" : counts.pending > 0 ? "pending" : "passed";
  return {
    status,
    total: checks.length,
    ...counts,
    failedChecks: failed.map((check) => ({
      name: check.name,
      group: check.group,
      conclusion: check.conclusion,
      required: check.required,
      url: check.url,
      retryable: check.retry !== null,
    })),
    failedJobs: checks.flatMap((check) => check.failedJobs),
    retries: { used: retriesUsed, budget: retryBudget, exhausted: retriesUsed >= retryBudget },
  };
}

function isReadyToMerge(
  observation: Observation,
  ci: CiSummary,
  newItemCount: number,
  unresolvedThreads: number,
): boolean {
  return (
    !observation.pr.isDraft &&
    observation.mergeability.status === "clean" &&
    (ci.status === "passed" || ci.status === "none") &&
    ci.failedJobs.length === 0 &&
    (observation.reviewDecision === "approved" || observation.reviewDecision === "none") &&
    newItemCount === 0 &&
    unresolvedThreads === 0
  );
}
