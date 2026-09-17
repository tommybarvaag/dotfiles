/**
 * What the tool found on disk, and the plan derived from it.
 *
 * A plan is a pure projection of scan results. Building one performs no I/O
 * and deletes nothing, so a dry run is the plan itself rather than a flag
 * threaded through the deletion code.
 */
import { casesHandled } from "../defect.ts";
import * as Kilobytes from "./kilobytes.ts";
import * as Worktree from "./worktree.ts";

/** Something on disk this tool knows how to reclaim. */
export type ReclaimTarget =
  | {
      readonly _tag: "TurboCache";
      /** The `.turbo/cache` directory. */
      readonly path: string;
      /** Size of the entries selected for removal. */
      readonly size: Kilobytes.Kilobytes;
      /** Whether only entries older than the age cutoff were measured. */
      readonly prunedByAge: boolean;
    }
  | {
      readonly _tag: "AgentWorktree";
      /** The worktree directory. */
      readonly path: string;
      /** Total size of the worktree. */
      readonly size: Kilobytes.Kilobytes;
      /** What the worktree's git status proves about it. */
      readonly state: Worktree.WorktreeState;
    };

/** A target paired with the action decided for it. */
export type PlanEntry = {
  /** The target under consideration. */
  readonly target: ReclaimTarget;
  /** What to do with it. */
  readonly disposition: Worktree.Disposition;
};

/** The full set of decisions, with totals. */
export type Plan = {
  /** Entries whose disposition frees space. */
  readonly reclaiming: ReadonlyArray<PlanEntry>;
  /** Entries deliberately left alone. */
  readonly keeping: ReadonlyArray<PlanEntry>;
  /** Total size the reclaiming entries would free. */
  readonly reclaimable: Kilobytes.Kilobytes;
};

/**
 * Decide what to do with a single target.
 *
 * A turbo cache is derived data and is always reclaimable. A worktree defers
 * to the working-tree safety rules.
 *
 * @param target - The scanned target.
 * @returns The target paired with its disposition.
 */
export function entryFor(target: ReclaimTarget): PlanEntry {
  switch (target._tag) {
    case "TurboCache":
      return { target, disposition: { _tag: "Delete" } };

    case "AgentWorktree":
      return { target, disposition: Worktree.decide(target.state) };

    default:
      return casesHandled(target);
  }
}

/**
 * Determine whether a disposition frees space.
 *
 * @param disposition - The decided action.
 * @returns `true` when acting on it removes data from disk.
 */
export function reclaimsSpace(disposition: Worktree.Disposition): boolean {
  switch (disposition._tag) {
    case "Delete":
    case "ArchiveThenDelete":
      return true;

    case "Keep":
      return false;

    default:
      return casesHandled(disposition);
  }
}

/**
 * Build a plan from scanned targets, dropping empty ones.
 *
 * @param targets - Everything the scan found.
 * @returns The partitioned plan and its total.
 */
export function make(targets: ReadonlyArray<ReclaimTarget>): Plan {
  const reclaiming: Array<PlanEntry> = [];
  const keeping: Array<PlanEntry> = [];

  for (const target of targets) {
    if (!Kilobytes.isSignificant(target.size)) {
      continue;
    }

    const entry = entryFor(target);

    if (reclaimsSpace(entry.disposition)) {
      reclaiming.push(entry);
    } else {
      keeping.push(entry);
    }
  }

  reclaiming.sort((left, right) => right.target.size - left.target.size);

  return {
    reclaiming,
    keeping,
    reclaimable: Kilobytes.sum(reclaiming.map((entry) => entry.target.size)),
  };
}
