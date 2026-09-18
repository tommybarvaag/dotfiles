/**
 * The command-line boundary: flags in, rendered report out.
 *
 * This module owns argument shapes and presentation only. It makes no decision
 * about what is safe to delete; that lives in the domain, and the choice of
 * whether to delete at all is expressed by which service function it calls.
 * What it does own is resolving `--age` into the one cutoff instant the rest
 * of the run uses.
 */
import { Clock, Console, Effect, Option, Stdio } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { homedir } from "node:os";
import { join } from "node:path";
import { casesHandled } from "./defect.ts";
import * as Cutoff from "./domain/cutoff.ts";
import * as Kilobytes from "./domain/kilobytes.ts";
import { CommandFailed } from "./errors.ts";
import type * as Plan from "./domain/plan.ts";
import { describe } from "./domain/worktree.ts";
import { ScanProgress } from "./ports.ts";
import * as Reclaim from "./reclaim.ts";

/** Whether this run only reports, or acts on what it reports. */
type Run = "dry-run" | "apply";

/** Whether this run asks before deleting, or was told not to. */
type Asking = "ask" | "assume-yes";

/**
 * What asking about a deletion established.
 *
 * Three outcomes, not two: a run that could not ask is not a run whose user
 * said no. Declining is a choice and succeeds; having nobody to ask is a
 * scheduled `--apply` that reclaimed nothing, which the shell has to see.
 */
type Confirmation = "Confirmed" | "Declined" | "NoTerminal";

/** Widest size rendered, used to align the report columns. */
const SIZE_COLUMN = 10;

/** Widest action label rendered beside a path. */
const ACTION_COLUMN = 16;

/** What the report calls a row it is leaving alone. */
const KEEP = "KEEP";

/**
 * Name the action a disposition performs.
 *
 * @param disposition - The decided action.
 * @returns The label for its report row.
 */
function label(disposition: Plan.Disposition): string {
  switch (disposition._tag) {
    case "Delete":
      return "delete";

    case "PruneOlderThan":
      return "prune";

    case "ArchiveThenDelete":
      return "archive + delete";

    case "Keep":
      return KEEP;

    default:
      return casesHandled(disposition);
  }
}

/**
 * Explain a row: why a target is being kept, or which part of it goes.
 *
 * @param entry - The entry being rendered.
 * @returns The parenthesised note, or an empty string when the label says it all.
 */
function detail(entry: Plan.PlanEntry): string {
  const { target, disposition } = entry;

  switch (disposition._tag) {
    case "Keep":
      return ` (${disposition.reason})`;

    case "PruneOlderThan":
      return ` (entries last modified before ${Cutoff.format(disposition.cutoff)})`;

    case "Delete":
    case "ArchiveThenDelete":
      return target._tag === "AgentWorktree" ? ` (${describe(target.state)})` : "";

    default:
      return casesHandled(disposition);
  }
}

/**
 * Lay out one report row.
 *
 * @param size - The rendered size, right-aligned in its column. Empty for a row that frees nothing.
 * @param action - What happens, left-aligned in its column.
 * @param subject - What it happens to.
 * @returns The formatted line.
 */
function row(size: string, action: string, subject: string): string {
  return `  ${size.padStart(SIZE_COLUMN)}  ${action.padEnd(ACTION_COLUMN)} ${subject}`;
}

/**
 * Render one planned entry as a report row.
 *
 * @param entry - The entry to render.
 * @returns The formatted line.
 */
function renderRow(entry: Plan.PlanEntry): string {
  return row(
    Kilobytes.format(entry.target.size),
    label(entry.disposition),
    `${entry.target.path}${detail(entry)}`,
  );
}

/**
 * Render a directory the scan could not examine.
 *
 * The size column is left empty rather than filled with a zero, because the
 * size is precisely what is not known.
 *
 * @param unexamined - The directory and why it was skipped.
 * @returns The formatted line.
 */
function renderUnexamined(unexamined: Plan.Unexamined): string {
  return row("", KEEP, `${unexamined.path} (${unexamined.reason})`);
}

/**
 * Head the report with what the run is about to do.
 *
 * @param run - Whether the run acts or only reports.
 * @returns The banner line.
 */
function banner(run: Run): string {
  switch (run) {
    case "dry-run":
      return "=== reclaim-disk [DRY RUN] ===";

    case "apply":
      return "=== reclaim-disk [APPLY] ===";

    default:
      return casesHandled(run);
  }
}

/**
 * Print the plan.
 *
 * Everything `apply` would do appears here, including the repositories whose
 * stale worktree registrations it would prune, so confirming the report cannot
 * authorise a mutation the report did not mention.
 *
 * @param plan - The plan to render.
 * @param run - Whether the run acts on the plan or only reports it.
 */
