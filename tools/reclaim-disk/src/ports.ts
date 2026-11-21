/**
 * Application-owned contracts for the two things this tool does to a machine:
 * look at it, and change it.
 *
 * The split is load-bearing rather than cosmetic. Planning depends only on
 * `DiskInventory`, so a dry run cannot delete anything — not by convention,
 * but because the mutating capability is absent from the effect's requirements
 * and the compiler enforces it.
 */
import { Context, type Effect } from "effect";
import type { Cutoff } from "./domain/cutoff.ts";
import type { Kilobytes } from "./domain/kilobytes.ts";
import type * as VitestTemp from "./domain/vitest-temp.ts";
import type { Inspection } from "./domain/worktree.ts";
import type {
  ArchiveFailed,
  NotAWorktree,
  PruneFailed,
  RemoveFailed,
  ScanFailed,
  SizeUnavailable,
  TempDirUnreadable,
  WorktreeStatusUnavailable,
} from "./errors.ts";

/**
 * Where the inventory reports what it is doing while it does it.
 *
 * Every method returns `Effect<void>` with no error channel and no capability
 * of its own, so a progress implementation cannot fail a scan, cannot widen
 * any error union, and cannot reach the filesystem. Reporting is therefore
 * free to be dropped, buffered, or ignored without changing what the tool
 * decides — which is why this sits beside the inventory rather than inside the
 * application service.
 */
export class ScanProgress extends Context.Service<
  ScanProgress,
  {
    /**
     * A search has begun.
     *
     * Called once per search however many roots it covers, so what follows
     * counts across all of them.
     *
     * @param lookingFor - What is being searched for, in human terms.
     * @param roots - Where the search starts, as physical paths.
     */
    readonly scanning: (lookingFor: string, roots: ReadonlyArray<string>) => Effect.Effect<void>;

    /**
     * A candidate was discovered, before it has been measured.
     *
     * @param path - The discovered path.
     */
    readonly found: (path: string) => Effect.Effect<void>;

    /**
     * A candidate finished being measured.
     *
     * @param path - The measured path.
     */
    readonly measured: (path: string) => Effect.Effect<void>;

    /**
     * The scan ended, whether by completing or being interrupted.
     *
     * Implementations must leave the terminal in a usable state here.
     */
    readonly done: Effect.Effect<void>;
  }
>()("reclaim-disk/ScanProgress") {}

/**
 * A directory the walk could not list, so nothing beneath it was examined.
 *
 * An unprivileged sweep of a home directory always hits some, so one of these
 * is not a reason to end a scan. It is a reason to say so: the tool's claim is
 * that nothing vanishes silently, and a directory that was skipped is carried
 * back alongside the matches rather than dropped.
 */
export type UnreadableDirectory = {
  /** The directory that could not be listed. */
  readonly path: string;
  /** Why it could not be listed, in the failure's own words. */
  readonly reason: string;
};

/** What one search of the tree established. */
export type SearchResult = {
  /**
   * Physical paths of the directories the search was looking for, each once,
   * however many of its roots reached it and however they were spelled.
   */
  readonly matches: ReadonlyArray<string>;
  /** Directories the search could not descend into, reported rather than skipped in silence. */
  readonly skipped: ReadonlyArray<UnreadableDirectory>;
};

