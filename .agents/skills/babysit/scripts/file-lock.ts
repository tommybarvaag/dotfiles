/**
 * Ownership-checked lock files on the local filesystem, as a scoped resource.
 *
 * Protocol:
 * - **Acquire**: write the owner record `{pid, host, token}` to a private temp file, then
 *   `link()` it to the lock path. `link` refuses to replace an existing file, so the lock appears
 *   atomically and already carries its owner: nobody can observe an empty or half-written lock.
 * - **Release**: delete the lock only if it still holds this owner's token. A failed deletion is
 *   reported and the release stays retryable. The lock is acquired with `Effect.acquireRelease`,
 *   so closing its scope (normal exit, failure, or interruption such as Ctrl-C) releases it too.
 * - **Stale reclamation**: a lock whose owner process is dead (same host) is reclaimed under a
 *   second lock, `<path>.reap`, taken with the same link protocol. Holding it, the reaper re-reads
 *   the lock and deletes it only if it still holds the dead owner's token, so two reapers cannot
 *   delete each other's fresh locks.
 * - **Crashed reaper**: a `.reap` lock whose owner died is never deleted automatically (no
 *   operation could delete it atomically against a new reaper). Acquisition fails closed with
 *   {@link LockNeedsRecovery}, naming the file for the user to remove. So does a lock whose owner
 *   record cannot be read or parsed: nothing can prove it stale.
 *
 * Locks on another host (a shared home directory) are never reclaimed automatically.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Clock, Console, Context, Duration, Effect, FileSystem, Layer, Ref, Schedule, Schema, Scope, Semaphore } from "effect";
import { decodeJson } from "./decode.ts";

/** Schema of a lock file's owner record. */
const LockOwnerSchema = Schema.Struct({ pid: Schema.Finite, host: Schema.String, token: Schema.String });

/** Who holds a lock. */
export type LockOwner = typeof LockOwnerSchema.Type;

/** Raised when another live owner holds the lock. */
export class LockBusy extends Schema.TaggedError<LockBusy>()("LockBusy", {
  /** The lock file. */
  path: Schema.String,
  /** The current holder, or `null` when its record is unreadable. */
  holder: Schema.NullOr(LockOwnerSchema),
}) {
  /** Who holds the lock. */
  override get message(): string {
    return this.holder === null
      ? `Lock ${this.path} is held and its owner record is unreadable; remove it if no babysit process is running`
      : `Lock ${this.path} is held by pid ${this.holder.pid} on ${this.holder.host}`;
  }
}

/** Raised when the lock file cannot be created, inspected, or deleted. */
export class LockFileError extends Schema.TaggedError<LockFileError>()("LockFileError", {
  /** The lock file. */
  path: Schema.String,
  /** The underlying I/O failure. */
  cause: Schema.Defect(),
}) {
  /** Which lock failed, and why. */
  override get message(): string {
    return `Could not use lock ${this.path}: ${describeCause(this.cause)}`;
  }
}

/**
 * Raised when a lock file blocks forever and only the user can safely remove it: a reaper lock
 * left by a crashed process, or a lock whose owner record is unreadable or malformed.
 */
export class LockNeedsRecovery extends Schema.TaggedError<LockNeedsRecovery>()("LockNeedsRecovery", {
  /** The lock file to remove. */
  path: Schema.String,
  /** Why it cannot be reclaimed automatically. */
  reason: Schema.String,
}) {
  /** Why the lock is stuck, and the exact file to remove. */
  override get message(): string {
    return `${this.reason}; after confirming no babysit process is running (pgrep -f babysit.ts), remove ${this.path}`;
  }
}

/** Anything that can stop a lock from being taken. */
export type LockError = LockBusy | LockFileError | LockNeedsRecovery;

/** A lock this process holds. Its scope releases it; {@link HeldLock.release} surfaces failures. */
export type HeldLock = {
  /** This holder's token, as written in the lock file. */
  readonly token: string;
  /**
   * Release the lock if this holder still owns it. Safe to run again after success, and to retry
   * after a failure; concurrent runs are serialized, so a second delete never races a new owner.
   */
  readonly release: Effect.Effect<void, LockFileError>;
};

/** How long to keep retrying a busy lock, and how often. */
export type WaitOptions = { readonly timeout: Duration.Input; readonly poll: Duration.Input };

