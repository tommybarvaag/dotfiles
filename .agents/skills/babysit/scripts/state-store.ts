/**
 * The watcher's per-PR state, kept outside the repository.
 *
 * Two locks guard each pull request, with different lifetimes:
 * - `<state>.lock`, the **transaction lock**: held by `--once`, each `--watch` poll and
 *   `--retry-failed-now` (`--check-thread` does not touch state) for one load → decide → save
 *   sequence, so concurrent commands never overwrite each other's seen items or retry
 *   reservations. Waiters queue for up to {@link TRANSACTION_WAIT}.
 * - `<state>.watch.lock`, the **watcher lock**: held for the whole life of a `--watch` process to
 *   enforce one watcher per PR. It never blocks one-shot commands, which only need the
 *   transaction lock.
 */
import { Context, Duration, Effect, FileSystem, Layer, Path, Ref, Schema, Scope } from "effect";
import { decodeJson } from "./decode.ts";
import { FileLock, LockNeedsRecovery, type HeldLock, type LockError } from "./file-lock.ts";
import * as WatchState from "./watch-state.ts";

/** How long a command waits for another command's transaction on the same PR. */
const TRANSACTION_WAIT = Duration.minutes(3);
const TRANSACTION_POLL = Duration.millis(200);

/** What the state store was doing when it failed. */
export const StateFileOperation = Schema.Literals(["read", "parse", "write", "lock"]);

