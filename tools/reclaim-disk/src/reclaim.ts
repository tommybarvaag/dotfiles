/**
 * The reclaim operation: survey the machine, decide, and optionally act.
 *
 * `survey` requires only `DiskInventory`, so its type proves it cannot delete.
 * `apply` additionally requires `DiskMutator`, and decides nothing that is not
 * already in the plan — it only re-reads a worktree to check the plan still
 * holds before destroying it. Nothing here knows about the command line, `du`,
 * `git`, or Bun.
 *
 * Both halves are total over what they are given. A directory the survey
 * cannot examine becomes a reported entry rather than the end of the scan, and
 * an entry `apply` cannot carry out becomes a reported refusal rather than the
 * end of the run. That is not politeness: `apply` archives the only copy of a
 * worktree's files and then deletes the worktree, so the archive's path is the
 * user's only pointer to them, and it reaches the user only inside the
 * `Outcome`. A run that abandons the outcome to propagate one entry's failure
 * destroys files and then throws away the receipt.
 */
import { Effect, Option } from "effect";
import { casesHandled } from "./defect.ts";
import * as Kilobytes from "./domain/kilobytes.ts";
import * as Plan from "./domain/plan.ts";
import * as Worktree from "./domain/worktree.ts";
import type {
  ArchiveFailed,
  NotAWorktree,
  PruneFailed,
  RemoveFailed,
  ScanFailed,
  SizeUnavailable,
  WorktreeStatusUnavailable,
} from "./errors.ts";
import { WorktreeChangedSinceSurvey } from "./errors.ts";
import { DiskInventory, DiskMutator, type SearchResult } from "./ports.ts";

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
   * What this run does with every turbo cache it finds: take the whole thing,
   * or prune the entries older than a cutoff the command line has already
   * resolved.
   *
   * The decision travels rather than the flag it came from, so measuring,
   * reporting, confirming, and deleting are all pointed at the same entries by
   * the same value.
   */
  readonly caches: Plan.CacheDisposition;
};

/**
 * How much of a target is still on disk after the run did not carry it out.
 *
 * `rm -r` unlinks depth-first, so a removal denied partway through leaves
 * everything it had already unlinked gone. Every other impediment is decided
 * before anything is touched. The difference matters to whoever reads the
 * report - "left alone" and "half deleted" call for different next steps - so
 * it is a value the outcome carries rather than a claim the wording makes.
 */
export type Remains = "Untouched" | "PartiallyRemoved";

/** Something the run did not carry out, what is left of it, and why. */
export type Refusal = {
  /** The target, or the repository, that was not carried out. */
  readonly path: string;
  /** Why, in the failure's own words. */
  readonly reason: string;
  /** What survived: all of it, or an unknown part of it. */
  readonly remains: Remains;
  /**
   * The archive written before the refusal, when one was.
   *
   * A removal denied partway has already destroyed files the archive is now
   * the only copy of, so the receipt belongs to the refusal as much as to a
   * success. The field exists so that losing it is a type error rather than an
   * omission.
   */
  readonly archive: Option.Option<string>;
};

/** What actually happened during `apply`. */
export type Outcome = {
  /**
   * Space the volume gained, measured across the whole run, or `None` when the
   * volume could not be measured afterwards. Not knowing how much was freed is
   * no reason to withhold the archive paths.
   */
  readonly freed: Option.Option<Kilobytes.Kilobytes>;
  /** Archives written before deletion, in the order created. */
  readonly archives: ReadonlyArray<string>;
  /** Number of targets actually removed, counted rather than assumed. */
  readonly removed: number;
  /** Entries and repositories the run did not carry out, each with its reason. */
  readonly refused: ReadonlyArray<Refusal>;
};

/** How many directories to measure, or repositories to prune, at once. */
const SCAN_CONCURRENCY = 8;

/** Why one directory could not be examined, in the report's words. */
type ExaminationFailure = SizeUnavailable | WorktreeStatusUnavailable | NotAWorktree;

/**
 * Every expected failure this service reports rather than propagates.
 *
 * One union and one renderer for both halves of the tool: a worktree whose
 * status cannot be read is described the same way whether it happened while
 * surveying or a moment before the delete.
 */
type Impediment =
  ExaminationFailure | WorktreeChangedSinceSurvey | ArchiveFailed | RemoveFailed | PruneFailed;

/**
 * An impediment, carrying whatever archive had already been written when it
 * struck.
 *
 * `rm -r` unlinks depth-first, so a removal denied partway through has already
 * destroyed files whose only remaining copy is the archive written moments
 * earlier. Pairing the two means the receipt cannot be dropped on the way out:
 * a run must never destroy files and then discard the pointer to them.
 */
