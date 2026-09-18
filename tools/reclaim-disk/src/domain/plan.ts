/**
 * What the tool found on disk, and the plan derived from it.
 *
 * A plan is a pure projection of scan results. Building one performs no I/O
 * and deletes nothing, so a dry run is the plan itself rather than a flag
 * threaded through the deletion code.
 *
 * The plan is also the only thing `apply` reads. Every mutation is named by a
 * disposition here - including the resolved cutoff a pruned cache is measured
 * against, and the repositories whose stale worktree registrations are dropped
 * afterwards - so nothing can be re-derived from command-line options after
 * the plan was reported and confirmed, and the set that was shown cannot drift
 * from the set that is deleted.
 */
import { casesHandled } from "../defect.ts";
import type * as Cutoff from "./cutoff.ts";
import * as Kilobytes from "./kilobytes.ts";
import type * as Worktree from "./worktree.ts";

/** Something on disk this tool knows how to reclaim. */
export type ReclaimTarget =
  | {
      readonly _tag: "TurboCache";
      /** The `.turbo/cache` directory. */
      readonly path: string;
      /** Size of the entries selected for removal. */
      readonly size: Kilobytes.Kilobytes;
    }
  | {
      readonly _tag: "AgentWorktree";
      /** The worktree directory. */
      readonly path: string;
      /** Total size of the worktree. */
      readonly size: Kilobytes.Kilobytes;
      /** Working directory of the repository that owns it. */
      readonly repository: string;
      /** What the worktree's git status proves about it. */
      readonly state: Worktree.WorktreeState;
    };

/** A directory the scan could not establish anything about. */
export type Unexamined = {
  readonly _tag: "Unexamined";
  /** The directory in question. */
  readonly path: string;
  /** Why it could not be examined, in the failure's own words. */
  readonly reason: string;
};

/**
 * What a scan established about one directory.
 *
 * A directory that cannot be measured or classified is a member of this union
 * rather than the end of the run: one crashed agent's leftover directory under
 * the worktree root would otherwise take the whole report down with it. An
 * `Unexamined` directory carries neither a size nor a state, so it cannot
 * reach `reclaiming` - the type, not a convention, is what leaves it alone.
 */
export type Scanned =
  | {
      readonly _tag: "Examined";
      /** What was found, carrying everything deciding needs. */
      readonly target: ReclaimTarget;
    }
  | Unexamined;

/**
 * What this tool does with a target.
 *
 * Every variant carries everything acting on it needs, which is what makes the
 * plan authoritative: `apply` switches on the disposition and never consults
 * the options the survey was run with.
 */
export type Disposition =
  | { readonly _tag: "Delete" }
  | {
      readonly _tag: "PruneOlderThan";
      /** The instant, resolved once at the command line, that selects the entries. */
      readonly cutoff: Cutoff.Cutoff;
    }
  | {
      readonly _tag: "ArchiveThenDelete";
      /** The untracked files to archive first, relative to the worktree. */
      readonly files: Worktree.NonEmptyArray<string>;
    }
  | {
      readonly _tag: "Keep";
      /** Why the target is being left alone. */
      readonly reason: string;
    };

/**
 * What a run does with every turbo cache it finds.
 *
 * A cache is derived data, so it is never archived and never kept; narrowing
 * the type says so once instead of leaving two impossible cases to handle.
 */
export type CacheDisposition = Extract<Disposition, { readonly _tag: "Delete" | "PruneOlderThan" }>;

/**
 * A target paired with the action decided for it.
 *
 * @template D - The dispositions this entry may carry.
 */
export type PlanEntry<D extends Disposition = Disposition> = {
  /** The target under consideration. */
  readonly target: ReclaimTarget;
  /** What to do with it. */
  readonly disposition: D;
};

/** An entry whose action frees space. Never a kept one, by type. */
export type ReclaimingEntry = PlanEntry<Exclude<Disposition, { readonly _tag: "Keep" }>>;

/** An entry deliberately left alone, carrying the reason it was spared. */
export type KeptEntry = PlanEntry<Extract<Disposition, { readonly _tag: "Keep" }>>;

/** The full set of decisions, with totals. */
export type Plan = {
  /** Entries whose disposition frees space. */
  readonly reclaiming: ReadonlyArray<ReclaimingEntry>;
  /** Entries deliberately left alone. */
  readonly keeping: ReadonlyArray<KeptEntry>;
  /** Directories the scan could not examine, reported and left alone. */
  readonly unexamined: ReadonlyArray<Unexamined>;
  /** Total size the reclaiming entries would free. */
  readonly reclaimable: Kilobytes.Kilobytes;
  /**
   * Repositories whose stale worktree registrations would be pruned once the
   * entries are gone: exactly the ones that own a worktree this plan removes,
   * and never a repository the report did not name.
   *
   * What `apply` actually prunes is derived the same way from the entries it
   * managed to carry out, so a repository whose worktree was refused keeps its
   * registration - and the set that runs is a subset of the set shown here.
   */
  readonly pruning: ReadonlyArray<string>;
};

