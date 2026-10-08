/**
 * Application service: one babysat pull request. Each operation observes the forge first, with no
 * lock held, then runs load → decide → save inside one short state transaction, so concurrent
 * commands on the same PR serialize their state updates without waiting on each other's network calls.
 * Also owns the `--watch` loop policy (emit on change or heartbeat, stop on a terminal action,
 * tolerate transient errors) and the retry reservation protocol.
 */
import type { ForgeClient, ForgeError, RerunResult, ThreadNotFound } from "./forge-client.ts";
import {
  decide,
  isTerminal,
  threadWriteEligibility,
  type CiSummary,
  type ReviewAuthor,
  type RetryTarget,
  type Snapshot,
  type ThreadWriteEligibility,
  type WatchPolicy,
} from "./pr-snapshot.ts";
import { err, ok, type Result } from "./result.ts";
import type { LockNeedsRecovery } from "./file-lock.ts";
import type { StateBusy, StateFileError, StateStore } from "./state-store.ts";
import * as WatchState from "./watch-state.ts";

/** A snapshot could not be taken. */
export type SnapshotError = ForgeError | StateFileError | StateBusy | LockNeedsRecovery;

/** Raised by `--retry-failed-now` when the decision offers no rerun. Nothing is changed. */
export class NothingToRetry extends Error {
  readonly _tag = "NothingToRetry" as const;
  /** Why no rerun is offered. */
  readonly reason: "pr_stopped" | "budget_exhausted" | "no_retryable_failures";

  /** @param reason - Why no rerun is offered. */
  constructor(reason: "pr_stopped" | "budget_exhausted" | "no_retryable_failures") {
    super(
      reason === "pr_stopped"
        ? "The pull request is at a strict stop (closed or conflicting); nothing is rerun"
        : reason === "budget_exhausted"
          ? "The flaky-retry budget for this head SHA is spent; treat remaining failures as needing the user"
          : "No failed check can be rerun right now (none failed, or the run or build is still in progress)",
    );
    this.reason = reason;
  }
}

/** What happened to one rerun target. */
export type RerunOutcome =
  | (RerunResult & { readonly target: RetryTarget })
  | { readonly _tag: "failed"; readonly target: RetryTarget; readonly error: string };

/** What `--retry-failed-now` did. One retry cycle is spent even when some reruns failed. */
export type RetryOutcome = {
  readonly headSha: string;
  /** CI as it was when the retry was decided. */
  readonly ci: CiSummary;
  readonly reruns: ReadonlyArray<RerunOutcome>;
  readonly retries: { readonly used: number; readonly budget: number };
};

/** The fresh, complete check of one thread before replying to or resolving it. */
export type ThreadCheck = {
  readonly threadId: string;
  readonly resolved: boolean;
  readonly participants: ReadonlyArray<ReviewAuthor>;
  readonly threadWrite: ThreadWriteEligibility;
};

/** One line of `--watch` output. */
export type WatchEvent =
  | { readonly _tag: "snapshot"; readonly snapshot: Snapshot }
  | { readonly _tag: "error"; readonly error: SnapshotError; readonly consecutive: number };

/** Loop tuning for `--watch`. */
export type WatchOptions = {
  readonly intervalMs: number;
  /** Re-emit an unchanged snapshot on every Nth unchanged poll, as a heartbeat. */
  readonly heartbeatEvery: number;
  /** Give up after this many failed polls in a row. */
  readonly maxConsecutiveErrors: number;
};

/** Effects the watch loop needs from its host. */
export type WatchIo = {
  emit(event: WatchEvent): void;
  sleep(ms: number): Promise<void>;
};

/** Babysits one pull request through a forge client and a state store. */
export class Babysitter {
  readonly #forge: ForgeClient;
  readonly #store: StateStore;
  readonly #policy: WatchPolicy;
  readonly #now: () => Date;

  /**
   * @param forge - The pull request's forge client.
   * @param store - Where watch state persists.
   * @param policy - Trust and retry policy.
   * @param now - Clock for snapshot timestamps.
   */
  constructor(forge: ForgeClient, store: StateStore, policy: WatchPolicy, now: () => Date) {
    this.#forge = forge;
    this.#store = store;
    this.#policy = policy;
    this.#now = now;
  }

