/**
 * What the working tree of an agent worktree holds.
 *
 * This is the safety core of the tool. Modelling the state as a tagged union
 * rather than a set of booleans makes "delete a worktree that still holds
 * modified tracked files" unrepresentable: the state is what a worktree is,
 * and `Plan.decideWorktree` is total over it, so no caller can act on a
 * worktree without having been told which of the four it is looking at.
 *
 * Four, not three. A path git was told to ignore is still a path git never
 * recorded, and it is the common case here: agent setup scripts write `.env`,
 * `.env.local` and `.claude/settings.local.json` into a checkout, all of them
 * gitignored by design. A plain `git status --porcelain` never mentions them,
 * so a worktree holding nothing but an ignored secret used to classify as
 * `Clean` and be deleted with no archive — the exact loss this tool exists to
 * prevent. The totality of the union was real; the *input* to it was not.
 *
 * Ignored paths are carried, not decided on: `node_modules/` is ignored and
 * regenerable while `.env` is ignored and irreplaceable, and which is which is
 * policy. That split lives in `plan.ts`, where every other policy lives.
 */
import { casesHandled } from "../defect.ts";

/** A list guaranteed to hold at least one element. */
export type NonEmptyArray<A> = readonly [A, ...ReadonlyArray<A>];

/**
 * What a worktree's `git status --porcelain -z --ignored=matching` output
 * proves about it.
 *
 * - `Clean` - git recorded everything in it; nothing is lost by removing it.
 * - `IgnoredOnly` - holds only paths matching an ignore rule. Some of those
 *   are regenerable and some are the only copy, so the plan decides.
 * - `UntrackedOnly` - holds files git never recorded, so deleting destroys the
 *   only copy. Recoverable by archiving first. May hold ignored paths too.
 * - `TrackedDirty` - holds edits to committed files. Never deleted by this
 *   tool; a human decides.
 */
export type WorktreeState =
  | { readonly _tag: "Clean" }
  | {
      readonly _tag: "IgnoredOnly";
      /** The ignored paths, relative to the worktree. Directories end in `/`. */
      readonly ignored: NonEmptyArray<string>;
    }
  | {
      readonly _tag: "UntrackedOnly";
      /** The untracked paths, relative to the worktree. */
      readonly files: NonEmptyArray<string>;
      /** The ignored paths alongside them, relative to the worktree. */
      readonly ignored: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "TrackedDirty";
      /** The porcelain records describing the modified tracked paths. */
      readonly entries: NonEmptyArray<string>;
    };

/**
 * What inspecting an agent worktree established about it.
 *
 * Both facts are parsed rather than assumed. The owning repository comes from
 * the worktree itself, so `git worktree prune` can be aimed at exactly the
 * repositories losing a registration; and a value of this type exists only
 * once the directory has been shown to be a *linked* worktree of that
 * repository, rather than a clone or a subdirectory that merely sat at the
 * right depth.
 */
export type Inspection = {
  /** Working directory of the repository that owns the worktree. */
  readonly repository: string;
  /** What the worktree's git status proves about it. */
  readonly state: WorktreeState;
};

/** The clean state, shared because it carries no data. */
export const clean: WorktreeState = { _tag: "Clean" };

/**
 * The status code porcelain v1 gives an untracked path, and the space after it.
 *
 * A record is two status characters, one space, then the path, so this is also
 * where the path starts.
 */
const UNTRACKED = "?? ";

/** The status code porcelain v1 gives a path matching an ignore rule. */
const IGNORED = "!! ";

/** Index or worktree statuses whose origin path follows in a record of its own. */
const ORIGIN_FOLLOWS: ReadonlySet<string> = new Set(["R", "C"]);

/**
 * Whether a record is a rename or copy, which spells two paths rather than one.
 *
 * @param record - The porcelain record, status characters included.
 * @returns `true` when the next record is this record's origin path.
 */
function originFollows(record: string): boolean {
  return ORIGIN_FOLLOWS.has(record.slice(0, 1)) || ORIGIN_FOLLOWS.has(record.slice(1, 2));
}

/**
 * Narrow a list to one the type can prove holds something.
 *
 * @param values - The list to narrow.
 * @returns The same values, or `undefined` when there are none.
 */
function nonEmpty(values: ReadonlyArray<string>): NonEmptyArray<string> | undefined {
  const [first, ...rest] = values;

  return first === undefined ? undefined : [first, ...rest];
}

