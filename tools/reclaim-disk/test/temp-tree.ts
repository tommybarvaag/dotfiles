/**
 * Fixtures for the tests that exercise the destructive path.
 *
 * Everything here is real: real temporary directories, real git repositories
 * with real commits and real worktrees, real `tar` archives read back with
 * `tar`. Nothing is mocked, because the properties worth asserting - a failed
 * archive leaves the worktree intact, a dirty worktree is never removed - are
 * properties of the commands that actually run.
 */
import { type Clock, Effect } from "effect";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

/** Size of every fixture blob, large enough that `du -sk` reports whole kilobytes. */
const BLOB_KB = 256;

/** Milliseconds in a day, for backdating cache entries. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * Environment for the fixture's own git commands.
 *
 * The user's git configuration is kept out of it, so a fixture commit cannot
 * depend on their identity, hooks, or signing setup - and cannot touch them.
 * The commands the tool itself runs are left with the ambient environment,
 * since reading a status under the user's config is what it does in the wild.
 */
const FIXTURE_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "reclaim-disk tests",
  GIT_AUTHOR_EMAIL: "tests@example.invalid",
  GIT_COMMITTER_NAME: "reclaim-disk tests",
  GIT_COMMITTER_EMAIL: "tests@example.invalid",
};

/** A throwaway machine for one test. */
export type TempTree = {
  /** Holds everything below; removing it removes the whole fixture. */
  readonly root: string;
  /** The root the cache and repository scans are pointed at. */
  readonly sourceRoot: string;
  /** The root the worktree scan is pointed at. */
  readonly worktreeRoot: string;
  /** The directory the mutator under test writes archives into. */
  readonly archiveRoot: string;
};

/**
 * Run a command to completion, throwing when it fails.
 *
 * Fixture setup is not the thing under test: a failure here means the test
 * itself is broken, which is the one case where throwing is the right answer.
 *
 * @param command - The executable to run.
 * @param args - Its arguments, as an argv array and never through a shell.
 * @returns The command's stdout.
 * @throws When the command cannot be run or exits non-zero.
 */
