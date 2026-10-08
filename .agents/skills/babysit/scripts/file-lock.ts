/**
 * Ownership-checked lock files on the local filesystem.
 *
 * Protocol:
 * - **Acquire**: write the owner record `{pid, host, token}` to a private temp file, then
 *   `link()` it to the lock path. `link` refuses to replace an existing file, so the lock appears
 *   atomically and already carries its owner: nobody can observe an empty or half-written lock.
 * - **Release**: delete the lock only if it still holds this owner's token. A failed deletion is
 *   reported and the release stays retryable.
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
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeJson, number, object, string } from "./decode.ts";
import { err, ok, type Result } from "./result.ts";

/** Who holds a lock. */
export type LockOwner = { readonly pid: number; readonly host: string; readonly token: string };

/** Raised when another live owner holds the lock. */
export class LockBusy extends Error {
  readonly _tag = "LockBusy" as const;
  /** The lock file. */
  readonly path: string;
  /** The current holder, or `null` when its record is unreadable. */
  readonly holder: LockOwner | null;

  /**
   * @param path - The lock file.
   * @param holder - The current holder, if readable.
   */
  constructor(path: string, holder: LockOwner | null) {
    super(
      holder === null
        ? `Lock ${path} is held and its owner record is unreadable; remove it if no babysit process is running`
        : `Lock ${path} is held by pid ${holder.pid} on ${holder.host}`,
    );
    this.path = path;
    this.holder = holder;
  }
}

/** Raised when the lock file cannot be created or inspected. */
export class LockFileError extends Error {
  readonly _tag = "LockFileError" as const;
  /** The lock file. */
  readonly path: string;
  /** The underlying I/O failure. */
  override readonly cause: unknown;

  /**
   * @param path - The lock file.
   * @param cause - The underlying I/O failure.
   */
  constructor(path: string, cause: unknown) {
    super(`Could not use lock ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Raised when a lock file blocks forever and only the user can safely remove it: a reaper lock
 * left by a crashed process, or a lock whose owner record is unreadable or malformed.
 */
export class LockNeedsRecovery extends Error {
  readonly _tag = "LockNeedsRecovery" as const;
  /** The lock file to remove. */
  readonly path: string;

  /**
   * @param path - The lock file.
   * @param reason - Why it cannot be reclaimed automatically.
   */
  constructor(path: string, reason: string) {
    super(`${reason}; after confirming no babysit process is running (pgrep -f babysit.ts), remove ${path}`);
    this.path = path;
  }
}

/** A lock this process holds. */
export type HeldLock = {
  /** This holder's token, as written in the lock file. */
  readonly token: string;
  /**
   * Release the lock if this holder still owns it. Safe to call again after success, and to retry
   * after a failure.
   *
   * @returns Nothing, or `LockFileError` when the lock file could not be deleted.
   */
  release(): Promise<Result<void, LockFileError>>;
};

/** Anything that can stop a lock from being taken. */
export type LockError = LockBusy | LockFileError | LockNeedsRecovery;

const ownerDecoder = object({ pid: number, host: string, token: string });

/**
 * Try once to take a lock, reclaiming it first if its owner is dead.
 *
 * @param path - The lock file path.
 * @returns The held lock, `LockBusy`, `LockNeedsRecovery`, or `LockFileError`.
 */
export async function tryAcquireLock(path: string): Promise<Result<HeldLock, LockError>> {
  // A reclaimed stale lock may be re-taken by someone else first; three passes is plenty.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = await createLock(path);
    if (created._tag === "err") return created;
    if (created.value._tag === "held") return ok(created.value.lock);
    const holder = created.value.holder;
    if (holder._tag === "absent") continue;
    if (holder._tag !== "owner") return err(damaged(path, holder._tag));
    if (!isDead(holder.owner)) return err(new LockBusy(path, holder.owner));
    const reaped = await reclaim(path, holder.owner);
    if (reaped._tag === "err") return reaped;
  }
  const last = await readOwner(path);
  if (last._tag === "unreadable" || last._tag === "malformed") return err(damaged(path, last._tag));
  return err(new LockBusy(path, last._tag === "owner" ? last.owner : null));
}

/**
 * Take a lock, waiting while another owner holds it.
 *
 * @param path - The lock file path.
 * @param options - How long to wait in total, and how often to retry.
 * @returns The held lock, `LockBusy` after the timeout, `LockNeedsRecovery`, or `LockFileError`.
 */
export async function acquireLock(
  path: string,
  options: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<Result<HeldLock, LockError>> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const attempt = await tryAcquireLock(path);
    if (attempt._tag === "ok" || attempt.error._tag !== "LockBusy" || Date.now() >= deadline) return attempt;
    await sleep(options.pollMs);
  }
}

/** What reading a lock file found. Only `absent` and `owner` say anything about ownership. */
type OwnerRead =
  | { readonly _tag: "absent" }
  | { readonly _tag: "owner"; readonly owner: LockOwner }
  | { readonly _tag: "unreadable"; readonly cause: unknown }
  | { readonly _tag: "malformed" };

type CreateOutcome = { readonly _tag: "held"; readonly lock: HeldLock } | { readonly _tag: "busy"; readonly holder: OwnerRead };

async function createLock(path: string): Promise<Result<CreateOutcome, LockFileError>> {
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const temporary = `${path}.${owner.token}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(owner), { flag: "wx" });
  } catch (cause) {
    return err(new LockFileError(path, cause));
  }
  try {
    await link(temporary, path);
    return ok({ _tag: "held", lock: heldLock(path, owner.token) });
  } catch (cause) {
    if (codeOf(cause) !== "EEXIST") return err(new LockFileError(path, cause));
    return ok({ _tag: "busy", holder: await readOwner(path) });
  } finally {
    // The temp file is only the link source; once linked or rejected it carries no lock state.
    await unlink(temporary).catch(() => undefined);
  }
}

