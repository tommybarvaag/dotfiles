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
import type { Kilobytes } from "./domain/kilobytes.ts";
import type { WorktreeState } from "./domain/worktree.ts";
import type {
  ArchiveFailed,
  PruneFailed,
  RemoveFailed,
  ScanFailed,
  SizeUnavailable,
  WorktreeStatusUnavailable,
} from "./errors.ts";

/** A cutoff expressed as whole days before now. */
export type AgeInDays = number;

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
     * @param lookingFor - What is being searched for, in human terms.
     * @param root - Where the search starts.
     */
    readonly scanning: (lookingFor: string, root: string) => Effect.Effect<void>;

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

/** Read-only observation of the machine. */
export class DiskInventory extends Context.Service<
  DiskInventory,
  {
    /**
     * Find every `.turbo/cache` directory beneath a root.
     *
     * @param root - The directory to search.
     * @returns Absolute paths to each cache directory.
     */
    readonly findTurboCaches: (root: string) => Effect.Effect<ReadonlyArray<string>, ScanFailed>;

    /**
     * Find every agent worktree beneath a root.
     *
     * Worktrees are nested one level under a per-repository grouping, so this
     * looks exactly two levels deep.
     *
     * @param root - The worktree root directory.
     * @returns Absolute paths to each worktree.
     */
    readonly findWorktrees: (root: string) => Effect.Effect<ReadonlyArray<string>, ScanFailed>;

    /**
     * Find every git repository beneath a root.
     *
     * @param root - The directory to search.
     * @returns Absolute paths to each repository working directory.
     */
    readonly findRepositories: (root: string) => Effect.Effect<ReadonlyArray<string>, ScanFailed>;

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
     * @param olderThan - The age cutoff in days.
     * @returns The combined size of the stale entries.
     */
    readonly sizeOfStaleEntries: (
      path: string,
      olderThan: AgeInDays,
    ) => Effect.Effect<Kilobytes, SizeUnavailable>;

    /**
     * Read what a worktree's git status proves about it.
     *
     * @param path - The worktree directory.
     * @returns The classified state.
     */
    readonly worktreeState: (
      path: string,
    ) => Effect.Effect<WorktreeState, WorktreeStatusUnavailable>;

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
     * caller deletes the worktree on success.
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
     * @param path - The directory to remove.
     */
    readonly remove: (path: string) => Effect.Effect<void, RemoveFailed>;

    /**
     * Remove the immediate children of a directory last modified before a cutoff.
     *
     * @param path - The directory whose entries are pruned.
     * @param olderThan - The age cutoff in days.
     */
    readonly removeStaleEntries: (
      path: string,
      olderThan: AgeInDays,
    ) => Effect.Effect<void, RemoveFailed>;

    /**
     * Drop a repository's registrations for worktrees that no longer exist.
     *
     * @param repository - The repository working directory.
     */
    readonly pruneWorktreeRegistrations: (repository: string) => Effect.Effect<void, PruneFailed>;
  }
>()("reclaim-disk/DiskMutator") {}
