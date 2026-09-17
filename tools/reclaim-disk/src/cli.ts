/**
 * The command-line boundary: flags in, rendered report out.
 *
 * This module owns argument shapes and presentation only. It makes no decision
 * about what is safe to delete; that lives in the domain, and the choice of
 * whether to delete at all is expressed by which service function it calls.
 */
import { Console, Effect, Option, Stdio } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";
import { homedir } from "node:os";
import { join } from "node:path";
import { casesHandled } from "./defect.ts";
import * as Kilobytes from "./domain/kilobytes.ts";
import type * as Plan from "./domain/plan.ts";
import { describe } from "./domain/worktree.ts";
import { ScanProgress } from "./ports.ts";
import * as Reclaim from "./reclaim.ts";

/** Widest label rendered beside a path, used to align the report columns. */
const SIZE_COLUMN = 10;

/**
 * Render one planned entry as a report row.
 *
 * @param entry - The entry to render.
 * @returns The formatted line.
 */
function renderEntry(entry: Plan.PlanEntry): string {
  const size = Kilobytes.format(entry.target.size).padStart(SIZE_COLUMN);
  const { target, disposition } = entry;

  const detail =
    target._tag === "AgentWorktree"
      ? ` (${describe(target.state)})`
      : target.prunedByAge
        ? " (stale entries only)"
        : "";

  const prefix = disposition._tag === "ArchiveThenDelete" ? "archive + delete" : "delete";

  return `  ${size}  ${prefix.padEnd(16)} ${target.path}${detail}`;
}

/**
 * Render a kept entry, which is reported but never touched.
 *
 * @param entry - The entry being kept.
 * @returns The formatted line.
 */
function renderKept(entry: Plan.PlanEntry): string {
  const size = Kilobytes.format(entry.target.size).padStart(SIZE_COLUMN);
  const reason = entry.disposition._tag === "Keep" ? entry.disposition.reason : "kept";

  return `  ${size}  KEEP             ${entry.target.path} (${reason})`;
}

/**
 * Print the plan.
 *
 * @param plan - The plan to render.
 * @param applying - Whether the run will act on the plan.
 */
const reportPlan = Effect.fn("Cli.reportPlan")(function* (plan: Plan.Plan, applying: boolean) {
  yield* Console.log(applying ? "=== reclaim-disk [APPLY] ===" : "=== reclaim-disk [DRY RUN] ===");
  yield* Console.log("");

  if (plan.reclaiming.length === 0) {
    yield* Console.log("Nothing to reclaim.");
  } else {
    for (const entry of plan.reclaiming) {
      yield* Console.log(renderEntry(entry));
    }
  }

  if (plan.keeping.length > 0) {
    yield* Console.log("");
    yield* Console.log("Left alone:");

    for (const entry of plan.keeping) {
      yield* Console.log(renderKept(entry));
    }
  }

  yield* Console.log("");
  yield* Console.log(`reclaimable total: ${Kilobytes.format(plan.reclaimable)}`);
});

/**
 * Print what actually happened.
 *
 * @param outcome - The result of applying the plan.
 */
const reportOutcome = Effect.fn("Cli.reportOutcome")(function* (outcome: Reclaim.Outcome) {
  yield* Console.log("");

  for (const archive of outcome.archives) {
    yield* Console.log(`archived: ${archive}`);
  }

  yield* Console.log(`removed ${outcome.removed} target(s)`);
  yield* Console.log(`freed:   ${Kilobytes.format(outcome.freed)}`);
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
 * Ask before deleting, unless the caller already said yes.
 *
 * Without a terminal there is nobody to ask, and silently proceeding would let
 * a scheduled run delete hundreds of gigabytes with no acknowledgement — so a
 * non-interactive run must pass `--yes` explicitly and is refused otherwise.
 * Declining and being interrupted are both treated as "no".
 *
 * @param plan - The plan awaiting confirmation.
 * @param assumeYes - Whether `--yes` was given.
 * @returns Whether deletion should proceed.
 */
const confirmDeletion = Effect.fn("Cli.confirmDeletion")(function* (
  plan: Plan.Plan,
  assumeYes: boolean,
) {
  if (assumeYes) {
    return true;
  }

  const stdio = yield* Stdio.Stdio;

  if (!(yield* stdio.stdinIsTerminal)) {
    yield* Console.log("Refusing to delete without confirmation. Re-run with --yes.");

    return false;
  }

  return yield* Prompt.Confirm({
    message: `Delete ${plan.reclaiming.length} target(s), freeing ${Kilobytes.format(plan.reclaimable)}?`,
    initial: false,
  }).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
});

const applyFlag = Flag.Boolean("apply").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Actually delete. Without this the run only reports."),
);

const ageFlag = Flag.Int("age").pipe(
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
    apply: applyFlag,
    yes: yesFlag,
    age: ageFlag,
    only: onlyFlag,
    sourceRoot: sourceRootFlag,
    worktreeRoot: worktreeRootFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const progress = yield* ScanProgress;

      const options: Reclaim.SurveyOptions = {
        sourceRoot: config.sourceRoot,
        worktreeRoot: config.worktreeRoot,
        selection: toSelection(config.only),
        staleAfter: config.age,
      };

      // Runs on interruption too, so Ctrl+C never leaves a half-drawn line.
      const plan = yield* Reclaim.survey(options).pipe(Effect.ensuring(progress.done));
      yield* reportPlan(plan, config.apply);

      if (!config.apply) {
        yield* Console.log("(dry run - re-run with --apply to delete)");

        return;
      }

      if (plan.reclaiming.length === 0) {
        return;
      }

      if (!(yield* confirmDeletion(plan, config.yes))) {
        yield* Console.log("Aborted. Nothing was deleted.");

        return;
      }

      const outcome = yield* Reclaim.apply(plan, options).pipe(Effect.ensuring(progress.done));
      yield* reportOutcome(outcome);
    }),
).pipe(
  Command.withDescription(
    "Reclaim disk space from regenerable build caches and abandoned agent worktrees.",
  ),
);