export async function runOrThrow(command: string, args: ReadonlyArray<string>): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: FIXTURE_ENV,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`fixture: ${command} ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
  }

  return stdout;
}

/**
 * Create an empty tree with both scan roots.
 *
 * @returns The tree's directories. The archive root is deliberately absent
 * until something writes to it, which is what the live mutator does too.
 */
export async function createTempTree(): Promise<TempTree> {
  // Resolved, because git reports absolute paths with the symlinks taken out
  // (`/var/folders/...` is `/private/var/folders/...`), and a test comparing a
  // repository git named against one the fixture built would otherwise fail on
  // a difference that is not a difference.
  const root = await realpath(await mkdtemp(join(tmpdir(), "reclaim-disk-apply-")));
  const tree: TempTree = {
    root,
    sourceRoot: join(root, "src"),
    worktreeRoot: join(root, "worktrees"),
    archiveRoot: join(root, "archives"),
  };

  await Promise.all([mkdir(tree.sourceRoot), mkdir(tree.worktreeRoot)]);

  return tree;
}

/**
 * Remove a tree, including anything a test made unreadable.
 *
 * @param tree - The tree to delete.
 */
export async function removeTempTree(tree: TempTree): Promise<void> {
  // A test that proves an unreadable directory is reported leaves one behind,
  // and `rm` cannot descend into it either.
  await runOrThrow("chmod", ["-R", "u+rwX", tree.root]);
  await rm(tree.root, { recursive: true, force: true });
}

/**
 * Write a blob big enough for `du -sk` to report a non-zero size.
 *
 * Targets that measure zero are dropped from the plan, so a fixture that holds
 * nothing would be reported as nothing.
 *
 * @param path - The file to write.
 * @param byte - The byte to fill it with, so an edit to a committed blob is a real difference.
 */
export async function writeBlob(path: string, byte: number): Promise<void> {
  await writeFile(path, Buffer.alloc(BLOB_KB * 1024, byte));
}

/**
 * Whether a path is still on disk.
 *
 * @param path - The path to look for.
 * @returns `true` when it exists.
 */
export function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Create a git repository holding one committed blob.
 *
 * @param tree - The tree to create it in.
 * @param name - The repository's directory name under the source root.
 * @returns The repository's absolute path.
 */
export async function createRepository(tree: TempTree, name: string): Promise<string> {
  const repository = join(tree.sourceRoot, name);
  await mkdir(repository, { recursive: true });

  await runOrThrow("git", ["-C", repository, "init", "-q", "-b", "main"]);
  await writeBlob(join(repository, "blob.bin"), 0);
  await runOrThrow("git", ["-C", repository, "add", "-A"]);
  await runOrThrow("git", ["-C", repository, "commit", "-q", "-m", "initial"]);

  return repository;
}

/**
 * Commit a `.gitignore` into a repository.
 *
 * Worktrees branch from `HEAD`, so this has to land before the worktree is
 * added for the worktree to inherit the rules.
 *
 * @param repository - The repository to add the rules to.
 * @param patterns - The ignore patterns, one per line.
 */
export async function ignorePaths(
  repository: string,
  patterns: ReadonlyArray<string>,
): Promise<void> {
  await writeFile(join(repository, ".gitignore"), `${patterns.join("\n")}\n`);
  await runOrThrow("git", ["-C", repository, "add", "-A"]);
  await runOrThrow("git", ["-C", repository, "commit", "-q", "-m", "ignore rules"]);
}

/**
 * Clone a repository into a directory of its own.
 *
 * A clone is a checkout that `git status` calls clean, but its object database
 * lives inside it - so it is the shape that proves depth alone cannot tell a
 * linked worktree from something that merely sits where one would.
 *
 * @param repository - The repository to clone.
 * @param destination - Where the clone is created.
 * @returns The clone's absolute path.
 */
export async function cloneRepository(repository: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  await runOrThrow("git", ["clone", "-q", repository, destination]);

  return destination;
}

/**
 * Make a directory the root of a repository enclosing everything beneath it.
 *
 * `git -C` searches upward, so this is what a worktree root placed inside a
 * dotfiles checkout or a monorepo looks like from the tool's point of view.
 *
 * @param directory - The directory to turn into a repository.
 */
export async function encloseInRepository(directory: string): Promise<void> {
  await runOrThrow("git", ["-C", directory, "init", "-q", "-b", "main"]);
}

/**
 * Commit everything a worktree currently holds, leaving it clean but larger.
 *
 * Plan entries are ordered largest first, so this is how a test decides which
 * entry a run reaches before the others.
 *
 * @param worktree - The worktree to commit in.
 */
export async function commitWorktree(worktree: string): Promise<void> {
  await runOrThrow("git", ["-C", worktree, "add", "-A"]);
  await runOrThrow("git", ["-C", worktree, "commit", "-q", "-m", "bulk"]);
}

/** One entry in a fixture turbo cache. */
export type CacheEntry = {
  /** The entry's directory name. */
  readonly name: string;
  /** How long ago it was last modified. */
  readonly ageInDays: number;
};

/**
 * Populate a repository's turbo cache.
 *
 * @param repository - The repository the cache belongs to.
 * @param entries - The entries to create, each backdated to its age.
 * @returns The cache directory's absolute path.
 */
export async function createTurboCache(
  repository: string,
  entries: ReadonlyArray<CacheEntry>,
): Promise<string> {
  const cache = join(repository, ".turbo", "cache");

  await Promise.all(
    entries.map(async (entry) => {
      const directory = join(cache, entry.name);
      await mkdir(directory, { recursive: true });
      await writeBlob(join(directory, "artifact.bin"), 0);

      // Backdated last, because writing the blob touches the directory too.
      const when = new Date(Date.now() - entry.ageInDays * DAY);
      await utimes(directory, when, when);
    }),
  );

  return cache;
}

/**
 * Add a real git worktree beneath the worktree root.
 *
 * Agent worktrees sit one level under a per-repository grouping, which is the
 * shape the scan looks for, so the group directory is part of the fixture.
 *
 * @param tree - The tree holding the worktree root.
 * @param repository - The repository to branch from.
 * @param group - The per-repository grouping directory.
 * @param name - The worktree's directory name, also used as its branch.
 * @returns The worktree's absolute path.
 */
export async function addWorktree(
  tree: TempTree,
  repository: string,
  group: string,
  name: string,
): Promise<string> {
  const path = join(tree.worktreeRoot, group, name);
  await runOrThrow("git", ["-C", repository, "worktree", "add", "-q", "-b", name, path]);

  return path;
}

/**
 * Leave a repository holding a registration for a worktree that is gone.
 *
 * This is what `git worktree prune` exists to clean up, and the only way to
 * tell whether it ran in a repository: prune it and the registration
 * disappears, leave it alone and the registration stays. The directory lives
 * outside both scan roots, so nothing this tool looks at can find it - which
 * makes the registration a probe for the one thing `apply` does that is not a
 * plan entry.
 *
 * @param repository - The repository to register the worktree in.
 * @param path - Where the worktree is created, and then deleted from.
 */
export async function addStaleRegistration(repository: string, path: string): Promise<void> {
  await runOrThrow("git", ["-C", repository, "worktree", "add", "-q", "-b", basename(path), path]);
  await rm(path, { recursive: true, force: true });
}

/**
 * Read the worktree paths a repository still has registered.
 *
 * @param repository - The repository to ask.
 * @returns Every registered worktree path, the repository's own first.
 */
export async function worktreeRegistrations(repository: string): Promise<ReadonlyArray<string>> {
  const stdout = await runOrThrow("git", ["-C", repository, "worktree", "list", "--porcelain"]);
  const prefix = "worktree ";

  return stdout
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

/**
 * Read back the paths an archive holds.
 *
 * @param archive - The archive to list.
 * @returns Its entries, as `tar` names them.
 */
export async function archiveEntries(archive: string): Promise<ReadonlyArray<string>> {
  const stdout = await runOrThrow("tar", ["-tzf", archive]);

  return stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Snapshot every file beneath a directory with its size.
 *
 * Git's own bookkeeping is skipped: reading a worktree's status refreshes
 * `.git/index`, which changes nothing this tool would ever reclaim, and
 * counting it would fail a no-mutation assertion for the wrong reason.
 *
 * @param root - The directory to snapshot.
 * @returns One sorted `<relative path> <bytes>` line per regular file.
 */
export async function listFiles(root: string): Promise<ReadonlyArray<string>> {
  const visit = async (directory: string): Promise<ReadonlyArray<string>> => {
    const entries = await readdir(directory, { withFileTypes: true });

    const nested = await Promise.all(
      entries.map(async (entry): Promise<ReadonlyArray<string>> => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          return entry.name === ".git" ? [] : visit(path);
        }

        if (!entry.isFile()) {
          return [];
        }

        const { size } = await stat(path);

        return [`${relative(root, path)} ${size}`];
      }),
    );

    return nested.flat();
  };

  return (await visit(root)).toSorted();
}

/**
 * A clock stopped at one instant.
 *
 * The mutator stamps an archive's name from the runtime's clock, so stopping
 * it is what lets a test know which file the next archive will occupy before
 * `tar` is spawned. Nothing on the path under test sleeps, so a sleep that
 * returns at once cannot hide a wait.
 *
 * @param instant - The instant every reading reports.
 * @returns A clock frozen at that instant.
 */
export function frozenClockAt(instant: Date): Clock.Clock {
  const millis = instant.getTime();
  const nanos = BigInt(millis) * 1_000_000n;

  return {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => nanos,
    currentTimeNanos: Effect.succeed(nanos),
    monotonicTimeNanosUnsafe: () => nanos,
    monotonicTimeNanos: Effect.succeed(nanos),
    sleep: () => Effect.void,
  };
}