const reportPlan = Effect.fn("Cli.reportPlan")(function* (plan: Plan.Plan, run: Run) {
  yield* Console.log(banner(run));
  yield* Console.log("");

  if (plan.reclaiming.length === 0) {
    yield* Console.log("Nothing to reclaim.");
  } else {
    for (const entry of plan.reclaiming) {
      yield* Console.log(renderRow(entry));
    }
  }

  // Named, not counted: the repositories are exactly the ones that own a
  // worktree above, so confirming this report cannot authorise `git worktree
  // prune` in a repository the report did not show.
  for (const repository of plan.pruning) {
    yield* Console.log(row("", "then", `git worktree prune in ${repository}`));
  }

  if (plan.keeping.length > 0 || plan.unexamined.length > 0) {
    yield* Console.log("");
    yield* Console.log("Left alone:");

    for (const entry of plan.keeping) {
      yield* Console.log(renderRow(entry));
    }

    for (const unexamined of plan.unexamined) {
      yield* Console.log(renderUnexamined(unexamined));
    }
  }

  yield* Console.log("");
  yield* Console.log(`reclaimable total: ${Kilobytes.format(plan.reclaimable)}`);
});

/**
 * Name what a refusal left behind.
 *
 * A removal denied partway through leaves everything it had already unlinked
 * gone, so calling that "refused" would tell the user the target is intact when
 * it is not.
 *
 * @param remains - What survived the failure.
 * @returns The label heading its line in the outcome.
 */
function refusalLabel(remains: Reclaim.Remains): string {
  switch (remains) {
    case "Untouched":
      return "refused";

    case "PartiallyRemoved":
      return "partially removed";

    default:
      return casesHandled(remains);
  }
}

/**
 * Print what actually happened.
 *
 * The archive paths come first because they are the point: a worktree that was
 * archived no longer exists, so this line is the only pointer the user has to
 * the files that were inside it. Refusals follow, because a confirmed plan
 * that was not carried out in full is something the user has to see.
 *
 * @param outcome - The result of applying the plan.
 */
const reportOutcome = Effect.fn("Cli.reportOutcome")(function* (outcome: Reclaim.Outcome) {
  yield* Console.log("");

  for (const archive of outcome.archives) {
    yield* Console.log(`archived: ${archive}`);
  }

  for (const refusal of outcome.refused) {
    // A refusal that already wrote an archive names it on its own line: the
    // files it holds are gone from disk, so the reader needs the two together.
    const receipt = Option.match(refusal.archive, {
      onNone: () => "",
      onSome: (archive) => ` - recover from ${archive}`,
    });

    yield* Console.log(
      `${refusalLabel(refusal.remains)}: ${refusal.path} (${refusal.reason})${receipt}`,
    );
  }

  const freed = Option.match(outcome.freed, {
    onNone: () => "unknown",
    onSome: Kilobytes.format,
  });

  yield* Console.log(`removed ${outcome.removed} target(s)`);
  yield* Console.log(`freed:   ${freed}`);
});

/**
 * Translate the `--only` flag into a selection.
 *
 * @param only - The validated flag value.
 * @returns The corresponding selection.
 */
function toSelection(only: "all" | "turbo" | "worktrees"): Reclaim.Selection {
  switch (only) {
    case "all":
      return "all";

    case "turbo":
      return "turbo-only";

    case "worktrees":
      return "worktrees-only";

    default:
      return casesHandled(only);
  }
}

/**
 * Translate the `--age` flag into what this run does with every cache it finds.
 *
 * This is where a day count stops being a day count: `--age 30` is resolved
 * against one instant here, and the resolved decision is what the survey, the
 * report, the prompt, and the deletion all see.
 *
 * @param age - The validated flag value, absent when whole caches are wanted.
 * @param now - The instant the run started.
 * @returns Deleting each cache whole, or pruning the entries the cutoff selects.
 */
function toCacheDisposition(
  age: Option.Option<Cutoff.AgeInDays>,
  now: Date,
): Plan.CacheDisposition {
  return Option.match(age, {
    onNone: (): Plan.CacheDisposition => ({ _tag: "Delete" }),
    onSome: (days): Plan.CacheDisposition => ({
      _tag: "PruneOlderThan",
      cutoff: Cutoff.before(now, days),
    }),
  });
}

/**
 * Ask before deleting, unless the caller already said yes.
 *
 * Without a terminal there is nobody to ask, and silently proceeding would let
 * a scheduled run delete hundreds of gigabytes with no acknowledgement — so a
 * non-interactive run must pass `--yes` explicitly and is refused otherwise.
 * Declining and being interrupted are both a considered "no".
 *
 * This only establishes which of the three happened; what each one means for
 * the run, and for its exit code, is the caller's to decide and to print.
 *
 * @param plan - The plan awaiting confirmation.
 * @param asking - Whether this run asks at all.
 * @returns What the confirmation established.
 */