type Impeded = {
  /** What went wrong. */
  readonly impediment: Impediment;
  /** The archive written before it went wrong, when one was. */
  readonly archive: Option.Option<string>;
};

/**
 * Carry an impediment that struck before any archive existed.
 *
 * @template A - The effect's success type.
 * @template E - The impediment the effect can fail with.
 * @template R - The effect's requirements.
 * @param effect - The effect whose failure predates any archive.
 * @returns The same effect, failing with no archive attached.
 */
function withoutArchive<A, E extends Impediment, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Impeded, R> {
  return Effect.mapError(effect, (impediment) => ({
    impediment,
    archive: Option.none<string>(),
  }));
}

/** What one impediment means for the path it happened to. */
type Consequence = {
  /** Why the path was not carried out, as a clause under the path the report prints. */
  readonly reason: string;
  /** What is left of it on disk. */
  readonly remains: Remains;
};

/**
 * Say what an impediment did to the path it happened to.
 *
 * Exhaustive on purpose, and stating `remains` case by case rather than
 * defaulting it: a new impediment has to declare whether it can leave a target
 * half-removed, because the report promises the reader which it was.
 *
 * The phrasing is a clause, because the report has already printed the path in
 * a column of its own. A failure escaping with no report around it renders
 * through its own `message` instead.
 *
 * @param failure - What the inventory or the mutator reported.
 * @returns The reason to print, and what survived.
 */
function consequenceOf(failure: Impediment): Consequence {
  switch (failure._tag) {
    case "SizeUnavailable":
      return { reason: `could not be measured: ${failure.cause}`, remains: "Untouched" };

    case "WorktreeStatusUnavailable":
      return { reason: `could not be inspected: ${failure.cause}`, remains: "Untouched" };

    case "NotAWorktree":
      return { reason: `not a linked worktree: ${failure.reason}`, remains: "Untouched" };

    case "WorktreeChangedSinceSurvey":
      return {
        reason: `changed since the survey: was ${failure.was}, now ${failure.now}`,
        remains: "Untouched",
      };

    case "ArchiveFailed":
      return {
        reason: `could not be archived to ${failure.destination}: ${failure.cause}`,
        remains: "Untouched",
      };

    // The only one that cannot promise the target is as it was found.
    case "RemoveFailed":
      return { reason: `could not be removed: ${failure.cause}`, remains: "PartiallyRemoved" };

    case "PruneFailed":
      return {
        reason: `registrations could not be pruned: ${failure.cause}`,
        remains: "Untouched",
      };

    default:
      return casesHandled(failure);
  }
}

/**
 * Record what examining one directory established, failure included.
 *
 * A directory that cannot be measured or classified becomes a reported entry
 * the plan leaves alone rather than the end of the run: a single stray
 * directory under the worktree root — what a crashed agent leaves behind — used
 * to take every other target down with it, report and all. Nothing vanishes
 * silently, and nothing unexamined can reach `reclaiming`.
 *
 * @param path - The directory being examined.
 * @param examination - The measurement and classification, which may fail.
 * @returns What the scan established, as a value.
 */
function scanned(
  path: string,
  examination: Effect.Effect<Plan.ReclaimTarget, ExaminationFailure, DiskInventory>,
): Effect.Effect<Plan.Scanned, never, DiskInventory> {
  return Effect.match(examination, {
    onSuccess: (target): Plan.Scanned => ({ _tag: "Examined", target }),
    onFailure: (failure): Plan.Scanned => ({
      _tag: "Unexamined",
      path,
      reason: consequenceOf(failure).reason,
    }),
  });
}

/**
 * Carry the directories a search could not read into the plan.
 *
 * A directory the walk could not descend into is exactly as unexamined as one
 * it could not measure, and belongs in the same section of the report. Without
 * this the walk's own `EACCES` was the one unreadable thing in the tool that
 * produced no row at all.
 *
 * @param found - What the search established.
 * @returns One unexamined result per skipped directory.
 */
function unreadable(found: SearchResult): ReadonlyArray<Plan.Scanned> {
  return found.skipped.map((directory): Plan.Scanned => ({
    _tag: "Unexamined",
    path: directory.path,
    reason: directory.reason,
  }));
}

/**
 * Measure every turbo cache beneath the source root.
 *
 * @param options - The survey options.
 * @returns One result per cache directory.
 */
const surveyTurboCaches = Effect.fn("Reclaim.surveyTurboCaches")(function* (
  options: SurveyOptions,
) {
  const inventory = yield* DiskInventory;
  const { caches } = options;
  const found = yield* inventory.findTurboCaches(options.sourceRoot);

  // Measured through the very disposition that will delete them, so a cache
  // cannot be reported at one size and emptied at another.
  const measure = (path: string) => {
    switch (caches._tag) {
      case "Delete":
        return inventory.sizeOf(path);

      case "PruneOlderThan":
        return inventory.sizeOfStaleEntries(path, caches.cutoff);

      default:
        return casesHandled(caches);
    }
  };

  const examined = yield* Effect.forEach(
    found.matches,
    (path) =>
      scanned(
        path,
        Effect.map(measure(path), (size): Plan.ReclaimTarget => ({
          _tag: "TurboCache",
          path,
          size,
        })),
      ),
    { concurrency: SCAN_CONCURRENCY },
  );

  return [...examined, ...unreadable(found)];
});

