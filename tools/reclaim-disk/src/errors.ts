/**
 * Expected failures crossing this tool's boundaries.
 *
 * Each carries the path and operation that produced it, and renders them into
 * its `message`, so a failure that reaches a human names the directory they
 * have to look at without anyone having to dig a cause out of a stack trace.
 * Causes are reduced to their message text: nothing here handles credentials,
 * and a stringified cause keeps the errors serializable.
 *
 * The report renders these differently - as a clause under a path it has
 * already printed in its own column - so `reclaim.ts` owns that second, shorter
 * phrasing. These messages are for the failures that escape with no report
 * around them.
 */
import { Runtime, Schema } from "effect";

/** A directory scan could not be completed. */
export class ScanFailed extends Schema.TaggedError<ScanFailed>()("ScanFailed", {
  /** The root the scan started from. */
  root: Schema.String,
  /** What was being looked for. */
  lookingFor: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {
  /** Names the root, what it was being searched for, and why the search stopped. */
  override get message(): string {
    return `could not scan ${this.root} looking for ${this.lookingFor}: ${this.cause}`;
  }
}

/** A size could not be measured. */
export class SizeUnavailable extends Schema.TaggedError<SizeUnavailable>()("SizeUnavailable", {
  /** The path being measured. */
  path: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {
  /** Names the path that could not be measured, and why. */
  override get message(): string {
    return `could not measure ${this.path}: ${this.cause}`;
  }
}

/** A worktree's git status could not be read, so its safety cannot be established. */
export class WorktreeStatusUnavailable extends Schema.TaggedError<WorktreeStatusUnavailable>()(
  "WorktreeStatusUnavailable",
  {
    /** The worktree whose status failed. */
    path: Schema.String,
    /** The underlying failure message. */
    cause: Schema.String,
  },
) {
  /** Names the worktree whose status could not be read, and why. */
  override get message(): string {
    return `could not inspect ${this.path}: ${this.cause}`;
  }
}

/**
 * A directory sitting where a worktree would be is not a linked worktree.
 *
 * Depth alone says nothing: a standalone clone, a main checkout, or a plain
 * subdirectory of some ancestor repository all answer `git status` and
 * `git rev-parse` perfectly well. Treating one as a worktree would delete a
 * clone's object database — its unpushed commits with it — under a report
 * that called it clean, and would then run `git worktree prune` in whatever
 * repository the directory happened to sit inside. So being a linked worktree
 * of a named repository is parsed, and everything else becomes this.
 */
export class NotAWorktree extends Schema.TaggedError<NotAWorktree>()("NotAWorktree", {
  /** The directory that was examined. */
  path: Schema.String,
  /** What it turned out to be instead. */
  reason: Schema.String,
}) {
  /** Names the directory and what it turned out to be. */
  override get message(): string {
    return `${this.path} is not a linked worktree: ${this.reason}`;
  }
}

/**
 * A worktree stopped matching the survey that planned its removal.
 *
 * The plan is still authoritative: this is only ever a refusal to carry one
 * entry out, never a decision to do something the plan did not name. The
 * entries behind it are carried out as planned, and the refusal is reported
 * beside them.
 */
export class WorktreeChangedSinceSurvey extends Schema.TaggedError<WorktreeChangedSinceSurvey>()(
  "WorktreeChangedSinceSurvey",
  {
    /** The worktree that was left alone. */
    path: Schema.String,
    /** What the survey found when the plan was built. */
    was: Schema.String,
    /** What the worktree holds now. */
    now: Schema.String,
  },
) {
  /** Names the worktree and both readings of it. */
  override get message(): string {
    return `${this.path} changed since the survey: was ${this.was}, now ${this.now}`;
  }
}

/** Untracked files could not be archived, so the worktree must not be deleted. */
export class ArchiveFailed extends Schema.TaggedError<ArchiveFailed>()("ArchiveFailed", {
  /** The worktree whose files were being archived. */
  path: Schema.String,
  /** Where the archive was to be written. */
  destination: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {
  /** Names the worktree, where its archive was to go, and why it did not get there. */
  override get message(): string {
    return `could not archive ${this.path} to ${this.destination}: ${this.cause}`;
  }
}

/**
 * A path could not be removed, and may have been partly removed already.
 *
 * `rm -r` unlinks depth-first, so a denial partway through leaves everything it
 * had already removed gone. This is the one impediment in the tool that cannot
 * promise the target is as it was found, which is why the run reports it under
 * its own wording rather than as an ordinary refusal.
 */
export class RemoveFailed extends Schema.TaggedError<RemoveFailed>()("RemoveFailed", {
  /** The path that did not go away. */
  path: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {
  /** Names the path that could not be removed, and why. */
  override get message(): string {
    return `could not remove ${this.path}: ${this.cause}`;
  }
}

/** Stale git worktree registrations could not be pruned. */
export class PruneFailed extends Schema.TaggedError<PruneFailed>()("PruneFailed", {
  /** The repository whose registrations were being pruned. */
  repository: Schema.String,
  /** The underlying failure message. */
  cause: Schema.String,
}) {
  /** Names the repository whose registrations survived, and why. */
  override get message(): string {
    return `could not prune worktree registrations in ${this.repository}: ${this.cause}`;
  }
}

/**
 * The command printed why it could not finish, and the shell needs to know.
 *
 * This is the command line's translation of every expected failure into a CLI
 * outcome: whatever went wrong has already been rendered as one line on stderr,
 * or as `refused:` lines under the outcome, so the only thing left to carry is
 * the exit code. The `errorReported` marker is what stops the runtime printing
 * a second, uglier copy of a failure the user has already been shown.
 */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  /** The one line the command printed, so a log of the failure is not empty. */
  summary: Schema.String,
}) {
  /**
   * Tells the runtime this failure was already reported.
   *
   * Without it `runMain` logs the whole cause - a stack trace under an empty
   * message line - directly after the report that explained the problem.
   */
  override readonly [Runtime.errorReported] = false;

  /** The line the command printed. */
  override get message(): string {
    return this.summary;
  }
}

/**
 * Reduce an unknown thrown value to a message safe to put in a typed error.
 *
 * @param cause - The value a `catch` produced.
 * @returns The cause's message, or its string form.
 */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
