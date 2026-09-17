/**
 * The macOS + Bun implementation of the inventory and mutator ports.
 *
 * All process mechanics live here: `du`, `df`, `find`, `git`, and `tar` are
 * invoked directly rather than through a shell, so no path needs quoting and a
 * directory named with a space or a quote cannot change what runs. Raw exit
 * codes and stderr are translated into the tool's typed errors and never
 * escape this module.
 */
import { Effect, Layer } from "effect";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as Kilobytes from "../domain/kilobytes.ts";
import { classify, type WorktreeState } from "../domain/worktree.ts";
import {
  ArchiveFailed,
  messageOf,
  PruneFailed,
  RemoveFailed,
  ScanFailed,
  SizeUnavailable,
  WorktreeStatusUnavailable,
} from "../errors.ts";
import { type AgeInDays, DiskInventory, DiskMutator, ScanProgress } from "../ports.ts";

/** The volume holding user data on modern macOS. */
const DATA_VOLUME = "/System/Volumes/Data";

/** Where archives of untracked files are written. */
const ARCHIVE_DIR = join(homedir(), ".reclaim-disk-archives");

/** What a finished subprocess produced. */
type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/**
 * Run a command to completion and capture its output.
 *
 * Rejection is impossible for the caller to observe: a spawn failure is
 * reported as a non-zero exit with the thrown message as stderr, so every
 * caller classifies failure the same way.
 *
 * @param argv - The executable and its arguments.
 * @returns The captured output and exit code.
 */
async function run(argv: ReadonlyArray<string>): Promise<ProcessResult> {
  try {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  } catch (cause) {
    return { stdout: "", stderr: messageOf(cause), exitCode: -1 };
  }
}

/**
 * Split command output into non-empty trimmed lines.
 *
 * @param stdout - The raw output.
 * @returns The meaningful lines.
 */
