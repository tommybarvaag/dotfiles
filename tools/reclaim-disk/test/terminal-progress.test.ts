/**
 * Tests for the progress renderer, driven through its real seam.
 *
 * A substitute `Terminal` records what would have been written and a
 * substitute `Stdio` decides whether the run looks interactive, so the TTY and
 * non-TTY branches are both exercised without needing a pty.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Stdio, Terminal } from "effect";
import { ScanProgressLive } from "../src/adapters/terminal-progress.ts";
import { ScanProgress } from "../src/ports.ts";

/** Width used by the substitute terminal, chosen to force truncation. */
const COLUMNS = 40;

/**
 * Build the layers the renderer needs, capturing every write.
 *
 * @param stdoutIsTerminal - Whether the run should look interactive.
 * @returns The layer plus the array that accumulates writes.
 */
function harness(stdoutIsTerminal: boolean) {
  const written: Array<string> = [];

  const terminal = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(COLUMNS),
      rows: Effect.succeed(24),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: (text) =>
        Effect.sync(() => {
          written.push(text);
        }),
    }),
  );

  const stdio = Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(stdoutIsTerminal),
    stdoutIsTerminal: Effect.succeed(stdoutIsTerminal),
  });

  return { written, layer: Layer.provide(ScanProgressLive, Layer.merge(terminal, stdio)) };
}

/** Drive a short scan against the renderer. */
function runScan(stdoutIsTerminal: boolean): Promise<ReadonlyArray<string>> {
  const { written, layer } = harness(stdoutIsTerminal);

  const program = Effect.gen(function* () {
    const progress = yield* ScanProgress;
    yield* progress.scanning("build caches", "/src");
    yield* progress.found("/src/a/.turbo/cache");
    yield* progress.found("/src/b/.turbo/cache");
    yield* progress.measured("/src/a/.turbo/cache");
    yield* progress.done;
  });

  return Effect.runPromise(program.pipe(Effect.provide(layer))).then(() => written);
}

describe("ScanProgressLive", () => {
  test("writes nothing at all when stdout is not a terminal", async () => {
    expect(await runScan(false)).toEqual([]);
  });

  test("repaints one line per event on a terminal", async () => {
    const written = await runScan(true);

    // scanning + 2 found + 1 measured + done
    expect(written).toHaveLength(5);
  });

  test("every frame clears the line first, so frames cannot accumulate", async () => {
    const written = await runScan(true);

    for (const frame of written) {
      expect(frame.startsWith("\r[2K")).toBe(true);
    }
  });

  test("frames never exceed the terminal width, so nothing wraps", async () => {
    const written = await runScan(true);

    for (const frame of written) {
      const visible = frame.replace("\r[2K", "");

      expect(visible.length).toBeLessThan(COLUMNS);
    }
  });

  test("counts advance as events arrive", async () => {
    const written = await runScan(true);
    const visible = written.map((frame) => frame.replace("\r[2K", ""));

    expect(visible[1]).toContain("1 found");
    expect(visible[2]).toContain("2 found");
    expect(visible[3]).toContain("1 measured");
  });

  test("the final frame leaves the line empty", async () => {
    const written = await runScan(true);

    expect(written.at(-1)).toBe("\r[2K");
  });
});
