/**
 * Tests for the progress renderer, driven through its real seam.
 *
 * A substitute `Terminal` records what would have been written and a
 * substitute `Stdio` decides whether the run looks interactive, so the TTY and
 * non-TTY branches are both exercised without needing a pty.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Stdio, Terminal } from "effect";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DiskInventoryLive } from "../src/adapters/bun-disk.ts";
import { ScanProgressLive } from "../src/adapters/terminal-progress.ts";
import * as Cutoff from "../src/domain/cutoff.ts";
import { ScanProgress } from "../src/ports.ts";
import * as Reclaim from "../src/reclaim.ts";
import { createRepository, createTempTree, createTurboCache, removeTempTree } from "./temp-tree.ts";

/** Width used by the substitute terminal, chosen to force truncation. */
const COLUMNS = 40;

/** Wide enough that no frame of a real scan is truncated. */
const WIDE = 400;

/**
 * Build the layers the renderer needs, capturing every write.
 *
 * @param stdoutIsTerminal - Whether the run should look interactive.
 * @param columns - The width the substitute terminal reports.
 * @returns The layer plus the array that accumulates writes.
 */
function harness(stdoutIsTerminal: boolean, columns = COLUMNS) {
  const written: Array<string> = [];

  const terminal = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(columns),
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
    yield* progress.scanning("build caches", ["/src"]);
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

describe("ScanProgressLive over a real scan", () => {
  test("counts accumulate across every root of one search", async () => {
    const tree = await createTempTree();

    try {
      // Matches in the first root only. Restarting the count at each root is
      // what made a default run report "0 found, 1 measured".
      const repository = await createRepository(tree, "app");
      await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);
      const empty = join(tree.root, "empty");
      await mkdir(empty);

      const { written, layer } = harness(true, WIDE);
      const options: Reclaim.SurveyOptions = {
        sourceRoots: [tree.sourceRoot, empty],
        worktreeRoot: tree.worktreeRoot,
        tempRoots: { _tag: "Given", roots: [tree.tempRoot] },
        selection: "turbo-only",
        policy: {
          caches: { _tag: "Delete" },
          vitestTempStaleBefore: Cutoff.hoursBefore(
            new Date(),
            Option.getOrThrow(Cutoff.parseAgeInHours(1)),
          ),
        },
      };

      await Effect.runPromise(
        Reclaim.survey(options).pipe(Effect.provide(Layer.provide(DiskInventoryLive, layer))),
      );

      const measured = written.filter((frame) => frame.includes("measured"));

      expect(measured).toHaveLength(1);
      expect(measured[0]).toContain("build caches: 1 found, 1 measured");
    } finally {
      await removeTempTree(tree);
    }
  });
});