function lines(stdout: string): ReadonlyArray<string> {
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Render a cutoff date for `find -newermt`.
 *
 * @param days - How many days before now the cutoff falls.
 * @returns The cutoff as `YYYY-MM-DD`.
 */
function cutoffDate(days: AgeInDays): string {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return cutoff.toISOString().slice(0, 10);
}

/**
 * Sum the leading size column of `du -sk` output.
 *
 * @param stdout - The raw `du` output.
 * @returns The combined size.
 */
function sumDuOutput(stdout: string): Effect.Effect<Kilobytes.Kilobytes, Kilobytes.InvalidKilobytes> {
  return Effect.map(
    Effect.forEach(lines(stdout), (line) => {
      const [field] = line.split(/\s+/);

      return Kilobytes.parseField(field ?? "");
    }),
    Kilobytes.sum,
  );
}

/**
 * Directory names never descended into.
 *
 * A dependency tree holds hundreds of thousands of directories and no build
 * cache this tool owns, so walking it dominated the scan while contributing
 * nothing. Exported so the exclusion is reviewable rather than buried.
 *
 * The trade-off: a vendored package shipping a populated `.turbo/cache` would
 * now be missed. That has not been observed, and the cost of looking is the
 * whole latency problem.
 */
export const PRUNED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** Depth limit meaning "no limit". */
const UNBOUNDED_DEPTH = Number.MAX_SAFE_INTEGER;

/** How many sibling directories to descend into at once. */
const WALK_CONCURRENCY = 16;

/** The directory Turbo writes its cache under. */
const TURBO_DIRECTORY = ".turbo";

/** Agent worktrees sit one level under a per-repository grouping. */
const WORKTREE_DEPTH = 2;

/** How deep a repository's `.git` may sit beneath the source root. */
const REPOSITORY_MAX_DEPTH = 3;

/**
 * List every directory at exactly one depth beneath a root.
 *
 * Used for agent worktrees, which are always nested exactly one level under a
 * per-repository grouping directory. Matching on position rather than name is
 * what distinguishes this from `walk`.
 *
 * @param root - The directory to search.
 * @param depth - The exact depth to collect, counting root's children as 1.
 * @returns The directories at that depth.
 */
function listAtDepth(root: string, depth: number): Effect.Effect<ReadonlyArray<string>, ScanFailed> {
  const expand = (
    directories: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>> =>
    Effect.map(
      Effect.forEach(
        directories,
        (directory) =>
          Effect.map(readChildDirectories(directory), (children) =>
            children.map((child) => join(directory, child)),
          ),
        { concurrency: WALK_CONCURRENCY },
      ),
      (nested) => nested.flat(),
    );

  return Effect.flatMap(
    Effect.tryPromise({
      try: () => readdir(root),
      catch: (cause) =>
        new ScanFailed({ root, looking_for: `directories at depth ${depth}`, cause: messageOf(cause) }),
    }),
    () => {
      let level: Effect.Effect<ReadonlyArray<string>> = Effect.succeed([root]);

      for (let remaining = depth; remaining > 0; remaining -= 1) {
        level = Effect.flatMap(level, expand);
      }

      return level;
    },
  );
}

/**
 * Walk a tree in process, reporting each match the instant it is found.
 *
 * Replaces a spawned `find`. The subprocess was not merely slower: its output
 * was read with a single await on the whole stream, so matches it had already
 * printed could not be shown until it exited. Walking in process removes the
 * pipe, which is what makes incremental reporting possible at all.
 *
 * Semantics deliberately match `find(1)` as it was invoked before:
 * - a matched directory is not descended into, as `-prune` did;
 * - symlinks are not followed, as the absence of `-L` did, so no cycle guard
 *   is needed;
 * - an unreadable subdirectory is skipped rather than failing the scan, since
 *   an unprivileged sweep of a home directory always hits some.
 *
 * An unreadable *root* is still a failure: it means the caller was asked to
 * scan somewhere that does not exist.
 *
 * @param root - The directory to search.
 * @param name - The directory name to match.
 * @param maxDepth - Deepest level a match may be found at, counting root's children as 1.
 * @param onFound - Called with each match as it is discovered.
 * @returns Every matching path.
 */
function walk(
  root: string,
  name: string,
  maxDepth: number,
  onFound: (path: string) => Effect.Effect<void>,
): Effect.Effect<ReadonlyArray<string>, ScanFailed> {
  const found: Array<string> = [];

  const descend = (directory: string, depth: number): Effect.Effect<void> =>
    Effect.flatMap(readChildDirectories(directory), (children) =>
      Effect.forEach(
        children,
        (child) => {
          const childDepth = depth + 1;
          const path = join(directory, child);

          if (child === name) {
            if (childDepth > maxDepth) {
              return Effect.void;
            }

            found.push(path);

            return onFound(path);
          }

          if (childDepth >= maxDepth || PRUNED_DIRECTORIES.has(child)) {
            return Effect.void;
          }

          return descend(path, childDepth);
        },
        { concurrency: WALK_CONCURRENCY, discard: true },
      ),
    );

  return Effect.as(
    Effect.flatMap(
      Effect.tryPromise({
        try: () => readdir(root),
        catch: (cause) =>
          new ScanFailed({ root, looking_for: name, cause: messageOf(cause) }),
      }),
      () => descend(root, 0),
    ),
    found,
  );
}

/**
 * List a directory's immediate subdirectories, treating an unreadable
 * directory as empty.
 *
 * `readdir` with file types reports a symlink as a link rather than a
 * directory, so filtering on `isDirectory` also excludes symlinks.
 *
 * @param directory - The directory to list.
 * @returns The subdirectory names, or none when the directory cannot be read.
 */
function readChildDirectories(directory: string): Effect.Effect<ReadonlyArray<string>> {
  return Effect.promise(() =>
    readdir(directory, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      () => [],
    ),
  );
}

/**
 * The live, read-only view of this machine.
 *
 * Progress is emitted from here rather than from the application service
 * because this is where the waiting happens. `survey` keeps its exact
 * requirements, so the guarantee that a dry run cannot delete is untouched.
 */
export const DiskInventoryLive = Layer.effect(
  DiskInventory,
  Effect.gen(function* () {
    const progress = yield* ScanProgress;

    return DiskInventory.of({
  findTurboCaches: (root) =>
    Effect.flatMap(
      Effect.flatMap(progress.scanning("build caches", root), () =>
        walk(root, TURBO_DIRECTORY, UNBOUNDED_DEPTH, progress.found),
      ),
      (
      turboDirs,
    ) =>
      Effect.map(
        Effect.forEach(
          turboDirs,
          (dir) => {
            const cache = join(dir, "cache");

            return Effect.map(
              Effect.promise(() =>
                stat(cache).then(
                  (info) => info.isDirectory(),
                  () => false,
                ),
              ),
              (exists) => (exists ? [cache] : []),
            );
          },
          { concurrency: 16 },
        ),
        (nested) => nested.flat(),
      ),
    ),

  findWorktrees: (root) =>
    Effect.flatMap(progress.scanning("agent worktrees", root), () =>
      Effect.tap(listAtDepth(root, WORKTREE_DEPTH), (worktrees) =>
        Effect.forEach(worktrees, progress.found, { discard: true }),
      ),
    ),

  findRepositories: (root) =>
    Effect.map(walk(root, ".git", REPOSITORY_MAX_DEPTH, () => Effect.void), (gitDirs) =>
      gitDirs.map((dir) => dirname(dir)),
    ),

  sizeOf: (path) =>
    Effect.tap(
      Effect.flatMap(
      Effect.promise(() => run(["du", "-sk", path])),
      (result) =>
        sumDuOutput(result.stdout).pipe(
          Effect.mapError(
            () =>
              new SizeUnavailable({
                path,
                cause: result.stderr.trim() === "" ? "unreadable du output" : result.stderr.trim(),
              }),
          ),
        ),
      ),
      () => progress.measured(path),
    ),

  sizeOfStaleEntries: (path, olderThan) =>
    Effect.flatMap(
      Effect.promise(() =>
        run([
          "find",
          path,
          "-maxdepth",
          "1",
          "-mindepth",
          "1",
          "-not",
          "-newermt",
          cutoffDate(olderThan),
          "-exec",
          "du",
          "-sk",
          "{}",
          "+",
        ]),
      ),
      (result) =>
        // No stale entries means no output, which sums to zero rather than failing.
        result.stdout.trim() === ""
          ? Effect.succeed(Kilobytes.zero)
          : sumDuOutput(result.stdout).pipe(
              Effect.mapError(
                () =>
                  new SizeUnavailable({
                    path,
                    cause:
                      result.stderr.trim() === "" ? "unreadable du output" : result.stderr.trim(),
                  }),
              ),
            ),
    ),

  worktreeState: (path) =>
    Effect.flatMap(
      Effect.promise(() => run(["git", "-C", path, "status", "--porcelain"])),
      (result): Effect.Effect<WorktreeState, WorktreeStatusUnavailable> =>
        result.exitCode === 0
          ? Effect.succeed(classify(result.stdout.split("\n")))
          : Effect.fail(
              new WorktreeStatusUnavailable({
                path,
                cause: result.stderr.trim() === "" ? `git exited ${result.exitCode}` : result.stderr.trim(),
              }),
            ),
    ),

  freeSpace: Effect.flatMap(
    Effect.promise(() => run(["df", "-k", DATA_VOLUME])),
    (result) => {
      const [, dataRow] = lines(result.stdout);
      const available = dataRow?.split(/\s+/)[3];

      if (available === undefined) {
        return Effect.fail(
          new SizeUnavailable({ path: DATA_VOLUME, cause: "unreadable df output" }),
        );
      }

      return Kilobytes.parseField(available).pipe(
        Effect.mapError(() => new SizeUnavailable({ path: DATA_VOLUME, cause: "unreadable df output" })),
      );
    },
  ),
    });
  }),
);

/** The live, mutating view of this machine. */
export const DiskMutatorLive = Layer.succeed(DiskMutator, {
  archiveUntracked: (worktree, files) =>
    Effect.gen(function* () {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const label = worktree.replace(/^\/+/, "").replaceAll("/", "_");
      const destination = join(ARCHIVE_DIR, `${label}-${stamp}.tar.gz`);

      yield* Effect.tryPromise({
        try: () => mkdir(ARCHIVE_DIR, { recursive: true }),
        catch: (cause) =>
          new ArchiveFailed({ path: worktree, destination, cause: messageOf(cause) }),
      });

      const result = yield* Effect.promise(() =>
        run(["tar", "-czf", destination, "-C", worktree, "--", ...files]),
      );

      if (result.exitCode !== 0) {
        return yield* Effect.fail(
          new ArchiveFailed({
            path: worktree,
            destination,
            cause: result.stderr.trim() === "" ? `tar exited ${result.exitCode}` : result.stderr.trim(),
          }),
        );
      }

      // An archive that exists but holds nothing would let the caller delete the
      // only copy of these files, so treat it as a failure.
      const written = yield* Effect.tryPromise({
        try: () => stat(destination),
        catch: (cause) =>
          new ArchiveFailed({ path: worktree, destination, cause: messageOf(cause) }),
      });

      if (written.size === 0) {
        return yield* Effect.fail(
          new ArchiveFailed({ path: worktree, destination, cause: "archive is empty" }),
        );
      }

      return destination;
    }),

  remove: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) => new RemoveFailed({ path, cause: messageOf(cause) }),
    }),

  removeStaleEntries: (path, olderThan) =>
    Effect.flatMap(
      Effect.promise(() =>
        run([
          "find",
          path,
          "-maxdepth",
          "1",
          "-mindepth",
          "1",
          "-not",
          "-newermt",
          cutoffDate(olderThan),
          "-exec",
          "rm",
          "-rf",
          "{}",
          "+",
        ]),
      ),
      (result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new RemoveFailed({
                path,
                cause: result.stderr.trim() === "" ? `find exited ${result.exitCode}` : result.stderr.trim(),
              }),
            ),
    ),

  pruneWorktreeRegistrations: (repository) =>
    Effect.flatMap(
      Effect.promise(() => run(["git", "-C", repository, "worktree", "prune"])),
      (result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(
              new PruneFailed({
                repository,
                cause: result.stderr.trim() === "" ? `git exited ${result.exitCode}` : result.stderr.trim(),
              }),
            ),
    ),
});

/** Both live ports, for the composition root. */
export const BunDiskLive = Layer.mergeAll(DiskInventoryLive, DiskMutatorLive);
