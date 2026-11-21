/**
 * The macOS + Bun implementation of the inventory and mutator ports.
 *
 * All process mechanics live here: `du`, `df`, `find`, `git`, and `tar` are
 * invoked directly rather than through a shell, so no path needs quoting and a
 * directory named with a space or a quote cannot change what runs. Raw exit
 * codes and stderr are translated into the tool's typed errors and never
 * escape this module. The two filesystem readers the inventory drives - the
 * directory walk and the Vitest temp reader - spawn nothing and live beside it.
 */
import { Clock, Effect, Layer } from "effect";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as Cutoff from "../domain/cutoff.ts";
import * as Kilobytes from "../domain/kilobytes.ts";
import * as VitestTemp from "../domain/vitest-temp.ts";
import * as Worktree from "../domain/worktree.ts";
import {
  ArchiveFailed,
  messageOf,
  NotAWorktree,
  PruneFailed,
  RemoveFailed,
  SizeUnavailable,
  TempDirUnreadable,
  WorktreeStatusUnavailable,
} from "../errors.ts";
import { DiskInventory, DiskMutator, ScanProgress, type TempRoots } from "../ports.ts";
import { type Candidate, UNBOUNDED_DEPTH, walk } from "./tree-walk.ts";
import { readCandidate } from "./vitest-temp-reader.ts";

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

/** The directory Turbo writes its cache under. */
const TURBO_DIRECTORY = ".turbo";

/** The regenerable part of `.turbo`, and the only part worth reclaiming. */
const TURBO_CACHE_DIRECTORY = "cache";

/** Agent worktrees sit one level under a per-repository grouping. */
const WORKTREE_DEPTH = 2;

/** Vitest's project directories sit directly inside the temp root. */
const VITEST_TEMP_DEPTH = 1;

/**
 * The machine-wide temp directory, which agent harnesses commonly hand their
 * children as `$TMPDIR`. Its physical path, because `/tmp` is a symlink to it.
 */
const SHARED_TEMP = "/private/tmp";

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
 * Spell out the temp roots a search covers.
 *
 * The defaults are where `os.tmpdir()` can have pointed for the runs that
 * leaked these directories: the per-user temp directory `getconf` names
 * whatever `$TMPDIR` says, which is where a shell's test runs put the bulk of
 * them; this process's own `$TMPDIR`; and the machine-wide one agent harnesses
 * hand their children. They are only spelled here. Resolving and deduplicating
 * them is the walk's, as for every other search, so a default that does not
 * exist is skipped and one that cannot be read fails the scan like any root.
 *
 * @param roots - The roots the caller asked for.
 * @returns The roots to walk, as spelled.
 */
function spellTempRoots(roots: TempRoots): Effect.Effect<ReadonlyArray<string>> {
  if (roots._tag === "Given") {
    return Effect.succeed(roots.roots);
  }

  return Effect.map(
    Effect.promise(() => capture("getconf", ["DARWIN_USER_TEMP_DIR"], "")),
    (perUser) =>
      [perUser._tag === "Succeeded" ? perUser.stdout.trim() : "", tmpdir(), SHARED_TEMP].filter(
        (path) => path !== "",
      ),
  );
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
      findTurboCaches: (roots) =>
        walk(progress, {
          roots,
          lookingFor: "build caches",
          maxDepth: UNBOUNDED_DEPTH,
          matches: isTurboCache,
        }),

      findWorktrees: (root) =>
        walk(progress, {
          roots: [root],
          lookingFor: "agent worktrees",
          maxDepth: WORKTREE_DEPTH,
          matches: ({ depth }) => depth === WORKTREE_DEPTH,
        }),

      findVitestTempCandidates: (roots) =>
        Effect.flatMap(spellTempRoots(roots), (spelled) =>
          walk(progress, {
            roots: spelled,
            lookingFor: "Vitest temp dirs",
            maxDepth: VITEST_TEMP_DEPTH,
            matches: ({ name }) => VitestTemp.isCandidateName(name),
          }),
        ),

      inspectVitestTempDir: (path) =>
        Effect.tryPromise({
          try: () => readCandidate(path),
          catch: (cause) => new TempDirUnreadable({ path, cause: messageOf(cause) }),
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
