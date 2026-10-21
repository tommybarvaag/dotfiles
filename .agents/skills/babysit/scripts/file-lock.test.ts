import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Fiber, Layer, Result, Scope } from "effect";
import { TestClock } from "effect/testing";
import { FileLock, type HeldLock } from "./file-lock.ts";
import { gatedFileSystem, Gates } from "./gated-file-system.ts";

const MODULE = fileURLToPath(new URL("./file-lock.ts", import.meta.url));
const SCRIPTS = dirname(MODULE);

const LockLayer = FileLock.layer.pipe(Layer.provide(NodeServices.layer));

const promise = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

const lockPath = () => promise(async () => join(await mkdtemp(join(tmpdir(), "babysit-lock-")), "pr.json.lock"));

const exists = (path: string) =>
  promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );

/** The PID of a process that has already exited. */
const deadPid = () =>
  promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", ""]);
        child.on("error", reject);
        child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
      }),
  );

/** Try once to take a lock in the test's scope. */
const tryAcquire = (path: string) => FileLock.use((locks) => locks.tryAcquire(path));

/** Try once, in a scope of its own that stays open until the test closes it. */
const tryAcquireOpen = (path: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const lock = yield* Effect.result(tryAcquire(path).pipe(Scope.provide(scope)));
    return { lock, close: Scope.close(scope, Exit.void) };
  });

const ownerToken = (path: string) => promise(async () => String(JSON.parse(await readFile(path, "utf8")).token));

const held = (lock: Result.Result<HeldLock, { readonly _tag: string }>): HeldLock =>
  Result.isSuccess(lock) ? lock.success : assert.fail(`expected a held lock, got ${lock.failure._tag}`);

