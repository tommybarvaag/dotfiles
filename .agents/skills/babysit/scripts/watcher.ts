/**
 * Application service: one babysat pull request. Each operation observes the forge first, with no
 * lock held, then runs load → decide → save inside one short state transaction, so concurrent
 * commands on the same PR serialize their state updates without waiting on each other's network calls.
 * Also owns the `--watch` loop policy (emit on change or heartbeat, stop on a terminal action,
 * tolerate transient errors) and the retry reservation protocol.
 */
import { Context, DateTime, Duration, Effect, Layer, Ref, Result, Schedule, Schema } from "effect";
import { ForgeClient, type ForgeError, type RerunResult, type ThreadNotFound } from "./forge-client.ts";
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
import { StateStore, type StateError } from "./state-store.ts";
import * as WatchState from "./watch-state.ts";

/** A snapshot could not be taken. */
export type SnapshotError = ForgeError | StateError;

/** Why `--retry-failed-now` offers no rerun. */
export const NothingToRetryReason = Schema.Literals(["pr_stopped", "budget_exhausted", "no_retryable_failures"]);

/** Raised by `--retry-failed-now` when the decision offers no rerun. Nothing is changed. */
export class NothingToRetry extends Schema.TaggedError<NothingToRetry>()("NothingToRetry", {
  /** Why no rerun is offered. */
  reason: NothingToRetryReason,
}) {
  /** Why nothing was rerun, in words the agent can relay. */
  override get message(): string {
    switch (this.reason) {
      case "pr_stopped":
        return "The pull request is at a strict stop (closed or conflicting); nothing is rerun";
      case "budget_exhausted":
        return "The flaky-retry budget for this head SHA is spent; treat remaining failures as needing the user";
      case "no_retryable_failures":
        return "No failed check can be rerun right now (none failed, or the run or build is still in progress)";
    }
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
  readonly interval: Duration.Input;
  /** Re-emit an unchanged snapshot on every Nth unchanged poll, as a heartbeat. */
  readonly heartbeatEvery: number;
  /** Give up after this many failed polls in a row. */
  readonly maxConsecutiveErrors: number;
};

/** Babysits one pull request through its forge client and state store. */
export class Babysitter extends Context.Service<
  Babysitter,
  {
    /** Take one snapshot and remember what it surfaced. */
    readonly snapshot: Effect.Effect<Snapshot, SnapshotError>;
    /**
     * Rerun failed checks when the decision offers `retry_failed_checks`. The retry cycle is
     * reserved and saved before the first rerun, so a crash or a partial failure still counts
     * against the budget. A refusal changes nothing, not even seen review items.
     */
    readonly retryFailedNow: Effect.Effect<RetryOutcome, SnapshotError | NothingToRetry>;
    /**
     * Read one thread in full and decide whether the agent may reply to or resolve it on its own.
     * Read-only; touches no state.
     *
     * @param threadId - The thread ID from a snapshot item.
     * @returns The check, `ThreadNotFound`, or a forge failure.
     */
    readonly checkThread: (threadId: string) => Effect.Effect<ThreadCheck, ForgeError | ThreadNotFound>;
    /**
     * Poll on a fixed schedule until a terminal action (PR closed, user needed) or too many
     * consecutive errors. Emits a snapshot when it differs from the last one emitted, or as a
     * periodic heartbeat.
     *
     * @param options - Loop tuning.
     * @param emit - Writes one event.
     * @returns The terminal snapshot, or the last error once the error budget is spent.
     */
    readonly watch: <R>(
      options: WatchOptions,
      emit: (event: WatchEvent) => Effect.Effect<void, never, R>,
    ) => Effect.Effect<Snapshot, SnapshotError, R>;
  }
>()("babysit/Babysitter") {
  /**
   * Build the service for one policy.
   *
   * @param policy - Trust and retry policy.
   * @returns A layer that needs the PR's forge client and state store.
   */
  static layer(policy: WatchPolicy): Layer.Layer<Babysitter, never, ForgeClient | StateStore> {
    return Layer.effect(
      Babysitter,
      Effect.gen(function* () {
        const forge = yield* ForgeClient;
        const store = yield* StateStore;
        const observedAt = DateTime.now.pipe(Effect.map(DateTime.formatIso));

        const snapshot = Effect.gen(function* () {
          const observation = yield* forge.observe;
          const now = yield* observedAt;
          return yield* store.transact((transaction) =>
            Effect.gen(function* () {
              const decision = decide(observation, transaction.state, policy, now);
              yield* transaction.save(decision.state);
              return decision.snapshot;
            }),
          );
        });

        const retryFailedNow = Effect.gen(function* () {
          const observation = yield* forge.observe;
          const now = yield* observedAt;
          const { decided, retryTargets, used } = yield* store.transact((transaction) =>
            Effect.gen(function* () {
              const { snapshot: decided, retryTargets } = decide(observation, transaction.state, policy, now);
              if (isTerminal(decided)) return yield* new NothingToRetry({ reason: "pr_stopped" });
              if (retryTargets.length === 0) {
                const exhausted = decided.ci.failed > 0 && decided.ci.retries.exhausted;
                return yield* new NothingToRetry({ reason: exhausted ? "budget_exhausted" : "no_retryable_failures" });
              }
              const reserved = WatchState.reserveRetry(transaction.state, decided.pr.headSha);
              yield* transaction.save(reserved);
              return { decided, retryTargets, used: WatchState.retriesUsed(reserved, decided.pr.headSha) };
            }),
          );

          // The cycle is committed; the reruns run outside the lock, one after another.
          const headSha = decided.pr.headSha;
          const reruns = yield* Effect.forEach(retryTargets, (target) =>
            forge.rerun(target, headSha).pipe(
              Effect.map((rerun): RerunOutcome => ({ ...rerun, target })),
              Effect.catch((error) => Effect.succeed<RerunOutcome>({ _tag: "failed", target, error: error.message })),
            ),
          );
          return { headSha, ci: decided.ci, reruns, retries: { used, budget: policy.retryBudget } };
        });

        const checkThread = (threadId: string) =>
          forge.readThread(threadId).pipe(
            Effect.map((observed) => ({
              threadId: observed.thread.id,
              resolved: observed.thread.resolved,
              participants: observed.thread.participants,
              threadWrite: threadWriteEligibility(observed, policy),
            })),
          );

        const watch = <R>(options: WatchOptions, emit: (event: WatchEvent) => Effect.Effect<void, never, R>) =>
          Effect.gen(function* () {
            const loop = yield* Ref.make(initialLoop);
            const poll = Effect.gen(function* () {
              const polled = yield* Effect.result(snapshot);
              const step = advance(yield* Ref.get(loop), polled, options);
              yield* Ref.set(loop, step.next);
              if (step.event !== null) yield* emit(step.event);
              return step.outcome;
            });
            const outcome = yield* poll.pipe(
              Effect.repeat({ schedule: Schedule.spaced(options.interval), until: (step) => step._tag === "stop" }),
            );
            if (outcome._tag !== "stop") return yield* Effect.die(new Error("the watch loop ended without a stop"));
            return yield* Effect.fromResult(outcome.result);
          });

        return Babysitter.of({ snapshot, retryFailedNow, checkThread, watch });
      }),
    );
  }
}

/** What the watch loop remembers between polls. */
type LoopState = {
  readonly lastFingerprint: string | null;
  readonly silentPolls: number;
  readonly consecutiveErrors: number;
};

/** One poll's effect on the loop: the next state, what to print, and whether to keep polling. */
type LoopStep = {
  readonly next: LoopState;
  readonly event: WatchEvent | null;
  readonly outcome: { readonly _tag: "continue" } | { readonly _tag: "stop"; readonly result: Result.Result<Snapshot, SnapshotError> };
};

const initialLoop: LoopState = { lastFingerprint: null, silentPolls: 0, consecutiveErrors: 0 };
const CONTINUE = { _tag: "continue" } as const;

/** The watch loop's policy for one poll, as a pure transition. */
function advance(state: LoopState, polled: Result.Result<Snapshot, SnapshotError>, options: WatchOptions): LoopStep {
  if (Result.isFailure(polled)) {
    const consecutiveErrors = state.consecutiveErrors + 1;
    return {
      next: { ...state, consecutiveErrors },
      event: { _tag: "error", error: polled.failure, consecutive: consecutiveErrors },
      outcome: consecutiveErrors >= options.maxConsecutiveErrors ? { _tag: "stop", result: polled } : CONTINUE,
    };
  }
  const snapshot = polled.success;
  const fingerprint = fingerprintOf(snapshot);
  const emit = fingerprint !== state.lastFingerprint || state.silentPolls + 1 >= options.heartbeatEvery;
  return {
    next: emit
      ? { lastFingerprint: fingerprint, silentPolls: 0, consecutiveErrors: 0 }
      : { ...state, silentPolls: state.silentPolls + 1, consecutiveErrors: 0 },
    event: emit ? { _tag: "snapshot", snapshot } : null,
    outcome: isTerminal(snapshot) ? { _tag: "stop", result: polled } : CONTINUE,
  };
}

function fingerprintOf(snapshot: Snapshot): string {
  const { observedAt: _observedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}
