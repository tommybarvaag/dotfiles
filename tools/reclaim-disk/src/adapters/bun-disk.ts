/**
 * The macOS + Bun implementation of the inventory and mutator ports.
 *
 * All process mechanics live here: `du`, `df`, `find`, `git`, and `tar` are
 * invoked directly rather than through a shell, so no path needs quoting and a
 * directory named with a space or a quote cannot change what runs. Raw exit
 * codes and stderr are translated into the tool's typed errors and never
 * escape this module.
 */
import { Clock, Effect, Layer, Semaphore } from "effect";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as Cutoff from "../domain/cutoff.ts";
import * as Kilobytes from "../domain/kilobytes.ts";
import * as Worktree from "../domain/worktree.ts";
import {
  ArchiveFailed,
  messageOf,
  NotAWorktree,
  PruneFailed,
  RemoveFailed,
  ScanFailed,
  SizeUnavailable,
  WorktreeStatusUnavailable,
} from "../errors.ts";
import { DiskInventory, DiskMutator, ScanProgress, type SearchResult } from "../ports.ts";

/** Encodes what a command reads on its standard input, built once. */
const ENCODER = new TextEncoder();

/** The volume holding user data on modern macOS. */
const DATA_VOLUME = "/System/Volumes/Data";

/** Where the live mutator writes archives of untracked files. */
const ARCHIVE_DIR = join(homedir(), ".reclaim-disk-archives");

/**
 * What a finished subprocess produced.
 *
 * A command that did not succeed carries no stdout, so a caller cannot read
 * output without having dealt with failure first — which is what stops a
 * failed `du` from being summed as zero kilobytes. The exit code and stderr
 * are folded into one `reason` at the single place that knows both.
 */
type ProcessOutcome =
  | { readonly _tag: "Succeeded"; readonly stdout: string }
  | { readonly _tag: "Failed"; readonly reason: string };

/**
 * Run a command to completion and classify what happened.
 *
 * Rejection is impossible for the caller to observe: a spawn failure is
 * reported as a failed outcome carrying the thrown message, so every caller
 * classifies failure the same way.
 *
 * @param command - The executable to run.
 * @param args - Its arguments, passed as an argv array and never through a shell.
 * @param input - Written to the command's standard input, which is then closed.
 * @returns The captured stdout, or why the command failed.
 */
async function capture(
  command: string,
  args: ReadonlyArray<string>,
  input: string,
): Promise<ProcessOutcome> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: ENCODER.encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode === 0) {
      return { _tag: "Succeeded", stdout };
    }

    const reported = stderr.trim();

    return { _tag: "Failed", reason: reported === "" ? `${command} exited ${exitCode}` : reported };
  } catch (cause) {
    return { _tag: "Failed", reason: messageOf(cause) };
  }
}

/**
 * Run a command, translating anything but a clean exit into a typed error.
 *
 * @template E - The error a failed command becomes.
 * @param command - The executable to run.
 * @param args - Its arguments, passed as an argv array and never through a shell.
 * @param onFailure - Builds this boundary's error from the reason the command failed.
 * @returns The command's stdout, or the typed error.
 */
function run<E>(
  command: string,
  args: ReadonlyArray<string>,
  onFailure: (reason: string) => E,
): Effect.Effect<string, E> {
  return runWriting(command, args, "", onFailure);
}

/**
 * Run a command, writing to its standard input first.
 *
 * The one use is handing `tar` a list of names. Names belong on stdin rather
 * than in argv because `tar` reads an operand beginning with `@` as "read
 * entries from this archive", and `--` does not turn that off - it stops option
 * parsing only. An untracked file called `@notes.tar` is therefore never
 * archived by an argv invocation, and when the name it points at happens to
 * resolve, `tar` exits 0 having quietly skipped it.
 *
 * @template E - The error a failed command becomes.
 * @param command - The executable to run.
 * @param args - Its arguments, passed as an argv array and never through a shell.
 * @param input - Written to the command's standard input, which is then closed.
 * @param onFailure - Builds this boundary's error from the reason the command failed.
 * @returns The command's stdout, or the typed error.
 */