describe("file locks", () => {
  it.live("admits exactly one of many concurrent acquirers in this process", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const attempts = yield* Effect.all(
        Array.from({ length: 20 }, () => Effect.result(tryAcquire(path))),
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter(Result.isSuccess).length, 1);
      assert.ok(attempts.every((attempt) => Result.isSuccess(attempt) || attempt.failure._tag === "LockBusy"));
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("admits exactly one of several processes racing for the lock", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const script = `const { FileLock } = await import(${JSON.stringify(MODULE)});
        const { Effect, Layer } = await import("effect");
        const NodeServices = await import("@effect/platform-node/NodeServices");
        const attempt = Effect.scoped(FileLock.use((locks) => locks.tryAcquire(${JSON.stringify(path)})).pipe(
          Effect.tap(() => Effect.sleep("300 millis")), Effect.as("ok"), Effect.catch((error) => Effect.succeed(error._tag))));
        process.stdout.write(await Effect.runPromise(attempt.pipe(Effect.provide(FileLock.layer.pipe(Layer.provide(NodeServices.layer))))));`;
      const outcomes = yield* Effect.all(
        Array.from({ length: 6 }, () =>
          promise(
            () =>
              new Promise<string>((resolve, reject) =>
                execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: SCRIPTS }, (error, stdout) =>
                  error === null ? resolve(stdout) : reject(error),
                ),
              ),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(outcomes.filter((outcome) => outcome === "ok").length, 1, outcomes.join(","));
    }),
  );

  it.live("writes the owner record before the lock becomes visible", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const lock = yield* tryAcquire(path);
      const owner = JSON.parse(yield* promise(() => readFile(path, "utf8")));
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.token, lock.token);
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("releases when its scope closes, and only its own lock", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      yield* Effect.scoped(tryAcquire(path));
      assert.ok(!(yield* exists(path)), "closing the scope released the lock");

      const mine = yield* tryAcquireOpen(path);
      held(mine.lock);
      // Someone else's lock now sits at the path (e.g. after a reclamation).
      yield* promise(() => writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else" })));
      yield* mine.close;
      assert.ok(yield* exists(path), "the other owner's lock survives");
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("releases the lock when the holding fiber is interrupted", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const holder = yield* Effect.forkChild(Effect.scoped(tryAcquire(path).pipe(Effect.andThen(Effect.never))));
      while (!(yield* exists(path))) yield* Effect.sleep("5 millis");
      yield* Fiber.interrupt(holder);
      assert.ok(!(yield* exists(path)), "interruption ran the release");
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("reclaims a lock whose owner died, once, even with concurrent reclaimers", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const pid = yield* deadPid();
      yield* promise(() => writeFile(path, JSON.stringify({ pid, host: hostname(), token: "dead" })));
      const attempts = yield* Effect.all(
        Array.from({ length: 10 }, () => Effect.result(tryAcquire(path))),
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter(Result.isSuccess).length, 1);
      assert.ok(!(yield* exists(`${path}.reap`)), "the reaper lock is released");
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("fails closed on a reaper lock left by a crashed process, naming the file to remove", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const [owner, reaper] = [yield* deadPid(), yield* deadPid()];
      yield* promise(() => writeFile(path, JSON.stringify({ pid: owner, host: hostname(), token: "dead-owner" })));
      yield* promise(() => writeFile(`${path}.reap`, JSON.stringify({ pid: reaper, host: hostname(), token: "dead-reaper" })));
      const attempts = yield* Effect.all(
        Array.from({ length: 5 }, () => Effect.flip(tryAcquire(path))),
        { concurrency: "unbounded" },
      );
      for (const failure of attempts) {
        assert.equal(failure._tag, "LockNeedsRecovery");
        assert.match(failure.message, new RegExp(`remove ${path}\\.reap`));
      }
      assert.ok(yield* exists(`${path}.reap`), "the orphaned reaper lock is left for the user");
      assert.ok(yield* exists(path), "the stale lock is not reclaimed behind the user's back");
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("reports a failed release and lets it be retried", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const lock = yield* tryAcquire(path);
      yield* promise(() => chmod(dirname(path), 0o500));
      const failed = yield* Effect.flip(lock.release);
      yield* promise(() => chmod(dirname(path), 0o700));
      assert.equal(failed._tag, "LockFileError");
      assert.ok(yield* exists(path));
      yield* lock.release;
      assert.ok(!(yield* exists(path)));
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("keeps a release retryable when the owner record cannot be read or is malformed", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const lock = yield* tryAcquire(path);
      yield* promise(() => chmod(path, 0o000));
      const unreadable = yield* Effect.flip(lock.release);
      yield* promise(() => chmod(path, 0o600));
      assert.equal(unreadable._tag, "LockFileError");
      assert.ok(yield* exists(path), "the lock is still there");

      const original = yield* promise(() => readFile(path, "utf8"));
      yield* promise(() => writeFile(path, "not json"));
      assert.ok(Result.isFailure(yield* Effect.result(lock.release)), "ownership cannot be verified");
      yield* promise(() => writeFile(path, original));
      yield* lock.release;
      assert.ok(!(yield* exists(path)));
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("treats a lock from another host as busy, and a malformed one as needing recovery", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const pid = yield* deadPid();
      yield* promise(() => writeFile(path, JSON.stringify({ pid, host: "some-other-host", token: "remote" })));
      assert.equal((yield* Effect.flip(tryAcquire(path)))._tag, "LockBusy");

      const garbled = yield* lockPath();
      yield* promise(() => writeFile(garbled, "12345"));
      const malformed = yield* Effect.flip(tryAcquire(garbled));
      assert.equal(malformed._tag, "LockNeedsRecovery");
      assert.match(malformed.message, new RegExp(`remove ${garbled}$`));
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("serializes overlapping releases, so a replacement owner survives", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const first = yield* tryAcquireOpen(path);
      const lock = held(first.lock);
      // Explicit release and scope cleanup run at the same time.
      yield* Effect.all([lock.release, first.close], { concurrency: "unbounded" });
      const replacement = yield* tryAcquire(path);
      yield* lock.release;
      assert.equal(yield* ownerToken(path), replacement.token, "the replacement lock is intact");
    }).pipe(Effect.provide(LockLayer)),
  );

  it.live("waits for a held lock and takes it once released", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const first = yield* tryAcquireOpen(path);
      held(first.lock);
      yield* Effect.forkChild(Effect.sleep("150 millis").pipe(Effect.andThen(first.close)));
      const waited = FileLock.use((locks) => locks.acquire(path, { timeout: "5 seconds", poll: "20 millis" }));
      yield* waited;
      const timedOut = yield* Effect.flip(
        FileLock.use((locks) => locks.acquire(path, { timeout: "100 millis", poll: "20 millis" })),
      );
      assert.equal(timedOut._tag, "LockBusy");
    }).pipe(Effect.provide(LockLayer)),
  );
});

describe("in-memory file locks", () => {
  it.effect("are exclusive per path and released with their scope", () =>
    Effect.gen(function* () {
      const first = yield* tryAcquireOpen("pr.json.lock");
      held(first.lock);
      assert.equal((yield* Effect.flip(Effect.scoped(tryAcquire("pr.json.lock"))))._tag, "LockBusy");
      yield* Effect.scoped(tryAcquire("other.lock"));
      yield* first.close;
      yield* Effect.scoped(tryAcquire("pr.json.lock"));
    }).pipe(Effect.provide(FileLock.layerMemory)),
  );
});

describe("lock release under interruption", () => {
  it.live("an interrupted release finishes its removal before any other release can run", () =>
    Effect.gen(function* () {
      const path = yield* lockPath();
      const gates = new Gates();
      // Only removals of the lock file itself are held, and only during the race; temp files and
      // the replacement owner's own cleanup pass through.
      let racing = true;
      const layer = FileLock.layer.pipe(
        Layer.provide(gatedFileSystem(gates, (operation, target) => racing && operation === "remove" && target === path)),
      );
      yield* Effect.gen(function* () {
        const first = yield* tryAcquireOpen(path);
        const lock = held(first.lock);

        const releasing = yield* Effect.forkChild(lock.release);
        const removal = yield* gates.nth(1);
        // Ctrl-C lands while the platform removal is in flight, and the scope's own cleanup follows.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(releasing));
        const closing = yield* Effect.forkChild(first.close);
        // Room for a second removal to start, if the first one's permit had been given back.
        yield* Effect.sleep("50 millis");
        assert.equal(gates.calls.length, 1, "no second removal starts while the first is in flight");

        removal.open();
        yield* Fiber.join(interrupting);
        yield* Fiber.join(closing);
        racing = false;
        const replacement = yield* tryAcquire(path);
        yield* gates.openAll();
        assert.equal(gates.calls.length, 1);
        assert.equal(yield* ownerToken(path), replacement.token, "the replacement owner's lock survives");
      }).pipe(
        // On a failed assertion, let every held operation finish so the test's scope can close.
        Effect.ensuring(Effect.suspend(() => ((racing = false), gates.openAll()))),
        Effect.provide(layer),
      );
    }),
  );
});

describe("lock-wait deadline", () => {
  const options = { timeout: "100 millis", poll: "20 millis" } as const;

  /** Wait for `path` while another holder keeps it until `releaseAt` (or forever), on the test clock. */
  const waitAgainst = (releaseAt: Duration.Input | null) =>
    Effect.gen(function* () {
      const holder = yield* tryAcquireOpen("pr.json.lock");
      held(holder.lock);
      if (releaseAt !== null) yield* Effect.forkChild(Effect.sleep(releaseAt).pipe(Effect.andThen(holder.close)));
      const waiting = yield* Effect.forkChild(
        Effect.scoped(FileLock.use((locks) => locks.acquire("pr.json.lock", options))).pipe(
          Effect.result,
          Effect.flatMap((outcome) => Clock.currentTimeMillis.pipe(Effect.map((at) => ({ outcome, at })))),
        ),
      );
      for (let step = 0; step < 30; step += 1) yield* TestClock.adjust("10 millis");
      return yield* Fiber.join(waiting);
    }).pipe(Effect.provide(FileLock.layerMemory));

  it.effect("gives up at exactly the deadline, measured from before the first attempt", () =>
    Effect.gen(function* () {
      const { outcome, at } = yield* waitAgainst(null);
      assert.ok(Result.isFailure(outcome) && outcome.failure._tag === "LockBusy");
      assert.equal(at, 100, "the attempt at 100 ms is the last; no retry is scheduled at the deadline");
    }),
  );

  it.effect("does not take a lock released after the deadline", () =>
    Effect.gen(function* () {
      // Schedule.upTo would retry at 120 ms and take this lock.
      const { outcome } = yield* waitAgainst("110 millis");
      assert.ok(Result.isFailure(outcome) && outcome.failure._tag === "LockBusy");
    }),
  );

  it.effect("takes a lock released before the deadline on the next poll", () =>
    Effect.gen(function* () {
      const { outcome, at } = yield* waitAgainst("90 millis");
      assert.ok(Result.isSuccess(outcome));
      assert.equal(at, 100);
    }),
  );
});
