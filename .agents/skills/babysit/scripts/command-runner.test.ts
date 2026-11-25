/**
 * The live runner against real local child processes (Node itself), never a forge CLI.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { CommandRunner, defaultLimits, type Argv, type RunnerLimits } from "./command-runner.ts";

const limits: RunnerLimits = { timeout: "1 minute", forceKillAfter: "300 millis", maxOutputBytes: 1024 };

const runner = (overrides: Partial<RunnerLimits> = {}) =>
  CommandRunner.layerWith({ ...limits, ...overrides }).pipe(Layer.provide(NodeServices.layer));

/** A Node child running `script`; extra arguments land in `process.argv[1..]`. */
const node = (script: string, ...args: ReadonlyArray<string>): Argv => [process.execPath, "-e", script, ...args];

const run = (argv: Argv, overrides: Partial<RunnerLimits> = {}) =>
  CommandRunner.use((commands) => commands.run(argv)).pipe(Effect.provide(runner(overrides)));

/** Real-time polling for a file a child writes, independent of the test clock. */
const fileAppears = (path: string) =>
  Effect.promise(async () => {
    for (;;) {
      const present = await access(path).then(
        () => true,
        () => false,
      );
      if (present) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

const scratch = () => Effect.promise(() => mkdtemp(join(tmpdir(), "babysit-runner-")));

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A child that ignores SIGTERM, writes a diagnostic and its PID file, then hangs. */
const STUBBORN = `process.on("SIGTERM", () => {});
  process.stderr.write("still here");
  require("node:fs").writeFileSync(process.argv[1], String(process.pid));
  setInterval(() => {}, 1000);`;

describe("live command runner", () => {
  it("keeps the old execFile bound of 64 MiB per stream by default", () => {
    assert.equal(defaultLimits.maxOutputBytes, 64 * 1024 * 1024);
    assert.ok(Duration.toMillis(defaultLimits.forceKillAfter) > 0, "timeouts and interrupts escalate to SIGKILL");
  });

  it.live("returns stdout and fails a non-zero exit with its stderr", () =>
    Effect.gen(function* () {
      assert.equal(yield* run(node(`process.stdout.write("hello")`)), "hello");
      const failed = yield* Effect.flip(run(node(`process.stderr.write("bad input"); process.exit(3)`)));
      assert.deepEqual([failed.reason, failed.stderr, failed.detail], ["exit", "bad input", null]);
    }),
  );

  it.live("fails oversized stdout with output_limit and kills the child", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(run(node(`process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000)`)));
      assert.equal(failed.reason, "output_limit");
      assert.equal(failed.detail, "stdout exceeded 1024 bytes");
    }),
  );

  it.live("fails oversized stderr with output_limit, keeping stderr within the bound", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        run(node(`process.stderr.write("y".repeat(1000)); setTimeout(() => process.stderr.write("z".repeat(4096)), 50); setInterval(() => {}, 1000)`)),
      );
      assert.equal(failed.reason, "output_limit");
      assert.equal(failed.detail, "stderr exceeded 1024 bytes");
      assert.equal(failed.stderr, "y".repeat(1000), "what fit in the bound is kept");
    }),
  );

  it.live("counts raw bytes before decoding, so multi-byte text cannot slip past the bound", () =>
    Effect.gen(function* () {
      // 400 three-byte characters: 1200 bytes, but only 400 UTF-16 code units.
      const failed = yield* Effect.flip(run(node(`process.stdout.write("€".repeat(400))`)));
      assert.equal(failed.reason, "output_limit");
    }),
  );

  it.live("keeps stderr when the child dies from a signal, with the platform context apart", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(
        run(node(`process.stderr.write("diagnostic before the signal"); setTimeout(() => process.kill(process.pid, "SIGTERM"), 50)`)),
      );
      assert.equal(failed.reason, "exit");
      assert.equal(failed.stderr, "diagnostic before the signal");
      assert.ok(failed.detail !== null && !failed.detail.includes(process.execPath), "the context omits the command line");
      assert.match(failed.message, /diagnostic before the signal/);
    }),
  );

  it.effect("keeps stderr written before a timeout", () =>
    Effect.gen(function* () {
      const marker = join(yield* scratch(), "pid");
      const pending = yield* Effect.forkChild(Effect.flip(run(node(STUBBORN, marker))));
      yield* fileAppears(marker);
      // The diagnostic was written before the marker; give the pipe a moment to deliver it.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
      yield* TestClock.adjust("1 minute");
      const failed = yield* Fiber.join(pending);
      assert.deepEqual([failed.reason, failed.stderr], ["timeout", "still here"]);
      assert.ok(!isAlive(Number(yield* Effect.promise(() => readFile(marker, "utf8")))), "the child was killed");
    }),
  );

  it.live("kills a child that ignores SIGTERM when the run is interrupted", () =>
    Effect.gen(function* () {
      const marker = join(yield* scratch(), "pid");
      const pending = yield* Effect.forkChild(run(node(STUBBORN, marker)));
      yield* fileAppears(marker);
      const pid = Number(yield* Effect.promise(() => readFile(marker, "utf8")));
      const started = Date.now();
      yield* Fiber.interrupt(pending);
      assert.ok(Date.now() - started < 3000, "interruption escalated to SIGKILL instead of waiting forever");
      assert.ok(!isAlive(pid), "the child is gone");
    }),
  );

  it.live("times out a child that ignores SIGTERM", () =>
    Effect.gen(function* () {
      const marker = join(yield* scratch(), "pid");
      const failed = yield* Effect.flip(run(node(STUBBORN, marker), { timeout: "300 millis" }));
      assert.equal(failed.reason, "timeout");
      assert.ok(!isAlive(Number(yield* Effect.promise(() => readFile(marker, "utf8")))));
    }),
  );

  it.live("reports a missing program", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(run(["babysit-no-such-program"]));
      assert.equal(failed.reason, "missing");
      assert.equal(failed.message, "babysit-no-such-program is not installed or not on PATH");
    }),
  );
});
