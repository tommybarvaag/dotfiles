/**
 * The command line boundary, exercised by running the real entrypoint.
 *
 * These are the assertions no unit test can make: what a user sees on stdout,
 * what they see on stderr, and what the shell sees as an exit code. Every case
 * here is one an earlier version answered with a stack trace headed by an empty
 * message line, or with a success it had not earned.
 *
 * The binary is spawned rather than imported, so stdin really is not a terminal
 * and the runtime's own error reporting really is in play.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createRepository,
  createTempTree,
  createTurboCache,
  removeTempTree,
  type TempTree,
} from "./temp-tree.ts";

/** The entrypoint `~/.local/bin/reclaim-disk` is a symlink to. */
const ENTRYPOINT = join(import.meta.dir, "..", "src", "main.ts");

/** What one run of the command produced. */
type Run = {
  /** The report, and anything else written to standard output. */
  readonly stdout: string;
  /** Failures, which the command keeps off stdout so a pipe holds the report alone. */
  readonly stderr: string;
  /** What the shell sees. */
  readonly exitCode: number;
};

let tree: TempTree;

beforeEach(async () => {
  tree = await createTempTree();
});

afterEach(async () => {
  await removeTempTree(tree);
});

/**
 * Run the command with stdin closed, as a cron job or a pipeline would.
 *
 * @param args - The flags, after the two scan roots this tree supplies.
 * @returns What the run produced.
 */
async function reclaimDisk(args: ReadonlyArray<string>): Promise<Run> {
  // Spawned directly rather than through `bun run`, so every case here depends
  // on the shebang and the executable bit the installed symlink relies on.
  // Losing the mode bit fails these tests instead of only the installed command.
  const proc = Bun.spawn([ENTRYPOINT, ...args], {
    stdin: new Uint8Array(0),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe("reclaim-disk", () => {
  test("a scan root that was never created reports the other category instead of dying", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);

    // What a fresh machine looks like: the agent tooling has never run, so the
    // defaulted worktree root does not exist. The caches were already found and
    // measured, and used to be thrown away with the scan that failed.
    const run = await reclaimDisk([
      "--source-root",
      tree.sourceRoot,
      "--worktree-root",
      join(tree.root, "never-created"),
    ]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(cache);
    expect(run.stderr).toBe("");
  });

  test("a scan root that exists and cannot be read stops the run with one line", async () => {
    const locked = join(tree.root, "locked");
    await mkdir(locked);

    try {
      await chmod(locked, 0o000);

      const run = await reclaimDisk(["--only", "turbo", "--source-root", locked]);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`error: could not scan ${locked} looking for build caches`);

      // One sentence, not a cause block: the fields the error carries reach the
      // first line, and the runtime does not print a second copy underneath.
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  test("--apply with nobody to ask refuses and tells the shell", async () => {
    const repository = await createRepository(tree, "app");
    await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);

    const run = await reclaimDisk(["--only", "turbo", "--source-root", tree.sourceRoot, "--apply"]);

    // Zero of the targets went, and nobody chose that - so a scheduled run
    // must not read this as success.
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing to delete without confirmation");
  });

  test("a target left half-removed is not reported as one that was left alone", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);
    await chmod(join(repository, ".turbo"), 0o555);

    const run = await reclaimDisk([
      "--only",
      "turbo",
      "--source-root",
      tree.sourceRoot,
      "--apply",
      "--yes",
    ]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain(`partially removed: ${cache}`);
    expect(run.stdout).not.toContain(`refused: ${cache}`);
  });
});
