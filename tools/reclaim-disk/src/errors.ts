/**
 * Expected failures crossing this tool's boundaries.
 *
 * Each carries the path and operation that produced it so a failure names the
 * directory a human has to look at. Causes are reduced to their message text:
 * nothing here handles credentials, and a stringified cause keeps the errors
 * serializable.
 */
import { Schema } from "effect";

/** A directory scan could not be completed. */
export class ScanFailed extends Schema.TaggedError<ScanFailed>()("ScanFailed", {
  /** The root the scan started from. */
  root: Schema.String,
  /** What was being looked for. */
  looking_for: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {}

/** A size could not be measured. */
export class SizeUnavailable extends Schema.TaggedError<SizeUnavailable>()("SizeUnavailable", {
  /** The path being measured. */
  path: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {}

/** A worktree's git status could not be read, so its safety cannot be established. */
export class WorktreeStatusUnavailable extends Schema.TaggedError<WorktreeStatusUnavailable>()(
  "WorktreeStatusUnavailable",
  {
    /** The worktree whose status failed. */
    path: Schema.String,
    /** The underlying failure message. */
    cause: Schema.String,
  },
) {}

/** Untracked files could not be archived, so the worktree must not be deleted. */
export class ArchiveFailed extends Schema.TaggedError<ArchiveFailed>()("ArchiveFailed", {
  /** The worktree whose files were being archived. */
  path: Schema.String,
  /** Where the archive was to be written. */
  destination: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {}

/** A path could not be removed. */
export class RemoveFailed extends Schema.TaggedError<RemoveFailed>()("RemoveFailed", {
  /** The path that survived. */
  path: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {}

/** Stale git worktree registrations could not be pruned. */
export class PruneFailed extends Schema.TaggedError<PruneFailed>()("PruneFailed", {
  /** The repository whose registrations were being pruned. */
  repository: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {}

/**
 * Reduce an unknown thrown value to a message safe to put in a typed error.
 *
 * @param cause - The value a `catch` produced.
 * @returns The cause's message, or its string form.
 */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