/** Raised when the state file cannot be read, parsed, or written. */
export class StateFileError extends Schema.TaggedError<StateFileError>()("StateFileError", {
  /** The state file path. */
  path: Schema.String,
  /** What was being attempted. */
  operation: StateFileOperation,
  /** The underlying I/O or parse failure. */
  cause: Schema.Defect(),
}) {
  /** Which file failed and how; a foreign file gets the advice to move it aside. */
  override get message(): string {
    if (this.operation === "parse") return `State file ${this.path} is not a babysit state file; move it aside to start fresh`;
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Could not ${this.operation} state file ${this.path}: ${cause}`;
  }
}

/** Raised when another command keeps this PR's state transaction for longer than the wait. */
export class StateBusy extends Schema.TaggedError<StateBusy>()("StateBusy", {
  /** The state file path. */
  path: Schema.String,
}) {
  /** Which state file is busy. */
  override get message(): string {
    return `Another babysit command is still updating ${this.path}; try again shortly`;
  }
}

/** Raised when a `--watch` for this PR is already running. */
export class WatcherAlreadyRunning extends Schema.TaggedError<WatcherAlreadyRunning>()("WatcherAlreadyRunning", {
  /** PID of the running watcher, when its lock record is readable. */
  pid: Schema.NullOr(Schema.Finite),
}) {
  /** That a watcher runs, and what to do about it. */
  override get message(): string {
    const pid = this.pid === null ? "" : ` (pid ${this.pid})`;
    return `A babysit --watch for this PR is already running${pid}; reuse it or stop it first`;
  }
}

/** Anything that can stop a state transaction from running. */
export type StateError = StateFileError | StateBusy | LockNeedsRecovery;

/** The state as loaded inside a transaction, and the way to persist it before the lock is released. */
export type StateTransaction = {
  readonly state: WatchState.WatchState;
  /**
   * Persist a state atomically. May be called more than once (e.g. a retry reservation before
   * reruns, then nothing more).
   *
   * @param next - The state to write.
   * @returns Nothing, or `StateFileError`.
   */
  readonly save: (next: WatchState.WatchState) => Effect.Effect<void, StateFileError>;
};

/** Port the watcher uses to remember state between polls, one serialized transaction at a time. */
export class StateStore extends Context.Service<
  StateStore,
  {
    /**
     * Run `body` with the PR's state loaded and the transaction lock held.
     *
     * @param body - The load → decide → save sequence.
     * @returns The body's result, or a state / lock failure.
     */
    readonly transact: <A, E, R>(
      body: (transaction: StateTransaction) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StateError, R>;
    /**
     * Take the one-watcher-per-PR lock until the surrounding scope closes.
     *
     * @returns The held lock, `WatcherAlreadyRunning`, `LockNeedsRecovery`, or `StateFileError`.
     */
    readonly holdWatcherLock: Effect.Effect<HeldLock, WatcherAlreadyRunning | StateFileError | LockNeedsRecovery, Scope.Scope>;
  }
>()("babysit/StateStore") {
  /**
   * Live layer: one JSON file per pull request, written atomically (temp file, then rename).
   *
   * @param path - Absolute path of the state file.
   * @returns A layer providing the store.
   */
  static layerFile(path: string): Layer.Layer<StateStore, never, FileSystem.FileSystem | Path.Path | FileLock> {
    return Layer.effect(
      StateStore,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const locks = yield* FileLock;
        const directory = (yield* Path.Path).dirname(path);
        const ensureDirectory = fs
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError((cause) => new StateFileError({ path, operation: "write", cause })));
        const decodeState = decodeJson(WatchState.WatchStateSchema);

        const load: Effect.Effect<WatchState.WatchState, StateFileError> = Effect.gen(function* () {
          const text = yield* fs.readFileString(path).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
            Effect.mapError((cause) => new StateFileError({ path, operation: "read", cause })),
          );
          if (text === null) return WatchState.initial;
          return yield* decodeState(text).pipe(Effect.mapError((cause) => new StateFileError({ path, operation: "parse", cause })));
        });

        // Uninterruptible as a whole: the platform's write and rename cannot be cancelled, so an
        // interrupted save could otherwise still land after the transaction lock is released and
        // overwrite a newer command's state. Interruption waits for the rename to finish, and only
        // then does the transaction's scope run the lock finalizer.
        const save = (state: WatchState.WatchState): Effect.Effect<void, StateFileError> =>
          Effect.gen(function* () {
            const temporary = `${path}.${process.pid}.tmp`;
            yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`);
            yield* fs.rename(temporary, path);
          }).pipe(
            Effect.mapError((cause) => new StateFileError({ path, operation: "write", cause })),
            Effect.uninterruptible,
          );

        return StateStore.of({
          transact: (body) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* ensureDirectory;
                const lock = yield* locks
                  .acquire(`${path}.lock`, { timeout: TRANSACTION_WAIT, poll: TRANSACTION_POLL })
                  .pipe(Effect.mapError((error) => (error._tag === "LockBusy" ? new StateBusy({ path }) : lockFailure(path, error))));
                const state = yield* load;
                const result = yield* runTransaction(state, save, body);
                // Release explicitly so a failed release is reported; the scope only backs it up.
                yield* lock.release.pipe(Effect.mapError((cause) => new StateFileError({ path, operation: "lock", cause })));
                return result;
              }),
            ),
          holdWatcherLock: Effect.gen(function* () {
            yield* ensureDirectory;
            return yield* locks.tryAcquire(`${path}.watch.lock`).pipe(
              Effect.mapError((error) =>
                error._tag === "LockBusy" ? new WatcherAlreadyRunning({ pid: error.holder?.pid ?? null }) : lockFailure(path, error),
              ),
            );
          }),
        });
      }),
    );
  }

  /**
   * Test layer: state held in memory, transactions serialized through an in-memory lock.
   *
   * @param initial - The state before the first transaction.
   * @returns A layer providing the store.
   */
  static layerMemory(initial: WatchState.WatchState = WatchState.initial): Layer.Layer<StateStore> {
    return Layer.effect(
      StateStore,
      Effect.gen(function* () {
        const stored = yield* Ref.make(initial);
        const locks = yield* FileLock;
        const save = (next: WatchState.WatchState) => Ref.set(stored, next);
        return StateStore.of({
          transact: (body) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* locks
                  .acquire("memory.lock", { timeout: TRANSACTION_WAIT, poll: TRANSACTION_POLL })
                  .pipe(Effect.mapError((error) => (error._tag === "LockBusy" ? new StateBusy({ path: "memory" }) : lockFailure("memory", error))));
                return yield* runTransaction(yield* Ref.get(stored), save, body);
              }),
            ),
          holdWatcherLock: locks
            .tryAcquire("memory.watch.lock")
            .pipe(
              Effect.mapError((error) =>
                error._tag === "LockBusy" ? new WatcherAlreadyRunning({ pid: error.holder?.pid ?? null }) : lockFailure("memory", error),
              ),
            ),
        });
      }),
    ).pipe(Layer.provide(FileLock.layerMemory));
  }
}

/**
 * Run a transaction body against a loaded state. Saving after the body ended is a defect: the
 * lock would already be released and the write could race another command.
 */
function runTransaction<A, E, R>(
  state: WatchState.WatchState,
  save: (next: WatchState.WatchState) => Effect.Effect<void, StateFileError>,
  body: (transaction: StateTransaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StateFileError, R> {
  return Effect.gen(function* () {
    const open = yield* Ref.make(true);
    const guardedSave = (next: WatchState.WatchState) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(open))) return yield* Effect.die(new Error("StateTransaction.save called after the transaction ended"));
        yield* save(next);
      });
    return yield* body({ state, save: guardedSave }).pipe(Effect.ensuring(Ref.set(open, false)));
  });
}

/** Keep a recovery error intact (it names the file to remove); wrap plain I/O failures. */
function lockFailure(path: string, error: Exclude<LockError, { _tag: "LockBusy" }>): StateFileError | LockNeedsRecovery {
  return error._tag === "LockNeedsRecovery" ? error : new StateFileError({ path, operation: "lock", cause: error });
}