function runWriting<E>(
  command: string,
  args: ReadonlyArray<string>,
  input: string,
  onFailure: (reason: string) => E,
): Effect.Effect<string, E> {
  return Effect.flatMap(
    Effect.promise(() => capture(command, args, input)),
    (outcome) =>
      outcome._tag === "Succeeded"
        ? Effect.succeed(outcome.stdout)
        : Effect.fail(onFailure(outcome.reason)),
  );
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
 * Normalise a path for comparing what was asked for against what an archive holds.
 *
 * macOS preserves the Unicode normalisation a name was created with but
 * compares without regard to it, so `git` and `tar` can name the same file with
 * different byte sequences for `æ`. Two names that differ only in normalisation
 * cannot both exist on such a volume, so folding them together cannot make
 * distinct files look like one.
 *
 * @param path - The path as a command printed it.
 * @returns The path in a single normal form.
 */
function comparable(path: string): string {
  return path.normalize("NFC");
}

/**
 * Build the `find` arguments selecting a directory's immediate children last
 * modified before a cutoff.
 *
 * Measuring and removing share this selection, and the cutoff was resolved
 * before either ran, so the set that was reported and the set that is deleted
 * cannot drift apart.
 *
 * @param path - The directory whose entries are selected.
 * @param staleBefore - The resolved cutoff the plan carries.
 * @param action - The command `-exec` applies to the selected entries.
 * @returns The argv for `find`, without the executable.
 */
function staleEntryArgs(
  path: string,
  staleBefore: Cutoff.Cutoff,
  action: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    path,
    "-maxdepth",
    "1",
    "-mindepth",
    "1",
    "-not",
    "-newermt",
    // The resolved instant, offset included. A bare date would be read as
    // local midnight, which is not the moment the plan named.
    Cutoff.format(staleBefore),
    "-exec",
    ...action,
    "{}",
    "+",
  ];
}

/**
 * Sum the leading size column of `du -sk` output.
 *
 * @param stdout - The raw `du` output.
 * @returns The combined size.
 */
function sumDuOutput(
  stdout: string,
): Effect.Effect<Kilobytes.Kilobytes, Kilobytes.InvalidKilobytes> {
  return Effect.map(
    Effect.forEach(lines(stdout), (line) => {
      const [field] = line.split(/\s+/u);

      return Kilobytes.parseField(field ?? "");
    }),
    Kilobytes.sum,
  );
}

/** A dependency tree, which holds no build cache this tool owns. */
const NODE_MODULES = "node_modules";

/** A repository's git database. */
const GIT_DIRECTORY = ".git";

/**
 * Directory names the scans never descend into.
 *
 * A dependency tree holds hundreds of thousands of directories and no build
 * cache this tool owns, so walking it dominated the scan while contributing
 * nothing. A repository's git database holds neither a cache nor a worktree.
 * Exported so the exclusion is reviewable rather than buried.
 *
 * The trade-off: a vendored package shipping a populated `.turbo/cache` would
 * now be missed. That has not been observed, and the cost of looking is the
 * whole latency problem.
 */
export const PRUNED_DIRECTORIES: ReadonlySet<string> = new Set([NODE_MODULES, GIT_DIRECTORY]);

/** Depth limit meaning "no limit". */
const UNBOUNDED_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * How many directories the walk lists at once, across the whole traversal.
 *
 * One number, not one per level: the bound is a semaphore held around each
 * `readdir`, and the per-level `forEach` is unbounded. Bounding each level
 * instead would bound nothing, because every level descends into another
 * bounded `forEach` and the limits compound - 16 siblings at a time, five
 * levels deep, is a million listings in flight rather than sixteen.
 */
const WALK_CONCURRENCY = 16;

/** The directory Turbo writes its cache under. */
const TURBO_DIRECTORY = ".turbo";

/** The regenerable part of `.turbo`, and the only part worth reclaiming. */
const TURBO_CACHE_DIRECTORY = "cache";

/** Agent worktrees sit one level under a per-repository grouping. */
const WORKTREE_DEPTH = 2;

/** A search that established nothing: no matches, nothing skipped. */
const NOTHING_FOUND: SearchResult = { matches: [], skipped: [] };

/** A directory the walk reached, offered to a search's match rule. */
type Candidate = {
  /** The directory's own name. */
  readonly name: string;
  /** Absolute path of the directory holding it. */
  readonly parent: string;
  /** Its depth beneath the search root, counting the root's children as 1. */
  readonly depth: number;
};

