/**
 * The reclaim operation: survey the machine, decide, and optionally act.
 *
 * `survey` requires only `DiskInventory`, so its type proves it cannot delete.
 * `apply` additionally requires `DiskMutator`. Nothing here knows about the
 * command line, `du`, `git`, or Bun.
 */
import { Effect, Option } from "effect";
import { casesHandled } from "./defect.ts";
import * as Kilobytes from "./domain/kilobytes.ts";
import * as Plan from "./domain/plan.ts";
import type { AgeInDays } from "./ports.ts";
import { DiskInventory, DiskMutator } from "./ports.ts";

/** Which categories of target to consider. */
export type Selection = "all" | "turbo-only" | "worktrees-only";

/** Where to look and what to consider. */
export type SurveyOptions = {
  /** Root containing the repositories whose turbo caches are scanned. */
  readonly sourceRoot: string;
  /** Root containing agent worktrees. */
  readonly worktreeRoot: string;
  /** Which categories to include. */
  readonly selection: Selection;
  /**
   * When present, only turbo cache entries older than this many days are
   * considered. When absent, whole caches are considered.
   */
  readonly staleAfter: Option.Option<AgeInDays>;
};

/** What actually happened during `apply`. */
export type Outcome = {
  /** Space the volume gained, measured across the whole run. */
  readonly freed: Kilobytes.Kilobytes;
  /** Archives written before deletion, in the order created. */
  readonly archives: ReadonlyArray<string>;
  /** Number of targets removed. */
  readonly removed: number;
};

/** How many directories to measure at once. */
const SCAN_CONCURRENCY = 8;

/**
 * Determine whether a selection includes turbo caches.
 *
 * @param selection - The requested selection.
 * @returns `true` when turbo caches should be scanned.
 */
function includesTurbo(selection: Selection): boolean {
  switch (selection) {
    case "all":
    case "turbo-only":
      return true;

    case "worktrees-only":
      return false;

    default:
      return casesHandled(selection);
  }
}

/**
 * Determine whether a selection includes agent worktrees.
 *
 * @param selection - The requested selection.
 * @returns `true` when worktrees should be scanned.
 */
function includesWorktrees(selection: Selection): boolean {
  switch (selection) {
    case "all":
    case "worktrees-only":
      return true;

    case "turbo-only":
      return false;

    default:
      return casesHandled(selection);
  }
}

/**
 * Measure every turbo cache beneath the source root.
 *
 * @param options - The survey options.
 * @returns One target per cache directory.
 */
const surveyTurboCaches = Effect.fn("Reclaim.surveyTurboCaches")(function* (
  options: SurveyOptions,
) {
  const inventory = yield* DiskInventory;
  const caches = yield* inventory.findTurboCaches(options.sourceRoot);

  return yield* Effect.forEach(
    caches,
    (path) =>
      Effect.map(
        Option.match(options.staleAfter, {
          onNone: () => inventory.sizeOf(path),
          onSome: (days) => inventory.sizeOfStaleEntries(path, days),
        }),
        (size): Plan.ReclaimTarget => ({
          _tag: "TurboCache",
          path,
          size,
          prunedByAge: Option.isSome(options.staleAfter),
        }),
      ),
    { concurrency: SCAN_CONCURRENCY },
  );
});

/**
 * Measure and classify every agent worktree beneath the worktree root.
 *
 * @param options - The survey options.
 * @returns One target per worktree.
 */
const surveyWorktrees = Effect.fn("Reclaim.surveyWorktrees")(function* (options: SurveyOptions) {
  const inventory = yield* DiskInventory;
  const worktrees = yield* inventory.findWorktrees(options.worktreeRoot);

  return yield* Effect.forEach(
    worktrees,
    (path) =>
      Effect.map(
        Effect.all([inventory.sizeOf(path), inventory.worktreeState(path)]),
        ([size, state]): Plan.ReclaimTarget => ({
          _tag: "AgentWorktree",
          path,
          size,
          state,
        }),
      ),
    { concurrency: SCAN_CONCURRENCY },
  );
});

/**
 * Survey the machine and decide what should happen, without changing anything.
 *
 * @param options - Where to look and what to consider.
 * @returns The plan, partitioned into what would be reclaimed and what would be kept.
 */
export const survey = Effect.fn("Reclaim.survey")(function* (options: SurveyOptions) {
  const turbo = includesTurbo(options.selection)
    ? yield* surveyTurboCaches(options)
    : ([] as ReadonlyArray<Plan.ReclaimTarget>);

  const worktrees = includesWorktrees(options.selection)
    ? yield* surveyWorktrees(options)
    : ([] as ReadonlyArray<Plan.ReclaimTarget>);

  return Plan.make([...turbo, ...worktrees]);
});

/**
 * Carry out one planned entry.
 *
 * An `ArchiveThenDelete` entry archives first and only deletes once the
 * archive is written, so a failed archive leaves the worktree intact.
 *
 * @param entry - The entry to act on.
 * @param options - The survey options, for the stale-entry cutoff.
 * @returns The archive path when one was written.
 */
const actOn = Effect.fn("Reclaim.actOn")(function* (entry: Plan.PlanEntry, options: SurveyOptions) {
  const mutator = yield* DiskMutator;
  const { target, disposition } = entry;

  if (target._tag === "TurboCache") {
    yield* Option.match(options.staleAfter, {
      onNone: () => mutator.remove(target.path),
      onSome: (days) => mutator.removeStaleEntries(target.path, days),
    });

    return Option.none<string>();
  }

  switch (disposition._tag) {
    case "Delete": {
      yield* mutator.remove(target.path);

      return Option.none<string>();
    }

    case "ArchiveThenDelete": {
      const archive = yield* mutator.archiveUntracked(target.path, disposition.files);
      yield* mutator.remove(target.path);

      return Option.some(archive);
    }

    case "Keep":
      return Option.none<string>();

    default:
      return casesHandled(disposition);
  }
});

/**
 * Execute a plan.
 *
 * Entries are processed sequentially: deleting hundreds of gigabytes in
 * parallel starves the filesystem without finishing sooner, and sequential
 * execution keeps the failure point unambiguous.
 *
 * @param plan - The plan produced by `survey`.
 * @param options - The options the plan was built from.
 * @returns What was archived and removed, and the space the volume gained.
 */
export const apply = Effect.fn("Reclaim.apply")(function* (plan: Plan.Plan, options: SurveyOptions) {
  const inventory = yield* DiskInventory;
  const mutator = yield* DiskMutator;
  const before = yield* inventory.freeSpace;

  const archives: Array<string> = [];

  for (const entry of plan.reclaiming) {
    const archive = yield* actOn(entry, options);

    if (Option.isSome(archive)) {
      archives.push(archive.value);
    }
  }

  const repositories = yield* inventory.findRepositories(options.sourceRoot);

  yield* Effect.forEach(repositories, (repository) => mutator.pruneWorktreeRegistrations(repository), {
    concurrency: SCAN_CONCURRENCY,
    discard: true,
  });

  const after = yield* inventory.freeSpace;

  return {
    freed: Kilobytes.difference(after, before),
    archives,
    removed: plan.reclaiming.length,
  } satisfies Outcome;
});