/** Exclusive, ownership-checked locks named by path. */
export class FileLock extends Context.Service<
  FileLock,
  {
    /**
     * Try once to take a lock, reclaiming it first if its owner is dead. Released when the
     * surrounding scope closes.
     *
     * @param path - The lock file path.
     * @returns The held lock, `LockBusy`, `LockNeedsRecovery`, or `LockFileError`.
     */
    readonly tryAcquire: (path: string) => Effect.Effect<HeldLock, LockError, Scope.Scope>;
    /**
     * Take a lock, waiting while another owner holds it. Released when the surrounding scope
     * closes. Waiting stays interruptible.
     *
     * @param path - The lock file path.
     * @param options - How long to wait in total, and how often to retry.
     * @returns The held lock, `LockBusy` after the timeout, `LockNeedsRecovery`, or `LockFileError`.
     */
    readonly acquire: (path: string, options: WaitOptions) => Effect.Effect<HeldLock, LockError, Scope.Scope>;
  }
>()("babysit/FileLock") {
  /** Live layer: lock files through the platform `FileSystem`. */
  static readonly layer: Layer.Layer<FileLock, never, FileSystem.FileSystem> = Layer.effect(
    FileLock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tryAcquire = (path: string) => scoped(tryAcquireOnce(fs, path));
      return FileLock.of({ tryAcquire, acquire: (path, options) => waitFor(tryAcquire(path), options) });
    }),
  );

  /** Test layer: locks held in memory by this process only, with the same busy / release semantics. */
  static readonly layerMemory: Layer.Layer<FileLock> = Layer.effect(
    FileLock,
    Effect.gen(function* () {
      const held = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const tryAcquire = (path: string) =>
        scoped(
          Effect.gen(function* () {
            const token = randomUUID();
            const holder = yield* Ref.modify(held, (locks): readonly [string | undefined, ReadonlyMap<string, string>] => {
              const current = locks.get(path);
              return current === undefined ? [undefined, new Map([...locks, [path, token]])] : [current, locks];
            });
            if (holder !== undefined) {
              return yield* new LockBusy({ path, holder: { pid: process.pid, host: hostname(), token: holder } });
            }
            const release = Ref.update(held, (locks) =>
              locks.get(path) === token ? new Map([...locks].filter(([key]) => key !== path)) : locks,
            );
            return { token, release };
          }),
        );
      return FileLock.of({ tryAcquire, acquire: (path, options) => waitFor(tryAcquire(path), options) });
    }),
  );
}

/** Tie a held lock to the current scope; a failed release at scope close is reported on stderr. */
function scoped<E>(acquire: Effect.Effect<HeldLock, E>): Effect.Effect<HeldLock, E, Scope.Scope> {
  return Effect.acquireRelease(acquire, (lock) =>
    lock.release.pipe(Effect.catch((error) => Console.error(`babysit: ${error.message}`))),
  );
}

/**
 * Retry a busy lock on a fixed spacing until the deadline; other failures end the wait at once.
 * The deadline is read from `Clock` before the first attempt, and a retry starts only while the
 * clock is strictly before it: `Schedule.upTo` would start counting after the first attempt and
 * still admit a retry at exactly the deadline.
 */
function waitFor<R>(
  attempt: Effect.Effect<HeldLock, LockError, R>,
  options: WaitOptions,
): Effect.Effect<HeldLock, LockError, R> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.timeout);
    return yield* attempt.pipe(
      Effect.retry({
        schedule: Schedule.spaced(options.poll),
        while: (error) =>
          error._tag === "LockBusy" ? Clock.currentTimeMillis.pipe(Effect.map((now) => now < deadline)) : Effect.succeed(false),
      }),
    );
  });
}

/** What reading a lock file found. Only `absent` and `owner` say anything about ownership. */
type OwnerRead =
  | { readonly _tag: "absent" }
  | { readonly _tag: "owner"; readonly owner: LockOwner }
  | { readonly _tag: "unreadable"; readonly cause: unknown }
  | { readonly _tag: "malformed" };

type CreateOutcome = { readonly _tag: "held"; readonly lock: HeldLock } | { readonly _tag: "busy"; readonly holder: OwnerRead };

const MAX_ATTEMPTS = 3;

function tryAcquireOnce(fs: FileSystem.FileSystem, path: string): Effect.Effect<HeldLock, LockError> {
  return Effect.gen(function* () {
    // A reclaimed stale lock may be re-taken by someone else first; three passes is plenty.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const created = yield* createLock(fs, path);
      if (created._tag === "held") return created.lock;
      const holder = created.holder;
      if (holder._tag === "absent") continue;
      if (holder._tag !== "owner") return yield* damaged(path, holder._tag);
      if (!(yield* isDead(holder.owner))) return yield* new LockBusy({ path, holder: holder.owner });
      yield* reclaim(fs, path, holder.owner);
    }
    const last = yield* readOwner(fs, path);
    if (last._tag === "unreadable" || last._tag === "malformed") return yield* damaged(path, last._tag);
    return yield* new LockBusy({ path, holder: last._tag === "owner" ? last.owner : null });
  });
}