/**
 * One directory search.
 *
 * Both finders are the same traversal — collect the directories a rule picks
 * out, never descend into one that was picked, and stop at a depth — so what
 * differs between them is data rather than two functions.
 */
type Search = {
  /** The directory to search. */
  readonly root: string;
  /** What is being looked for, in human terms, for progress and failures. */
  readonly lookingFor: string;
  /** Deepest level a match may be found at, counting the root's children as 1. Never below 1. */
  readonly maxDepth: number;
  /** Whether a directory is a result. A match is collected and never descended into. */
  readonly matches: (candidate: Candidate) => boolean;
};

/**
 * Why a directory could not be listed, classified by what the walk should do.
 *
 * - `Absent` - there is no directory there. At a root that means the category
 *   is simply empty on this machine; deeper it means something moved while the
 *   walk was running.
 * - `Denied` - it is there and this process may not read it. An unprivileged
 *   sweep of a home directory always hits some.
 * - `Unusable` - the machine could not answer at all: out of descriptors, out
 *   of memory, an I/O error. Nothing about such a scan is trustworthy, so it is
 *   the one classification that ends the search rather than annotating it.
 */
type ListingFailure = {
  /** Which of the three kinds of failure this is. */
  readonly _tag: "Absent" | "Denied" | "Unusable";
  /** The underlying failure message. */
  readonly reason: string;
};

/** Error codes meaning there is no directory at that path to list. */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** Error codes meaning the directory is there and unreadable by this process. */
const DENIED_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/**
 * Read the `code` a Node filesystem error carries, if it carries one.
 *
 * @param cause - The value `readdir` rejected with.
 * @returns The error code, or an empty string when there is none.
 */
function errorCodeOf(cause: unknown): string {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return "";
  }

  const { code } = cause;

  return typeof code === "string" ? code : "";
}

/**
 * Classify a failed directory listing.
 *
 * @param cause - The value `readdir` rejected with.
 * @returns What kind of failure it was, and its message.
 */
function classifyListingFailure(cause: unknown): ListingFailure {
  const reason = messageOf(cause);
  const code = errorCodeOf(cause);

  if (ABSENT_CODES.has(code)) {
    return { _tag: "Absent", reason };
  }

  if (DENIED_CODES.has(code)) {
    return { _tag: "Denied", reason };
  }

  return { _tag: "Unusable", reason };
}

/**
 * Whether a directory is a Turbo cache: `cache`, directly inside `.turbo`.
 *
 * Matching the cache itself rather than its `.turbo` parent is what lets the
 * walk report exactly what it returns; there is no later pass that could drop
 * a path already announced as found.
 *
 * @param candidate - The directory the walk reached.
 * @returns `true` when the directory is a Turbo cache.
 */
function isTurboCache({ name, parent }: Candidate): boolean {
  return name === TURBO_CACHE_DIRECTORY && basename(parent) === TURBO_DIRECTORY;
}

/**
 * Combine the results of searching several subtrees.
 *
 * @param results - One result per subtree.
 * @returns Every match and every skipped directory, in encounter order.
 */