const confirmDeletion = Effect.fn("Cli.confirmDeletion")(function* (
  plan: Plan.Plan,
  asking: Asking,
) {
  if (asking === "assume-yes") {
    return "Confirmed" as const;
  }

  const stdio = yield* Stdio.Stdio;

  if (!(yield* stdio.stdinIsTerminal)) {
    return "NoTerminal" as const;
  }

  const confirmed = yield* Prompt.Confirm({
    message: `Delete ${plan.reclaiming.length} target(s), freeing ${Kilobytes.format(plan.reclaimable)}?`,
    initial: false,
  }).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));

  return confirmed ? ("Confirmed" as const) : ("Declined" as const);
});

/**
 * End the run non-zero, after saying why in one line.
 *
 * This is the whole of this tool's boundary translation: an expected failure
 * becomes a sentence on stderr and an exit code, never an Effect cause block
 * printed under an empty message. Stderr rather than stdout, so piped output is
 * still the report alone.
 *
 * @param summary - What stopped the run.
 * @returns Never succeeds.
 */
const stop = Effect.fn("Cli.stop")(function* (summary: string) {
  yield* Console.error(`error: ${summary}`);

  return yield* Effect.fail(new CommandFailed({ summary }));
});

const runFlag = Flag.Boolean("apply").pipe(
  Flag.withDefault(false),
  Flag.map((requested): Run => (requested ? "apply" : "dry-run")),
  Flag.withDescription("Actually delete. Without this the run only reports."),
);

const ageFlag = Flag.Int("age").pipe(
  Flag.filterMap(
    Cutoff.parseAgeInDays,
    (days) => `--age must be a whole number of days of at least 1, but was ${days}.`,
  ),
  Flag.optional,
  Flag.withDescription(
    "Only consider turbo cache entries older than this many days. Omit to take whole caches.",
  ),
);

const onlyFlag = Flag.Literals("only", ["all", "turbo", "worktrees"]).pipe(
  Flag.withDefault("all" as const),
  Flag.withDescription("Which categories to consider."),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDefault(false),
  Flag.map((given): Asking => (given ? "assume-yes" : "ask")),
  Flag.withDescription("Skip the confirmation prompt. Required when stdin is not a terminal."),
);

const sourceRootFlag = Flag.String("source-root").pipe(
  Flag.withDefault(join(homedir(), "src")),
  Flag.withDescription("Root containing the repositories whose turbo caches are scanned."),
);

const worktreeRootFlag = Flag.String("worktree-root").pipe(
  Flag.withDefault(join(homedir(), ".grok", "worktrees")),
  Flag.withDescription("Root containing agent worktrees."),
);

/**
 * The `reclaim-disk` command.
 *
 * Planning always runs and is always reported. Deletion happens only when
 * `--apply` is present, and the plan is printed before anything is removed.
 */
export const reclaimDisk = Command.make(
  "reclaim-disk",
  {
    run: runFlag,
    yes: yesFlag,
    age: ageFlag,
    only: onlyFlag,
    sourceRoot: sourceRootFlag,
    worktreeRoot: worktreeRootFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const progress = yield* ScanProgress;
      const now = new Date(yield* Clock.currentTimeMillis);

      const options: Reclaim.SurveyOptions = {
        sourceRoot: config.sourceRoot,
        worktreeRoot: config.worktreeRoot,
        selection: toSelection(config.only),
        caches: toCacheDisposition(config.age, now),
      };

      // Runs on interruption too, so Ctrl+C never leaves a half-drawn line.
      // A root that cannot be scanned ends the run here, named in one line,
      // rather than reaching the runtime as a stack trace.
      const plan = yield* Reclaim.survey(options).pipe(
        Effect.ensuring(progress.done),
        Effect.catchTag("ScanFailed", (failure) => stop(failure.message)),
      );

      yield* reportPlan(plan, config.run);

      if (config.run === "dry-run") {
        yield* Console.log("(dry run - re-run with --apply to delete)");

        return;
      }

      if (plan.reclaiming.length === 0) {
        return;
      }

      const confirmation: Confirmation = yield* confirmDeletion(plan, config.yes);

      switch (confirmation) {
        case "Confirmed":
          break;

        case "Declined":
          yield* Console.log("Aborted. Nothing was deleted.");

          return;

        // Nothing was reclaimed and nobody chose that, which a scheduled run
        // has to learn from its exit code rather than from a success.
        case "NoTerminal":
          return yield* stop("refusing to delete without confirmation; re-run with --yes");

        default:
          return casesHandled(confirmation);
      }

      const outcome = yield* Reclaim.apply(plan).pipe(
        Effect.ensuring(progress.done),
        Effect.catchTag("SizeUnavailable", (failure) => stop(failure.message)),
      );

      yield* reportOutcome(outcome);

      // Every refusal has just been printed with its reason, so this carries
      // no information beyond the exit code — which a script driving `--apply
      // --yes` still needs, because "two of the ten worktrees are still there"
      // is not success.
      if (outcome.refused.length > 0) {
        return yield* Effect.fail(
          new CommandFailed({ summary: `${outcome.refused.length} entry(s) not carried out` }),
        );
      }
    }),
).pipe(
  Command.withDescription(
    "Reclaim disk space from regenerable build caches and abandoned agent worktrees.",
  ),
);