function createLock(fs: FileSystem.FileSystem, path: string): Effect.Effect<CreateOutcome, LockFileError> {
  return Effect.gen(function* () {
    const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
    const temporary = `${path}.${owner.token}.tmp`;
    yield* fs
      .writeFileString(temporary, JSON.stringify(owner), { flag: "wx" })
      .pipe(Effect.mapError((cause) => new LockFileError({ path, cause })));
    const linked = yield* fs.link(temporary, path).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      Effect.mapError((cause) => new LockFileError({ path, cause })),
      // The temp file is only the link source; once linked or rejected it carries no lock state.
      Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
    );
    if (linked) return { _tag: "held", lock: yield* heldLock(fs, path, owner.token) } as const;
    return { _tag: "busy", holder: yield* readOwner(fs, path) } as const;
  });
}

function heldLock(fs: FileSystem.FileSystem, path: string, token: string): Effect.Effect<HeldLock> {
  return Effect.gen(function* () {
    const released = yield* Ref.make(false);
    const serial = yield* Semaphore.make(1);
    // `withPermits` restores interruptibility for its body, and the platform's file removal cannot
    // be cancelled. If an interrupt could end this body mid-removal, the permit would be freed while
    // the removal still runs, and a second release (the scope finalizer) could pass the same token
    // check and later delete a replacement owner's lock. So the check, the removal and the flag
    // update run as one uninterruptible step; only waiting for the permit stays interruptible.
    const release = serial.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* Ref.get(released)) return;
          yield* unlinkIfOwnedBy(fs, path, token);
          yield* Ref.set(released, true);
        }),
      ),
    );
    return { token, release };
  });
}

function reclaim(fs: FileSystem.FileSystem, path: string, stale: LockOwner): Effect.Effect<void, LockFileError | LockNeedsRecovery> {
  return Effect.gen(function* () {
    const reapPath = `${path}.reap`;
    const reaper = yield* createLock(fs, reapPath);
    if (reaper._tag === "busy") {
      const holder = reaper.holder;
      if (holder._tag === "unreadable" || holder._tag === "malformed") return yield* damaged(reapPath, holder._tag);
      if (holder._tag === "owner" && (yield* isDead(holder.owner))) {
        return yield* new LockNeedsRecovery({
          path: reapPath,
          reason: `A babysit process (pid ${holder.owner.pid}) died while reclaiming a lock`,
        });
      }
      // Another reaper is at work (or just finished); the caller simply tries again.
      return;
    }
    yield* unlinkIfOwnedBy(fs, path, stale.token).pipe(Effect.ensuring(reaper.lock.release.pipe(Effect.ignore)));
    yield* reaper.lock.release;
  });
}

/**
 * Delete a lock if `token` still owns it. Succeeds only on deletion, confirmed absence, or a
 * readable record proving another owner now holds it; an unreadable or malformed record is an
 * error, so a release stays retryable instead of silently leaving the lock behind.
 */
function unlinkIfOwnedBy(fs: FileSystem.FileSystem, path: string, token: string): Effect.Effect<void, LockFileError> {
  return Effect.gen(function* () {
    const current = yield* readOwner(fs, path);
    switch (current._tag) {
      case "absent":
        return;
      case "unreadable":
        return yield* new LockFileError({ path, cause: current.cause });
      case "malformed":
        return yield* new LockFileError({ path, cause: new Error("the lock file does not hold an owner record") });
      case "owner":
        if (current.owner.token !== token) return;
    }
    yield* fs.remove(path).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      Effect.mapError((cause) => new LockFileError({ path, cause })),
    );
  });
}

/** A lock whose owner record cannot be trusted: nothing can prove it stale, so only the user may remove it. */
function damaged(path: string, kind: "unreadable" | "malformed"): LockNeedsRecovery {
  return new LockNeedsRecovery({ path, reason: `Lock ${path} has an ${kind} owner record` });
}

const decodeOwner = decodeJson(LockOwnerSchema);

function readOwner(fs: FileSystem.FileSystem, path: string): Effect.Effect<OwnerRead> {
  return fs.readFileString(path).pipe(
    Effect.flatMap((text) =>
      decodeOwner(text).pipe(
        Effect.map((owner): OwnerRead => ({ _tag: "owner", owner })),
        Effect.orElseSucceed((): OwnerRead => ({ _tag: "malformed" })),
      ),
    ),
    Effect.catch((cause) =>
      Effect.succeed<OwnerRead>(cause.reason._tag === "NotFound" ? { _tag: "absent" } : { _tag: "unreadable", cause }),
    ),
  );
}

/** Whether a same-host owner process has exited. Owners on other hosts are never presumed dead. */
function isDead(owner: LockOwner): Effect.Effect<boolean> {
  return Effect.sync(() => {
    if (owner.host !== hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (cause) {
      // EPERM: the process exists but belongs to another user.
      return Reflect.get(Object(cause), "code") !== "EPERM";
    }
  });
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