function mergeResults(results: ReadonlyArray<SearchResult>): SearchResult {
  return {
    matches: results.flatMap((result) => result.matches),
    skipped: results.flatMap((result) => result.skipped),
  };
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
 *   is needed.
 *
 * An unreadable subdirectory does not end the scan, but it does not disappear
 * either: it comes back under `skipped`, which the survey turns into a reported
 * row like any other directory it could not establish anything about.
 *
 * A root that does not exist yields nothing rather than failing. Both roots are
 * defaulted, so "the caller was asked to scan somewhere that does not exist" is
 * usually "this machine has never run an agent" - and that must not take the
 * other category's report down with it. A root that exists and cannot be read
 * is still a `ScanFailed`, as is any listing the machine could not answer.
 *
 * @param progress - Where each match is reported as it is discovered.
 * @param search - What to look for, where, and how deep.
 * @returns Every matching path, and every directory that could not be read.
 */
function walk(
  progress: ScanProgress["Service"],
  search: Search,
): Effect.Effect<SearchResult, ScanFailed> {
  return Effect.gen(function* () {
    yield* progress.scanning(search.lookingFor, search.root);

    // The single bound on the whole traversal. Acquired around the listing
    // only, never held across the recursion beneath it, so it cannot deadlock.
    const listings = yield* Semaphore.make(WALK_CONCURRENCY);

    const list = (directory: string): Effect.Effect<ReadonlyArray<string>, ListingFailure> =>
      Semaphore.withPermit(listings)(
        Effect.tryPromise({
          try: () => childDirectories(directory),
          catch: classifyListingFailure,
        }),
      );

    const scanFailed = (cause: string): ScanFailed =>
      new ScanFailed({ root: search.root, lookingFor: search.lookingFor, cause });

    function descend(path: string, depth: number): Effect.Effect<SearchResult, ScanFailed> {
      return Effect.matchEffect(list(path), {
        onFailure: (failure): Effect.Effect<SearchResult, ScanFailed> =>
          failure._tag === "Unusable"
            ? Effect.fail(scanFailed(`${path}: ${failure.reason}`))
            : Effect.succeed({
                matches: [],
                skipped: [{ path, reason: `could not be listed: ${failure.reason}` }],
              }),
        onSuccess: (children) => visit(path, depth, children),
      });
    }

    function visit(
      directory: string,
      depth: number,
      children: ReadonlyArray<string>,
    ): Effect.Effect<SearchResult, ScanFailed> {
      return Effect.map(
        Effect.forEach(
          children,
          (name): Effect.Effect<SearchResult, ScanFailed> => {
            const childDepth = depth + 1;
            const path = join(directory, name);

            if (search.matches({ name, parent: directory, depth: childDepth })) {
              return Effect.as(progress.found(path), { matches: [path], skipped: [] });
            }

            // Pruning is consulted only after `matches`, so a search can never
            // be defeated by a name it is itself looking for.
            if (childDepth >= search.maxDepth || PRUNED_DIRECTORIES.has(name)) {
              return Effect.succeed(NOTHING_FOUND);
            }

            return descend(path, childDepth);
          },
          { concurrency: "unbounded" },
        ),
        mergeResults,
      );
    }

    return yield* Effect.matchEffect(list(search.root), {
      onFailure: (failure): Effect.Effect<SearchResult, ScanFailed> =>
        failure._tag === "Absent"
          ? Effect.succeed(NOTHING_FOUND)
          : Effect.fail(scanFailed(failure.reason)),
      onSuccess: (children) => visit(search.root, 0, children),
    });
  });
}

/**
 * List a directory's immediate subdirectories, rejecting when it cannot be read.
 *
 * `readdir` with file types reports a symlink as a link rather than a
 * directory, so filtering on `isDirectory` also excludes symlinks.
 *
 * @param directory - The directory to list.
 * @returns The subdirectory names.
 */
async function childDirectories(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Parse what git said about a directory into an inspection, or refuse it.
 *
 * This is the one place the tool turns a candidate directory into the claim
 * "a linked worktree of that repository", and every caller downstream acts on
 * that claim by deleting the directory. The walk finds candidates by depth,
 * which is a bound on the search and not evidence about anything; the evidence
 * is here.
 *
 * @param path - The directory as the walk named it.
 * @param resolved - The same directory with its symlinks taken out.
 * @param status - The raw NUL-terminated porcelain status.
 * @param located - The three paths `git rev-parse` reported, one per line.
 * @returns The inspection, or why the directory is not a worktree.
 */
function inspect(
  path: string,
  resolved: string,
  status: string,
  located: string,
): Effect.Effect<Worktree.Inspection, WorktreeStatusUnavailable | NotAWorktree> {
  const [gitDirectory, commonDirectory, toplevel] = lines(located);

  if (gitDirectory === undefined || commonDirectory === undefined || toplevel === undefined) {
    return Effect.fail(
      new WorktreeStatusUnavailable({
        path,
        cause: "git rev-parse did not report the work tree's location",
      }),
    );
  }

  // A worktree is the root of its work tree. A stray directory is not, and
  // `git -C` searches upward, so without this check it inherits the status of
  // whatever repository the worktree root happens to sit inside - reads as
  // clean, is deleted, and names that repository as one to prune.
  if (toplevel !== resolved) {
    return Effect.fail(
      new NotAWorktree({ path, reason: `a directory inside the work tree at ${toplevel}` }),
    );
  }

  // A linked worktree keeps its own git directory under the repository's
  // shared one. The two being the same directory means this is a main checkout
  // or a standalone clone, whose object database is inside it - so `git status`
  // saying "clean" says nothing about the commits only it holds.
  if (gitDirectory === commonDirectory) {
    return Effect.fail(new NotAWorktree({ path, reason: "a main checkout or standalone clone" }));
  }

  return Effect.succeed({
    // `<repo>/.git` names a working tree one level up; a bare repository is
    // itself the common directory. Climbing unconditionally would name the
    // bare repository's PARENT, leaving the real registration unpruned and
    // pointing `git -C` at whatever repository that parent happens to sit in.
    repository: basename(commonDirectory) === ".git" ? dirname(commonDirectory) : commonDirectory,
    state: Worktree.classify(status.split("\0")),
  });
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

    /**
     * Total the `du`-shaped output of a command and count the path as measured.
     *
     * Empty output is a real answer — `find` matching nothing sums to zero —
     * but only because the command succeeded; a command that failed never
     * reaches here.
     */
    const measure = (
      path: string,
      command: string,
      args: ReadonlyArray<string>,
    ): Effect.Effect<Kilobytes.Kilobytes, SizeUnavailable> =>
      Effect.tap(
        Effect.flatMap(
          run(command, args, (reason) => new SizeUnavailable({ path, cause: reason })),
          (stdout) =>
            sumDuOutput(stdout).pipe(
              Effect.mapError(() => new SizeUnavailable({ path, cause: "unreadable du output" })),
            ),
        ),
        () => progress.measured(path),
      );

    return DiskInventory.of({
      findTurboCaches: (root) =>
        walk(progress, {
          root,
          lookingFor: "build caches",
          maxDepth: UNBOUNDED_DEPTH,
          matches: isTurboCache,
        }),

      findWorktrees: (root) =>
        walk(progress, {
          root,
          lookingFor: "agent worktrees",
          maxDepth: WORKTREE_DEPTH,
          matches: ({ depth }) => depth === WORKTREE_DEPTH,
        }),

      sizeOf: (path) => measure(path, "du", ["-sk", path]),

      sizeOfStaleEntries: (path, staleBefore) =>
        measure(path, "find", staleEntryArgs(path, staleBefore, ["du", "-sk"])),

      inspectWorktree: (path) => {
        const failed = (reason: string): WorktreeStatusUnavailable =>
          new WorktreeStatusUnavailable({ path, cause: reason });

        return Effect.flatMap(
          Effect.all(
            [
              // The physical path, because git reports one. `/tmp/x` comes back
              // from git as `/private/tmp/x`, and the comparison that decides
              // whether this directory *is* the work tree has to be between two
              // paths that went through the same resolution.
              Effect.tryPromise({
                try: () => realpath(path),
                catch: (cause) => failed(messageOf(cause)),
              }),

              // `-z` turns off the C-style quoting git otherwise applies to any
              // path holding a space, a quote, a backslash or a non-ASCII byte,
              // and terminates each record with a NUL instead. The bytes git
              // prints are then the bytes `tar` is handed, so a worktree holding
              // `notes æ.md` can actually be archived.
              //
              // `--ignored=matching` is what makes the classification total over
              // what a worktree holds: without it the ignored `.env` an agent's
              // setup wrote is invisible, and the worktree reads as clean.
              run("git", ["-C", path, "status", "--porcelain", "-z", "--ignored=matching"], failed),

              // Three facts from one process: this directory's own git
              // directory, the shared one it belongs to, and the root of the
              // work tree. Together they are exactly what "a linked worktree of
              // that repository" means.
              run(
                "git",
                [
                  "-C",
                  path,
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-dir",
                  "--git-common-dir",
                  "--show-toplevel",
                ],
                failed,
              ),
            ],
            { concurrency: "unbounded" },
          ),
          ([resolved, status, located]) => inspect(path, resolved, status, located),
        );
      },

      freeSpace: Effect.flatMap(
        run(
          "df",
          ["-k", DATA_VOLUME],
          (reason) => new SizeUnavailable({ path: DATA_VOLUME, cause: reason }),
        ),
        (stdout) => {
          const [, dataRow] = lines(stdout);
          const available = dataRow?.split(/\s+/u)[3];

          return Kilobytes.parseField(available ?? "").pipe(
            Effect.mapError(
              () => new SizeUnavailable({ path: DATA_VOLUME, cause: "unreadable df output" }),
            ),
          );
        },
      ),
    });
  }),
);