function heldLock(path: string, token: string): HeldLock {
  // Overlapping calls (signal handler and normal cleanup) share one attempt, so a second delete
  // can never race a replacement owner. A failed attempt is forgotten so the next call retries.
  let attempt: Promise<Result<void, LockFileError>> | null = null;
  let released = false;
  return {
    token,
    release() {
      if (released) return Promise.resolve(ok(undefined));
      attempt ??= unlinkIfOwnedBy(path, token).then((deleted) => {
        released = deleted._tag === "ok";
        attempt = null;
        return deleted;
      });
      return attempt;
    },
  };
}

async function reclaim(path: string, stale: LockOwner): Promise<Result<void, LockFileError | LockNeedsRecovery>> {
  const reapPath = `${path}.reap`;
  const reaper = await createLock(reapPath);
  if (reaper._tag === "err") return reaper;
  if (reaper.value._tag === "busy") {
    const holder = reaper.value.holder;
    if (holder._tag === "unreadable" || holder._tag === "malformed") return err(damaged(reapPath, holder._tag));
    if (holder._tag === "owner" && isDead(holder.owner)) {
      return err(new LockNeedsRecovery(reapPath, `A babysit process (pid ${holder.owner.pid}) died while reclaiming a lock`));
    }
    // Another reaper is at work (or just finished); the caller simply tries again.
    return ok(undefined);
  }
  const deleted = await unlinkIfOwnedBy(path, stale.token);
  const released = await reaper.value.lock.release();
  return deleted._tag === "err" ? deleted : released;
}

/**
 * Delete a lock if `token` still owns it. Succeeds only on deletion, confirmed absence, or a
 * readable record proving another owner now holds it; an unreadable or malformed record is an
 * error, so a release stays retryable instead of silently leaving the lock behind.
 */
async function unlinkIfOwnedBy(path: string, token: string): Promise<Result<void, LockFileError>> {
  const current = await readOwner(path);
  switch (current._tag) {
    case "absent":
      return ok(undefined);
    case "unreadable":
      return err(new LockFileError(path, current.cause));
    case "malformed":
      return err(new LockFileError(path, new Error("the lock file does not hold an owner record")));
    case "owner":
      if (current.owner.token !== token) return ok(undefined);
  }
  try {
    await unlink(path);
    return ok(undefined);
  } catch (cause) {
    return codeOf(cause) === "ENOENT" ? ok(undefined) : err(new LockFileError(path, cause));
  }
}

/** A lock whose owner record cannot be trusted: nothing can prove it stale, so only the user may remove it. */
function damaged(path: string, kind: "unreadable" | "malformed"): LockNeedsRecovery {
  return new LockNeedsRecovery(path, `Lock ${path} has an ${kind} owner record`);
}

async function readOwner(path: string): Promise<OwnerRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return codeOf(cause) === "ENOENT" ? { _tag: "absent" } : { _tag: "unreadable", cause };
  }
  const owner = decodeJson(text, ownerDecoder);
  return owner._tag === "ok" ? { _tag: "owner", owner: owner.value } : { _tag: "malformed" };
}

function isDead(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (cause) {
    // EPERM: the process exists but belongs to another user.
    return codeOf(cause) !== "EPERM";
  }
}

function codeOf(cause: unknown): unknown {
  return Reflect.get(Object(cause), "code");
}
