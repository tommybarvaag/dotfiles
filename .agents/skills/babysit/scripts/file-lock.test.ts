import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireLock, tryAcquireLock } from "./file-lock.ts";

const MODULE = fileURLToPath(new URL("./file-lock.ts", import.meta.url));

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "babysit-lock-")), "pr.json.lock");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The PID of a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("error", reject);
    child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
  });
}

describe("file locks", () => {
  it("admits exactly one of many concurrent acquirers in this process", async () => {
    const path = await lockPath();
    const attempts = await Promise.all(Array.from({ length: 20 }, () => tryAcquireLock(path)));
    assert.equal(attempts.filter((attempt) => attempt._tag === "ok").length, 1);
    assert.ok(attempts.every((attempt) => attempt._tag === "ok" || attempt.error._tag === "LockBusy"));
  });

  it("admits exactly one of several processes racing for the lock", async () => {
    const path = await lockPath();
    const script = `const { tryAcquireLock } = await import(${JSON.stringify(MODULE)});
      const lock = await tryAcquireLock(${JSON.stringify(path)});
      if (lock._tag === "ok") { await new Promise((r) => setTimeout(r, 300)); await lock.value.release(); }
      process.stdout.write(lock._tag);`;
    const outcomes = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve, reject) =>
            execFile(process.execPath, ["--input-type=module", "-e", script], (error, stdout) =>
              error === null ? resolve(stdout) : reject(error),
            ),
          ),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome === "ok").length, 1, outcomes.join(","));
  });

  it("writes the owner record before the lock becomes visible", async () => {
    const path = await lockPath();
    const lock = await tryAcquireLock(path);
    assert.equal(lock._tag, "ok");
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.token, lock._tag === "ok" ? lock.value.token : null);
  });

  it("releases only its own lock", async () => {
    const path = await lockPath();
    const mine = await tryAcquireLock(path);
    assert.equal(mine._tag, "ok");
    // Someone else's lock now sits at the path (e.g. after a reclamation).
    await writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else" }));
    if (mine._tag === "ok") await mine.value.release();
    assert.ok(await exists(path), "the other owner's lock survives");
  });

  it("reclaims a lock whose owner died, once, even with concurrent reclaimers", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "dead" }));
    const attempts = await Promise.all(Array.from({ length: 10 }, () => tryAcquireLock(path)));
    assert.equal(attempts.filter((attempt) => attempt._tag === "ok").length, 1);
    assert.ok(!(await exists(`${path}.reap`)), "the reaper lock is released");
  });

  it("fails closed on a reaper lock left by a crashed process, naming the file to remove", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "dead-owner" }));
    await writeFile(`${path}.reap`, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "dead-reaper" }));
    const attempts = await Promise.all(Array.from({ length: 5 }, () => tryAcquireLock(path)));
    for (const attempt of attempts) {
      assert.equal(attempt._tag === "err" ? attempt.error._tag : null, "LockNeedsRecovery");
      assert.match(attempt._tag === "err" ? attempt.error.message : "", new RegExp(`remove ${path}\\.reap`));
    }
    assert.ok(await exists(`${path}.reap`), "the orphaned reaper lock is left for the user");
    assert.ok(await exists(path), "the stale lock is not reclaimed behind the user's back");
  });

  it("reports a failed release and lets it be retried", async () => {
    const path = await lockPath();
    const lock = await tryAcquireLock(path);
    assert.equal(lock._tag, "ok");
    if (lock._tag !== "ok") return;
    await chmod(dirname(path), 0o500);
    const failed = await lock.value.release();
    await chmod(dirname(path), 0o700);
    assert.equal(failed._tag === "err" ? failed.error._tag : null, "LockFileError");
    assert.ok(await exists(path));
    assert.equal((await lock.value.release())._tag, "ok");
    assert.ok(!(await exists(path)));
  });

  it("keeps a release retryable when the owner record cannot be read or is malformed", async () => {
    const path = await lockPath();
    const lock = await tryAcquireLock(path);
    assert.equal(lock._tag, "ok");
    if (lock._tag !== "ok") return;
    await chmod(path, 0o000);
    const unreadable = await lock.value.release();
    await chmod(path, 0o600);
    assert.equal(unreadable._tag === "err" ? unreadable.error._tag : null, "LockFileError");
    assert.ok(await exists(path), "the lock is still there");

    const original = await readFile(path, "utf8");
    await writeFile(path, "not json");
    assert.equal((await lock.value.release())._tag, "err", "ownership cannot be verified");
    await writeFile(path, original);
    assert.equal((await lock.value.release())._tag, "ok");
    assert.ok(!(await exists(path)));
  });

  it("treats a lock from another host as busy, and a malformed one as needing recovery", async () => {
    const path = await lockPath();
    await writeFile(path, JSON.stringify({ pid: await deadPid(), host: "some-other-host", token: "remote" }));
    const remote = await tryAcquireLock(path);
    assert.equal(remote._tag === "err" ? remote.error._tag : null, "LockBusy");

    const garbled = await lockPath();
    await writeFile(garbled, "12345");
    const malformed = await tryAcquireLock(garbled);
    assert.equal(malformed._tag === "err" ? malformed.error._tag : null, "LockNeedsRecovery");
    assert.match(malformed._tag === "err" ? malformed.error.message : "", new RegExp(`remove ${garbled}$`));
  });

  it("shares one release between overlapping calls, so a replacement owner survives", async () => {
    const path = await lockPath();
    const first = await tryAcquireLock(path);
    assert.equal(first._tag, "ok");
    if (first._tag !== "ok") return;
    // Signal handler and normal cleanup release at the same time.
    const fromSignal = first.value.release();
    const fromCleanup = first.value.release();
    assert.equal(fromSignal, fromCleanup, "one in-flight attempt");
    assert.equal((await fromSignal)._tag, "ok");
    const replacement = await tryAcquireLock(path);
    assert.equal(replacement._tag, "ok");
    assert.equal((await fromCleanup)._tag, "ok");
    assert.equal((await first.value.release())._tag, "ok", "a later call is a no-op");
    const owner = JSON.parse(await readFile(path, "utf8"));
    assert.equal(owner.token, replacement._tag === "ok" ? replacement.value.token : null, "the replacement lock is intact");
  });

  it("waits for a held lock and takes it once released", async () => {
    const path = await lockPath();
    const first = await tryAcquireLock(path);
    assert.equal(first._tag, "ok");
    setTimeout(() => void (first._tag === "ok" ? first.value.release() : undefined), 150);
    const second = await acquireLock(path, { timeoutMs: 5_000, pollMs: 20 });
    assert.equal(second._tag, "ok");
    const timedOut = await acquireLock(path, { timeoutMs: 100, pollMs: 20 });
    assert.equal(timedOut._tag === "err" ? timedOut.error._tag : null, "LockBusy");
  });
});