/**
 * The mutating view of this machine, writing archives beneath a directory.
 *
 * Where the archives go is configuration rather than a fact about the machine,
 * so it is supplied instead of read from the environment in here: the
 * composition root passes the user's home, and anything exercising the real
 * deletion path against a throwaway tree passes its own directory and leaves
 * the home untouched.
 *
 * @param archiveRoot - Directory the untracked-file archives are written into.
 * @returns A layer providing the mutator.
 */
export function makeDiskMutator(archiveRoot: string): Layer.Layer<DiskMutator> {
  return Layer.succeed(DiskMutator, {
    archiveUntracked: (worktree, files) =>
      Effect.gen(function* () {
        // Stamped from the runtime's clock, the same source the command line
        // resolves `--age` against, so one run has one notion of now and the
        // file an archive will occupy is known before `tar` is spawned.
        const at = new Date(yield* Clock.currentTimeMillis);
        const stamp = at.toISOString().replaceAll(/[:.]/gu, "-");
        const label = worktree.replace(/^\/+/u, "").replaceAll("/", "_");
        const destination = join(archiveRoot, `${label}-${stamp}.tar.gz`);
        const failed = (cause: string): ArchiveFailed =>
          new ArchiveFailed({ path: worktree, destination, cause });

        yield* Effect.tryPromise({
          try: () => mkdir(archiveRoot, { recursive: true }),
          catch: (cause) => failed(messageOf(cause)),
        });

        // The names go in on stdin, NUL-delimited, rather than in argv. `tar`
        // reads an argv operand beginning with `@` as "read entries from this
        // archive and add them to the output" and `--` does not disable it, so
        // an untracked `@notes.tar` would be silently skipped - and the argv
        // length ceiling would cap how many untracked files a worktree may hold.
        yield* runWriting(
          "tar",
          ["-czf", destination, "-C", worktree, "--null", "-T", "-"],
          `${files.join("\0")}\0`,
          failed,
        );

        // Read the archive back and account for every path. A clean exit code
        // does not establish that `tar` archived anything: the caller deletes
        // the only copy of these files the moment this succeeds, so what is
        // checked is the archive's contents rather than, say, its size - which
        // cannot distinguish a partial archive from a complete one, and does
        // not even catch an empty one, a gzipped empty tar being 29 bytes.
        //
        // `tar -t` delimits its listing with newlines, so a file whose name
        // holds one cannot be matched and the worktree is refused rather than
        // deleted. That is the safe direction, and the only one available:
        // there is no NUL-delimited listing to ask for.
        const listed = yield* run("tar", ["-tzf", destination], failed);
        const held = new Set(lines(listed).map((entry) => comparable(entry)));
        const missing = files.filter((file) => !held.has(comparable(file)));

        if (missing.length > 0) {
          return yield* Effect.fail(failed(`archive is missing ${missing.join(", ")}`));
        }

        return destination;
      }),

    remove: (path) =>
      Effect.tryPromise({
        try: () => rm(path, { recursive: true, force: true }),
        catch: (cause) => new RemoveFailed({ path, cause: messageOf(cause) }),
      }),

    removeStaleEntries: (path, staleBefore) =>
      Effect.asVoid(
        run(
          "find",
          staleEntryArgs(path, staleBefore, ["rm", "-rf"]),
          (reason) => new RemoveFailed({ path, cause: reason }),
        ),
      ),

    pruneWorktreeRegistrations: (repository) =>
      Effect.asVoid(
        run(
          "git",
          ["-C", repository, "worktree", "prune"],
          (reason) => new PruneFailed({ repository, cause: reason }),
        ),
      ),
  });
}

/** The live, mutating view of this machine. */
export const DiskMutatorLive = makeDiskMutator(ARCHIVE_DIR);

/** Both live ports, for the composition root. */
export const BunDiskLive = Layer.mergeAll(DiskInventoryLive, DiskMutatorLive);