/**
 * Directory names whose contents a build or an install recreates.
 *
 * The one piece of judgement the ignored category needs. `.gitignore` says
 * "git should not record this", which covers two unrelated things: output a
 * command regenerates, and local state that exists nowhere else. Archiving
 * everything ignored would sweep a worktree's `node_modules` into a tarball on
 * every run; archiving nothing ignored destroys `.env`. So the ignored paths
 * are split here, by name, and only the rest is worth carrying out.
 *
 * Exported so the policy is reviewable rather than buried. Matching is by path
 * segment, so `node_modules/`, `packages/app/node_modules/` and `.turbo/cache/`
 * are all regenerable while `.env` and `.claude/settings.local.json` are not.
 */
export const REGENERABLE: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
]);

/**
 * Keep only the ignored paths that nothing would bring back.
 *
 * @param ignored - Every path git was told to ignore.
 * @returns The ones a rebuild would not recreate.
 */
function irreplaceable(ignored: ReadonlyArray<string>): ReadonlyArray<string> {
  return ignored.filter((path) => !path.split("/").some((segment) => REGENERABLE.has(segment)));
}

/**
 * Decide how to remove a worktree, given everything removing it would destroy.
 *
 * One place decides "archive or not", so the two cases that can produce an
 * empty list cannot answer it differently.
 *
 * @param losing - The paths that exist only inside the worktree.
 * @returns A plain delete when nothing would be lost, and an archive first otherwise.
 */
function removing(losing: ReadonlyArray<string>): Disposition {
  const [first, ...rest] = losing;

  return first === undefined
    ? { _tag: "Delete" }
    : { _tag: "ArchiveThenDelete", files: [first, ...rest] };
}

/**
 * Decide what to do with a worktree in a given state.
 *
 * Total over the union, and a worktree is deleted outright only when nothing
 * it holds would be lost: a worktree holding files git never recorded is
 * archived first — ignored ones included, unless a rebuild would recreate them
 * — and one holding modified tracked files is never touched.
 *
 * @param state - The classified worktree state.
 * @returns The disposition its state proves is safe.
 */
export function decideWorktree(state: Worktree.WorktreeState): Disposition {
  switch (state._tag) {
    case "Clean":
      return { _tag: "Delete" };

    case "IgnoredOnly":
      return removing(irreplaceable(state.ignored));

    case "UntrackedOnly":
      return removing([...state.files, ...irreplaceable(state.ignored)]);

    case "TrackedDirty":
      return {
        _tag: "Keep",
        reason: `${state.entries.length} modified tracked file(s)`,
      };

    default:
      return casesHandled(state);
  }
}

/**
 * Decide what to do with a single target.
 *
 * @param target - The scanned target.
 * @param caches - What this run does with a turbo cache.
 * @returns The disposition for that target.
 */
function dispositionFor(target: ReclaimTarget, caches: CacheDisposition): Disposition {
  switch (target._tag) {
    case "TurboCache":
      return caches;

    case "AgentWorktree":
      return decideWorktree(target.state);

    default:
      return casesHandled(target);
  }
}

/**
 * Name the repositories that own the worktrees this plan removes.
 *
 * `git worktree prune` is the one thing `apply` does that is not an entry, and
 * it mutates the repository rather than the worktree - so the repositories are
 * derived from the entries themselves. Exactly the repositories losing a
 * registration are named, which is short enough for the report to list them
 * rather than count them.
 *
 * The same function answers both "which repositories would this plan prune"
 * and, once the run is over, "which of them actually lost a worktree" — so the
 * set `apply` prunes is a subset of the set the report named, by construction
 * rather than by two derivations agreeing.
 *
 * @param reclaiming - The entries whose targets are being removed.
 * @returns Each owning repository once, in a stable order.
 */
export function owningRepositories(
  reclaiming: ReadonlyArray<ReclaimingEntry>,
): ReadonlyArray<string> {
  const repositories = new Set<string>();

  for (const { target } of reclaiming) {
    if (target._tag === "AgentWorktree") {
      repositories.add(target.repository);
    }
  }

  return [...repositories].toSorted();
}

/**
 * Build a plan from what the scans established, dropping empty targets.
 *
 * @param scanned - Everything the scans found, examined or not.
 * @param caches - What this run does with a turbo cache, resolved before the scan ran.
 * @returns The partitioned plan and its total.
 */
export function make(scanned: ReadonlyArray<Scanned>, caches: CacheDisposition): Plan {
  const reclaiming: Array<ReclaimingEntry> = [];
  const keeping: Array<KeptEntry> = [];
  const unexamined: Array<Unexamined> = [];

  for (const result of scanned) {
    if (result._tag === "Unexamined") {
      unexamined.push(result);
      continue;
    }

    const { target } = result;

    if (!Kilobytes.isSignificant(target.size)) {
      continue;
    }

    const disposition = dispositionFor(target, caches);

    if (disposition._tag === "Keep") {
      keeping.push({ target, disposition });
    } else {
      reclaiming.push({ target, disposition });
    }
  }

  reclaiming.sort((left, right) => right.target.size - left.target.size);

  return {
    reclaiming,
    keeping,
    unexamined,
    reclaimable: Kilobytes.sum(reclaiming.map((entry) => entry.target.size)),
    pruning: owningRepositories(reclaiming),
  };
}
