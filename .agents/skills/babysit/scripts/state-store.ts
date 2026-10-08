/**
 * File-system adapter for the watcher's per-PR state, outside the repository.
 *
 * Two locks guard each pull request, with different lifetimes:
 * - `<state>.lock`, the **transaction lock**: held by every mode (`--once`, each `--watch` poll,
 *   `--retry-failed-now`, `--check-thread` does not touch state) for one load → observe → decide →
 *   save sequence, so concurrent commands never overwrite each other's seen items or retry
 *   reservations. Waiters queue for up to {@link TRANSACTION_WAIT_MS}.
 * - `<state>.watch.lock`, the **watcher lock**: held for the whole life of a `--watch` process to
 *   enforce one watcher per PR. It never blocks one-shot commands, which only need the
 *   transaction lock.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeJson } from "./decode.ts";
import { acquireLock, tryAcquireLock, type HeldLock, type LockError, type LockNeedsRecovery } from "./file-lock.ts";
import { err, ok, type Result } from "./result.ts";
import * as WatchState from "./watch-state.ts";

/** How long a command waits for another command's transaction on the same PR. */
const TRANSACTION_WAIT_MS = 180_000;
const TRANSACTION_POLL_MS = 200;

/** Raised when the state file cannot be read, parsed, or written. */
export class StateFileError extends Error {
  readonly _tag = "StateFileError" as const;
  /** The state file path. */
  readonly path: string;
  /** The underlying I/O or parse failure. */
  override readonly cause: unknown;

  /**
   * @param path - The state file path.
   * @param operation - What was being attempted.
   * @param cause - The underlying failure.
   */
  constructor(path: string, operation: "read" | "parse" | "write" | "lock", cause: unknown) {
    super(
      operation === "parse"
        ? `State file ${path} is not a babysit state file; move it aside to start fresh`
        : `Could not ${operation} state file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.path = path;
    this.cause = cause;
  }
}

/** Raised when another command keeps this PR's state transaction for longer than the wait. */
export class StateBusy extends Error {
  readonly _tag = "StateBusy" as const;
  /** The state file path. */
  readonly path: string;

  /** @param path - The state file path. */
  constructor(path: string) {
    super(`Another babysit command is still updating ${path}; try again shortly`);
    this.path = path;
  }
}

/** Raised when a `--watch` for this PR is already running. */
export class WatcherAlreadyRunning extends Error {
  readonly _tag = "WatcherAlreadyRunning" as const;
  /** PID of the running watcher, when its lock record is readable. */
  readonly pid: number | null;

  /** @param pid - PID of the running watcher. */
  constructor(pid: number | null) {
    super(
      `A babysit --watch for this PR is already running${pid === null ? "" : ` (pid ${pid})`}; reuse it or stop it first`,
    );
    this.pid = pid;
  }
}

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
  save(next: WatchState.WatchState): Promise<Result<void, StateFileError>>;
};

/** Port the watcher uses to remember state between polls, one serialized transaction at a time. */
export type StateStore = {
  /**
   * Run `body` with the PR's state loaded and the transaction lock held.
   *
   * @param body - The load → observe → decide → save sequence.
   * @returns The body's result, or a state / lock failure.
   */
  transact<T, E>(
    body: (transaction: StateTransaction) => Promise<Result<T, E>>,
  ): Promise<Result<T, E | StateFileError | StateBusy | LockNeedsRecovery>>;
};

/**
 * A state store backed by one JSON file per pull request.
 *
 * @param path - Absolute path of the state file.
 * @returns The store.
 */
export function fileStateStore(path: string): StateStore {
  return {
    async transact(body) {
      const prepared = await ensureDirectory(path);
      if (prepared._tag === "err") return prepared;
      const lock = await acquireLock(`${path}.lock`, { timeoutMs: TRANSACTION_WAIT_MS, pollMs: TRANSACTION_POLL_MS });
      if (lock._tag === "err") {
        return err(lock.error._tag === "LockBusy" ? new StateBusy(path) : lockFailure(path, lock.error));
      }
      let open = true;
      const run = async () => {
        const state = await load(path);
        if (state._tag === "err") return state;
        return body({
          state: state.value,
          save: async (next) => {
            // Defect guard: a save after the lock is released would race other commands.
            if (!open) throw new Error("StateTransaction.save called after the transaction ended");
            return save(path, next);
          },
        });
      };
      const outcome = await run().finally(() => (open = false));
      const released = await lock.value.release();
      if (released._tag === "err" && outcome._tag === "ok") return err(new StateFileError(path, "lock", released.error));
      return outcome;
    },
  };
}

/**
 * Take the one-watcher-per-PR lock for the life of a `--watch` process.
 *
 * @param statePath - Absolute path of the PR's state file.
 * @returns The held lock, `WatcherAlreadyRunning`, or `StateFileError`.
 */
export async function acquireWatcherLock(
  statePath: string,
): Promise<Result<HeldLock, WatcherAlreadyRunning | StateFileError | LockNeedsRecovery>> {
  const prepared = await ensureDirectory(statePath);
  if (prepared._tag === "err") return prepared;
  const lock = await tryAcquireLock(`${statePath}.watch.lock`);
  if (lock._tag === "ok") return lock;
  return err(
    lock.error._tag === "LockBusy"
      ? new WatcherAlreadyRunning(lock.error.holder?.pid ?? null)
      : lockFailure(statePath, lock.error),
  );
}

/** Keep a recovery error intact (it names the file to remove); wrap plain I/O failures. */
function lockFailure(path: string, error: Exclude<LockError, { _tag: "LockBusy" }>): StateFileError | LockNeedsRecovery {
  return error._tag === "LockNeedsRecovery" ? error : new StateFileError(path, "lock", error);
}

async function ensureDirectory(path: string): Promise<Result<void, StateFileError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
    return ok(undefined);
  } catch (cause) {
    return err(new StateFileError(path, "write", cause));
  }
}

async function load(path: string): Promise<Result<WatchState.WatchState, StateFileError>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return Reflect.get(Object(cause), "code") === "ENOENT"
      ? ok(WatchState.initial)
      : err(new StateFileError(path, "read", cause));
  }
  const decoded = decodeJson(text, (input) => WatchState.parse(input));
  return decoded._tag === "ok" ? decoded : err(new StateFileError(path, "parse", decoded.error));
}

async function save(path: string, state: WatchState.WatchState): Promise<Result<void, StateFileError>> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, path);
    return ok(undefined);
  } catch (cause) {
    return err(new StateFileError(path, "write", cause));
  }
}