/**
 * Classify a worktree from the records of `git status --porcelain -z --ignored=matching`.
 *
 * Records, not lines, and the difference is load-bearing: without `-z` git
 * applies C-style quoting to any path holding a space, a quote, a backslash or
 * a non-ASCII byte, so `notes æ.md` arrives as `"notes \303\246.md"` - a name
 * no `tar` can stat. `-z` turns quoting off and terminates each record with a
 * NUL instead, so the bytes git printed are the bytes the path is made of, and
 * nothing here has to unquote or trim them.
 *
 * Porcelain v1 prefixes untracked entries with `??` and ignored ones with
 * `!!`; every other status code describes a tracked path that has been staged,
 * modified, renamed, or deleted.
 *
 * @param records - The raw porcelain records, in any order. Empty records are ignored.
 * @returns The state the records prove.
 */
export function classify(records: ReadonlyArray<string>): WorktreeState {
  const untracked: Array<string> = [];
  const ignored: Array<string> = [];
  const tracked: Array<string> = [];
  let index = 0;

  while (index < records.length) {
    const record = records[index] ?? "";
    index += 1;

    if (record === "") {
      continue;
    }

    if (record.startsWith(UNTRACKED)) {
      untracked.push(record.slice(UNTRACKED.length));
      continue;
    }

    if (record.startsWith(IGNORED)) {
      ignored.push(record.slice(IGNORED.length));
      continue;
    }

    tracked.push(record);

    if (originFollows(record)) {
      // A rename or copy spells its origin path in a record of its own, with
      // no status code in front of it. Consuming it here keeps it from being
      // counted as a second entry - or, if that path happens to begin with
      // `?? `, from being read as an untracked file and archived.
      index += 1;
    }
  }

  const dirty = nonEmpty(tracked);

  if (dirty !== undefined) {
    return { _tag: "TrackedDirty", entries: dirty };
  }

  const files = nonEmpty(untracked);

  if (files !== undefined) {
    return { _tag: "UntrackedOnly", files, ignored };
  }

  const onlyIgnored = nonEmpty(ignored);

  if (onlyIgnored !== undefined) {
    return { _tag: "IgnoredOnly", ignored: onlyIgnored };
  }

  return clean;
}

/**
 * Whether two readings of a worktree found the same working tree.
 *
 * Equality over the whole state rather than over the action it implies: a
 * worktree that gained an untracked file between the two readings still
 * implies "archive, then delete", but the archive would be built from the
 * older list and the delete would take the new file with it.
 *
 * @param left - One reading.
 * @param right - The other reading.
 * @returns `true` when both readings hold exactly the same entries.
 */
export function equals(left: WorktreeState, right: WorktreeState): boolean {
  switch (left._tag) {
    case "Clean":
      return right._tag === "Clean";

    case "IgnoredOnly":
      return right._tag === "IgnoredOnly" && sameEntries(left.ignored, right.ignored);

    case "UntrackedOnly":
      return (
        right._tag === "UntrackedOnly" &&
        sameEntries(left.files, right.files) &&
        sameEntries(left.ignored, right.ignored)
      );

    case "TrackedDirty":
      return right._tag === "TrackedDirty" && sameEntries(left.entries, right.entries);

    default:
      return casesHandled(left);
  }
}

/**
 * Compare two lists of porcelain entries element by element.
 *
 * @param left - One list.
 * @param right - The other list.
 * @returns `true` when both hold the same entries in the same order.
 */
function sameEntries(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((entry, at) => entry === right[at]);
}

/**
 * Describe a state in one short phrase for the report.
 *
 * Ignored paths are counted out loud rather than folded into "clean": a human
 * confirming the deletion of a worktree that holds an ignored `.env` has to be
 * able to see that it holds something.
 *
 * @param state - The classified worktree state.
 * @returns A human-readable label.
 */
export function describe(state: WorktreeState): string {
  switch (state._tag) {
    case "Clean":
      return "clean";

    case "IgnoredOnly":
      return `${state.ignored.length} ignored path(s)`;

    case "UntrackedOnly": {
      const alongside =
        state.ignored.length === 0 ? "" : `, ${state.ignored.length} ignored path(s)`;

      return `${state.files.length} untracked file(s)${alongside}`;
    }

    case "TrackedDirty":
      return `${state.entries.length} modified tracked file(s)`;

    default:
      return casesHandled(state);
  }
}