/** Read-only observation of the machine. */
export class DiskInventory extends Context.Service<
  DiskInventory,
  {
    /**
     * Find every `.turbo/cache` directory beneath any of several roots.
     *
     * One search, not one per root: roots are resolved to their physical paths
     * and an alias of one already given is not walked again, and roots may
     * nest - `~/.t3` holds `~/.t3/worktrees` - so a cache is returned once
     * however many roots reach it. Measuring it twice would double the
     * reported total, and deleting it twice would fail on a cache already gone.
     *
     * A root that does not exist holds no caches, which is a fact about the
     * machine rather than a broken request - every root is defaulted, so a
     * machine where one was never created must still get the others' report.
     *
     * @param roots - The directories to search.
     * @returns Each cache directory, and every directory the search could not read.
     */
    readonly findTurboCaches: (
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<SearchResult, ScanFailed>;

    /**
     * Find every agent worktree beneath a root.
     *
     * Worktrees are nested one level under a per-repository grouping, so this
     * looks exactly two levels deep. The root is resolved to its physical
     * path, so a worktree is named the same way as a cache inside it. A root
     * that does not exist holds no worktrees, for the same reason it holds no
     * caches.
     *
     * @param root - The worktree root directory.
     * @returns Each worktree, and every directory the search could not read.
     */
    readonly findWorktrees: (root: string) => Effect.Effect<SearchResult, ScanFailed>;

    /**
     * The temp roots Vitest can have written into on this machine.
     *
     * Vitest writes under `os.tmpdir()`, which follows `$TMPDIR` - and that is
     * not one directory. A shell gets the per-user `/var/folders/…/T`; an agent
     * harness often sets `/tmp`. Each is resolved to its physical path, so
     * `/tmp` and `/private/tmp` are one root rather than two that find the same
     * directories. Best effort: a root that cannot be resolved is left out.
     *
     * @returns Each distinct root, physical paths only.
     */
    readonly vitestTempRoots: Effect.Effect<ReadonlyArray<string>>;

    /**
     * Find every directory directly inside any of several temp roots named
     * like a Vitest project directory.
     *
     * The name is a filter, not evidence: a match is a candidate for
     * `inspectVitestTempDir` and nothing more. The roots are resolved to their
     * physical paths first and each is walked once, so `/tmp` and
     * `/private/tmp` find each candidate once, named the same way. A root that
     * does not exist holds no candidates.
     *
     * @param roots - The temp roots to search.
     * @returns Each candidate, and every directory the search could not read.
     */
    readonly findVitestTempCandidates: (
      roots: ReadonlyArray<string>,
    ) => Effect.Effect<SearchResult, ScanFailed>;

    /**
     * Establish that a candidate is a Vitest project temp directory, and when
     * it was last written to.
     *
     * A directory that is no longer there, or that is not Vitest's, is reported
     * as such rather than as a failure: between a survey and a deletion a
     * vanished one is what a finished run leaves, and an unrecognised one is
     * dropped by a survey but refused by a deletion, so the caller decides.
     *
     * @param path - The candidate to examine.
     * @returns When it was last written to, why it is not Vitest's, or that it is gone.
     */
    readonly inspectVitestTempDir: (
      path: string,
    ) => Effect.Effect<VitestTemp.Inspection, TempDirUnreadable>;

    /**
     * Measure a directory's total size.
     *
     * @param path - The directory to measure.
     * @returns The size on disk.
     */
    readonly sizeOf: (path: string) => Effect.Effect<Kilobytes, SizeUnavailable>;

    /**
     * Measure only the immediate children of a directory last modified before a cutoff.
     *
     * @param path - The directory whose entries are measured.
     * @param staleBefore - The resolved cutoff the plan carries.
     * @returns The combined size of the stale entries.
     */
    readonly sizeOfStaleEntries: (
      path: string,
      staleBefore: Cutoff,
    ) => Effect.Effect<Kilobytes, SizeUnavailable>;

    /**
     * Establish that a directory is a linked worktree, which repository owns
     * it, and what its git status proves about it.
     *
     * All three facts come from the directory itself, so the repository a
     * removal must be pruned in is known without searching for one — and a
     * directory that merely sits where a worktree would be is refused rather
     * than described, because an `Inspection` is a claim the caller acts on.
     *
     * @param path - The directory to examine.
     * @returns The owning repository and the classified state.
     */
    readonly inspectWorktree: (
      path: string,
    ) => Effect.Effect<Inspection, WorktreeStatusUnavailable | NotAWorktree>;

    /**
     * Read the free space on the volume holding the user's data.
     *
     * @returns The available space.
     */
    readonly freeSpace: Effect.Effect<Kilobytes, SizeUnavailable>;
  }
>()("reclaim-disk/DiskInventory") {}

/** Mutation of the machine. Required only by `apply`, never by planning. */
export class DiskMutator extends Context.Service<
  DiskMutator,
  {
    /**
     * Archive a worktree's untracked files before it is removed.
     *
     * Must fail rather than produce an empty or partial archive, because the
     * caller deletes the worktree on success. A clean exit code is not enough
     * to establish that: the implementation has to read the archive back and
     * find every one of these paths in it.
     *
     * @param worktree - The worktree holding the files.
     * @param files - The untracked paths, relative to the worktree.
     * @returns The absolute path of the written archive.
     */
    readonly archiveUntracked: (
      worktree: string,
      files: ReadonlyArray<string>,
    ) => Effect.Effect<string, ArchiveFailed>;

    /**
     * Remove a directory and everything beneath it.
     *
     * Removal is depth-first and not atomic: a `RemoveFailed` means the path is
     * still there, not that it is untouched, because everything already
     * unlinked beneath it stays unlinked. Callers must report it as such.
     *
     * @param path - The directory to remove.
     */
    readonly remove: (path: string) => Effect.Effect<void, RemoveFailed>;

    /**
     * Remove the immediate children of a directory last modified before a cutoff.
     *
     * Takes the same resolved cutoff the size was measured against, so the set
     * that was reported is the set that is removed.
     *
     * @param path - The directory whose entries are pruned.
     * @param staleBefore - The resolved cutoff the plan carries.
     */
    readonly removeStaleEntries: (
      path: string,
      staleBefore: Cutoff,
    ) => Effect.Effect<void, RemoveFailed>;

    /**
     * Drop a repository's registrations for worktrees that no longer exist.
     *
     * @param repository - The repository working directory.
     */
    readonly pruneWorktreeRegistrations: (repository: string) => Effect.Effect<void, PruneFailed>;
  }
>()("reclaim-disk/DiskMutator") {}