/**
 * Measure and classify every agent worktree beneath the worktree root.
 *
 * @param options - The survey options.
 * @returns One result per worktree.
 */
const surveyWorktrees = Effect.fn("Reclaim.surveyWorktrees")(function* (options: SurveyOptions) {
  const inventory = yield* DiskInventory;
  const found = yield* inventory.findWorktrees(options.worktreeRoot);

  const examined = yield* Effect.forEach(
    found.matches,
    (path) =>
      scanned(
        path,
        Effect.map(
          Effect.all([inventory.sizeOf(path), inventory.inspectWorktree(path)]),
          ([size, inspection]): Plan.ReclaimTarget => ({
            _tag: "AgentWorktree",
            path,
            size,
            repository: inspection.repository,
            state: inspection.state,
          }),
        ),
      ),
    { concurrency: SCAN_CONCURRENCY },
  );

  return [...examined, ...unreadable(found)];
});

/** One category's scan, as the selection table stores it. */
type Scan = (
  options: SurveyOptions,
) => Effect.Effect<ReadonlyArray<Plan.Scanned>, ScanFailed, DiskInventory>;

/** Which scans each selection runs. */
const SCANS: Record<Selection, ReadonlyArray<Scan>> = {
  all: [surveyTurboCaches, surveyWorktrees],
  "turbo-only": [surveyTurboCaches],
  "worktrees-only": [surveyWorktrees],
};

/**
 * Survey the machine and decide what should happen, without changing anything.
 *
 * The requirements are written out rather than inferred, which is what makes a
 * dry run safe by construction: reaching for `DiskMutator` anywhere in here —
 * directly or through something this calls — stops compiling.
 *
 * @param options - Where to look and what to consider.
 * @returns The plan: what would be reclaimed, what would be kept, and where registrations would be pruned.
 */
export const survey: (
  options: SurveyOptions,
) => Effect.Effect<Plan.Plan, ScanFailed, DiskInventory> = Effect.fn("Reclaim.survey")(function* (
  options: SurveyOptions,
) {
  // Sequentially, on purpose: the scans share one repainted status line, and
  // `ScanProgress.scanning` resets its counters, so two scans at once would
  // reset each other's and interleave their counts into a single garbled line.
  const results = yield* Effect.forEach(SCANS[options.selection], (scan) => scan(options));

  return Plan.make(results.flat(), options.caches);
});

/**
 * Re-establish that a target is still what the survey found, immediately
 * before it is destroyed.
 *
 * The plan stays authoritative: this can only refuse an entry, never widen the
 * set, re-derive a cutoff, or choose a different action. What it closes is the
 * window the confirmation prompt opens — the directories this tool exists to
 * clean up are ones agents write into, and a worktree that was clean when the
 * report was printed may hold two hours of work by the time `y` is pressed.
 *
 * @param target - The target about to be acted on.
 */
const stillAsSurveyed = Effect.fn("Reclaim.stillAsSurveyed")(function* (
  target: Plan.ReclaimTarget,
) {
  switch (target._tag) {
    case "TurboCache":
      // Regenerable by definition: nothing a cache gained since the survey is
      // worth keeping, and the cutoff that selects its entries is resolved.
      return;

    case "AgentWorktree": {
      const inventory = yield* DiskInventory;
      const { state } = yield* inventory.inspectWorktree(target.path);

      if (Worktree.equals(target.state, state)) {
        return;
      }

      return yield* Effect.fail(
        new WorktreeChangedSinceSurvey({
          path: target.path,
          was: Worktree.describe(target.state),
          now: Worktree.describe(state),
        }),
      );
    }

    default:
      return casesHandled(target);
  }
});

/**
 * Carry out one planned entry, or fail trying.
 *
 * A total switch on the disposition: the entry says what happens to it, so
 * nothing is re-derived here from the options the survey ran with. An
 * `ArchiveThenDelete` entry archives first and only deletes once the archive
 * is written, so a failed archive leaves the worktree intact.
 *
 * @param entry - The entry to act on.
 * @returns The archive path when one was written.
 */
