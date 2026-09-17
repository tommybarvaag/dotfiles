/**
 * The working-tree state of an agent worktree, and the deletion policy derived
 * from it.
 *
 * This is the safety core of the tool. Modelling the state as a tagged union
 * rather than a pair of booleans makes "delete a worktree that still holds
 * modified tracked files" unrepresentable: `decide` is total over the union,
 * and the only state that yields `Delete` is `Clean`.
 */
import { casesHandled } from "../defect.ts";

/** A list guaranteed to hold at least one element. */
export type NonEmptyArray<A> = readonly [A, ...ReadonlyArray<A>];

/**
 * What a worktree's `git status --porcelain` output proves about it.
 *
 * - `Clean` - nothing to lose; safe to remove outright.
 * - `UntrackedOnly` - holds files git never recorded, so deleting destroys the
 *   only copy. Recoverable by archiving first.
 * - `TrackedDirty` - holds edits to committed files. Never deleted by this
 *   tool; a human decides.
 */
export type WorktreeState =
  | { readonly _tag: "Clean" }
  | { readonly _tag: "UntrackedOnly"; readonly files: NonEmptyArray<string> }
  | { readonly _tag: "TrackedDirty"; readonly entries: NonEmptyArray<string> };

/** What this tool should do with a worktree. */
export type Disposition =
  | { readonly _tag: "Delete" }
  | { readonly _tag: "ArchiveThenDelete"; readonly files: NonEmptyArray<string> }
  | { readonly _tag: "Keep"; readonly reason: string };

/** The clean state, shared because it carries no data. */
export const clean: WorktreeState = { _tag: "Clean" };

/**
 * Classify a worktree from the lines of `git status --porcelain`.
 *
 * Porcelain v1 prefixes untracked entries with `??`; every other status code
 * describes a tracked path that has been staged, modified, renamed, or deleted.
 *
 * @param lines - The raw porcelain lines, in any order. Blank lines are ignored.
 * @returns The state the lines prove.
 */
export function classify(lines: ReadonlyArray<string>): WorktreeState {
  const untracked: Array<string> = [];
  const tracked: Array<string> = [];

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }

    if (line.startsWith("??")) {
      untracked.push(line.slice(2).trim());
    } else {
      tracked.push(line.trim());
    }
  }

  const [firstTracked, ...restTracked] = tracked;

  if (firstTracked !== undefined) {
    return { _tag: "TrackedDirty", entries: [firstTracked, ...restTracked] };
  }

  const [firstUntracked, ...restUntracked] = untracked;

  if (firstUntracked !== undefined) {
    return { _tag: "UntrackedOnly", files: [firstUntracked, ...restUntracked] };
  }

  return clean;
}

/**
 * Decide what to do with a worktree in a given state.
 *
 * @param state - The classified worktree state.
 * @returns The disposition; only `Clean` ever yields an unconditional delete.
 */
export function decide(state: WorktreeState): Disposition {
  switch (state._tag) {
    case "Clean":
      return { _tag: "Delete" };

    case "UntrackedOnly":
      return { _tag: "ArchiveThenDelete", files: state.files };

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
 * Describe a state in one short phrase for the report.
 *
 * @param state - The classified worktree state.
 * @returns A human-readable label.
 */
export function describe(state: WorktreeState): string {
  switch (state._tag) {
    case "Clean":
      return "clean";

    case "UntrackedOnly":
      return `${state.files.length} untracked file(s)`;

    case "TrackedDirty":
      return `${state.entries.length} modified tracked file(s)`;

    default:
      return casesHandled(state);
  }
}