  /**
   * Take one snapshot and remember what it surfaced.
   *
   * @returns The snapshot, or the forge / state failure.
   */
  async snapshot(): Promise<Result<Snapshot, SnapshotError>> {
    const observation = await this.#forge.observe();
    if (observation._tag === "err") return observation;
    return this.#store.transact(async (transaction): Promise<Result<Snapshot, SnapshotError>> => {
      const decision = decide(observation.value, transaction.state, this.#policy, this.#now().toISOString());
      const saved = await transaction.save(decision.state);
      return saved._tag === "err" ? saved : ok(decision.snapshot);
    });
  }

  /**
   * Rerun failed checks when the decision offers `retry_failed_checks`.
   *
   * The retry cycle is reserved and saved before the first rerun, so a crash or a partial failure
   * still counts against the budget. A refusal changes nothing, not even seen review items.
   *
   * @returns Per-target outcomes, `NothingToRetry`, or the forge / state failure.
   */
  async retryFailedNow(): Promise<Result<RetryOutcome, SnapshotError | NothingToRetry>> {
    const observation = await this.#forge.observe();
    if (observation._tag === "err") return observation;
    type Reserved = { snapshot: Snapshot; retryTargets: ReadonlyArray<RetryTarget>; used: number };
    const reservation = await this.#store.transact(async (transaction): Promise<Result<Reserved, SnapshotError | NothingToRetry>> => {
      const { snapshot, retryTargets } = decide(observation.value, transaction.state, this.#policy, this.#now().toISOString());
      if (isTerminal(snapshot)) return err(new NothingToRetry("pr_stopped"));
      if (retryTargets.length === 0) {
        const exhausted = snapshot.ci.failed > 0 && snapshot.ci.retries.exhausted;
        return err(new NothingToRetry(exhausted ? "budget_exhausted" : "no_retryable_failures"));
      }
      const reserved = WatchState.reserveRetry(transaction.state, snapshot.pr.headSha);
      const saved = await transaction.save(reserved);
      if (saved._tag === "err") return saved;
      return ok({ snapshot, retryTargets, used: WatchState.retriesUsed(reserved, snapshot.pr.headSha) });
    });
    if (reservation._tag === "err") return reservation;

    // The cycle is committed; the reruns run outside the lock.
    const { snapshot, retryTargets, used } = reservation.value;
    const reruns: RerunOutcome[] = [];
    for (const target of retryTargets) {
      const rerun = await this.#forge.rerun(target, snapshot.pr.headSha);
      reruns.push(rerun._tag === "ok" ? { ...rerun.value, target } : { _tag: "failed", target, error: rerun.error.message });
    }
    return ok({ headSha: snapshot.pr.headSha, ci: snapshot.ci, reruns, retries: { used, budget: this.#policy.retryBudget } });
  }

  /**
   * Read one thread in full and decide whether the agent may reply to or resolve it on its own.
   * Read-only; touches no state.
   *
   * @param threadId - The thread ID from a snapshot item.
   * @returns The check, `ThreadNotFound`, or a forge failure.
   */
  async checkThread(threadId: string): Promise<Result<ThreadCheck, ForgeError | ThreadNotFound>> {
    const observed = await this.#forge.readThread(threadId);
    if (observed._tag === "err") return observed;
    return ok({
      threadId: observed.value.thread.id,
      resolved: observed.value.thread.resolved,
      participants: observed.value.thread.participants,
      threadWrite: threadWriteEligibility(observed.value, this.#policy),
    });
  }

  /**
   * Poll until a terminal action (PR closed, user needed) or too many consecutive errors.
   * Emits a snapshot when it differs from the last one emitted, or as a periodic heartbeat.
   *
   * @param options - Loop tuning.
   * @param io - Output and sleeping.
   * @returns The terminal snapshot, or the last error once the error budget is spent.
   */
  async watch(options: WatchOptions, io: WatchIo): Promise<Result<Snapshot, SnapshotError>> {
    let lastFingerprint: string | null = null;
    let silentPolls = 0;
    let consecutiveErrors = 0;
    for (;;) {
      const snapshot = await this.snapshot();
      if (snapshot._tag === "err") {
        consecutiveErrors += 1;
        io.emit({ _tag: "error", error: snapshot.error, consecutive: consecutiveErrors });
        if (consecutiveErrors >= options.maxConsecutiveErrors) return snapshot;
      } else {
        consecutiveErrors = 0;
        const fingerprint = fingerprintOf(snapshot.value);
        if (fingerprint !== lastFingerprint || silentPolls + 1 >= options.heartbeatEvery) {
          io.emit({ _tag: "snapshot", snapshot: snapshot.value });
          lastFingerprint = fingerprint;
          silentPolls = 0;
        } else {
          silentPolls += 1;
        }
        if (isTerminal(snapshot.value)) return snapshot;
      }
      await io.sleep(options.intervalMs);
    }
  }
}

function fingerprintOf(snapshot: Snapshot): string {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}