const carryOut = Effect.fn("Reclaim.carryOut")(function* (entry: Plan.ReclaimingEntry) {
  const mutator = yield* DiskMutator;
  const { target, disposition } = entry;

  yield* withoutArchive(stillAsSurveyed(target));

  switch (disposition._tag) {
    case "Delete": {
      yield* withoutArchive(mutator.remove(target.path));

      return Option.none<string>();
    }

    case "PruneOlderThan": {
      yield* withoutArchive(mutator.removeStaleEntries(target.path, disposition.cutoff));

      return Option.none<string>();
    }

    case "ArchiveThenDelete": {
      const archive = yield* withoutArchive(
        mutator.archiveUntracked(target.path, disposition.files),
      );

      // Past this point the archive is the only copy of these files, so it
      // travels with a failed removal as well as a successful one.
      yield* Effect.mapError(mutator.remove(target.path), (impediment) => ({
        impediment,
        archive: Option.some(archive),
      }));

      return Option.some(archive);
    }

    default:
      return casesHandled(disposition);
  }
});

/** What became of one planned entry. */
type EntryOutcome =
  | {
      readonly _tag: "CarriedOut";
      /** The entry itself, so the repository that lost a worktree is known. */
      readonly entry: Plan.ReclaimingEntry;
      /** The archive written before the removal, when the entry called for one. */
      readonly archive: Option.Option<string>;
    }
  | {
      readonly _tag: "Refused";
      /** What was left alone, and why. */
      readonly refusal: Refusal;
    };

/**
 * Act on one entry, reporting whatever happened rather than propagating it.
 *
 * Every way an entry can fail is a fact about that entry: the worktree was
 * written into since the survey, `tar` could not write the archive, `rm` was
 * denied. None of them says anything about the entries behind it, and none of
 * them is a reason to abandon the archive paths already written — so none of
 * them leaves this function through the error channel.
 *
 * @param entry - The entry to act on.
 * @returns What became of it.
 */
function actOn(
  entry: Plan.ReclaimingEntry,
): Effect.Effect<EntryOutcome, never, DiskInventory | DiskMutator> {
  return Effect.match(carryOut(entry), {
    onSuccess: (archive): EntryOutcome => ({ _tag: "CarriedOut", entry, archive }),
    onFailure: (impeded): EntryOutcome => ({
      _tag: "Refused",
      refusal: {
        path: entry.target.path,
        archive: impeded.archive,
        ...consequenceOf(impeded.impediment),
      },
    }),
  });
}

/**
 * Execute a plan.
 *
 * Entries are processed sequentially: deleting hundreds of gigabytes in
 * parallel starves the filesystem without finishing sooner, and sequential
 * execution keeps the failure point unambiguous. One entry being refused does
 * not abandon the ones behind it — the whole plan was confirmed, and the run
 * returns what it managed to do.
 *
 * @param plan - The plan produced by `survey`, and the only thing this reads.
 * @returns What was archived, removed, refused, and the space the volume gained.
 */
export const apply = Effect.fn("Reclaim.apply")(function* (plan: Plan.Plan) {
  const inventory = yield* DiskInventory;
  const mutator = yield* DiskMutator;

  // Read before anything is touched: if the volume cannot be measured now,
  // nothing has happened yet and there is nothing to report losing.
  const before = yield* inventory.freeSpace;

  const results = yield* Effect.forEach(plan.reclaiming, actOn);

  const carriedOut: Array<Plan.ReclaimingEntry> = [];
  const archives: Array<string> = [];
  const refused: Array<Refusal> = [];

  for (const result of results) {
    if (result._tag === "Refused") {
      refused.push(result.refusal);

      // An entry refused after its archive was written still has a receipt,
      // and it is the only pointer to files the removal already destroyed.
      if (Option.isSome(result.refusal.archive)) {
        archives.push(result.refusal.archive.value);
      }

      continue;
    }

    carriedOut.push(result.entry);

    if (Option.isSome(result.archive)) {
      archives.push(result.archive.value);
    }
  }

  // Derived from the entries that actually went, by the same function that
  // built `plan.pruning` from the entries that were going to: a subset of what
  // the report named, so no repository is touched that was not shown, and no
  // repository is skipped that lost a worktree.
  const pruneRefusals = yield* Effect.forEach(
    Plan.owningRepositories(carriedOut),
    (repository) =>
      Effect.match(mutator.pruneWorktreeRegistrations(repository), {
        onSuccess: (): ReadonlyArray<Refusal> => [],
        onFailure: (failure): ReadonlyArray<Refusal> => [
          { path: repository, archive: Option.none<string>(), ...consequenceOf(failure) },
        ],
      }),
    { concurrency: SCAN_CONCURRENCY },
  );

  const after = yield* Effect.option(inventory.freeSpace);

  return {
    freed: Option.map(after, (space) => Kilobytes.difference(space, before)),
    archives,
    removed: carriedOut.length,
    refused: [...refused, ...pruneRefusals.flat()],
  } satisfies Outcome;
});
