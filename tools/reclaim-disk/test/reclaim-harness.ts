/**
 * The survey and apply harness both end-to-end suites share.
 *
 * It runs the real application service over the real adapters, against a
 * temporary tree each suite creates and removes around every test. Nothing in
 * here is a test: the tree-independent helpers are exported as they are, and
 * the three that need the current test's tree are bound to it by `bindToTree`.
 */
import { Clock, Effect, Layer, Option } from "effect";
import { DiskInventoryLive, makeDiskMutator } from "../src/adapters/bun-disk.ts";
import { ScanProgressSilent } from "../src/adapters/terminal-progress.ts";
import * as Cutoff from "../src/domain/cutoff.ts";
import type * as Plan from "../src/domain/plan.ts";
import { type DiskInventory, type DiskMutator, ScanProgress } from "../src/ports.ts";
import * as Reclaim from "../src/reclaim.ts";
import { frozenClockAt, type TempTree } from "./temp-tree.ts";

/**
 * The read-only half of the machine, with progress suppressed.
 *
 * `survey` is run with nothing else in scope: no mutating capability exists in
 * its context, so "the survey deleted something" is not a failure this suite
 * has to catch - it is a program that would not compile.
 */
const Inventory = Layer.provide(DiskInventoryLive, ScanProgressSilent);

/** What a run with no `--age` does with every cache it finds. */
export const deleteCaches: Plan.CacheDisposition = { _tag: "Delete" };

/**
 * Resolve the default Vitest grace the way the command line does.
 *
 * Against the real clock rather than `RUN_AT`, because the fixtures are
 * backdated from the real clock too.
 *
 * @returns The instant one hour ago.
 */
function vitestStaleBefore(): Cutoff.Cutoff {
  return Cutoff.hoursBefore(new Date(), Option.getOrThrow(Cutoff.parseAgeInHours(1)));
}

/** The instant every applying run's clock is stopped at. */
const RUN_AT = new Date("2026-03-01T12:00:00Z");

/**
 * The single element of a collection, failing the test when there is not exactly one.
 *
 * @template A - The element type.
 * @param values - The collection to unwrap.
 * @returns Its only element.
 * @throws When the collection does not hold exactly one element.
 */
export function only<A>(values: ReadonlyArray<A>): A {
  const [first, ...rest] = values;

  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one element, got ${values.length}`);
  }

  return first;
}

/**
 * What a run with `--age` does, with the cutoff resolved as the command line resolves it.
 *
 * @param days - The age in days the flag carried.
 * @returns The disposition carrying the resolved cutoff.
 */
export function pruneOlderThan(days: number): Plan.CacheDisposition {
  return {
    _tag: "PruneOlderThan",
    cutoff: Cutoff.before(new Date(), Option.getOrThrow(Cutoff.parseAgeInDays(days))),
  };
}

/**
 * Run an effect that may only look at the machine.
 *
 * @template A - What the effect produces.
 * @template E - How it can fail.
 * @param effect - The effect to run.
 * @returns Its result.
 */
export function looking<A, E>(effect: Effect.Effect<A, E, DiskInventory>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Inventory)));
}

/** Survey the tree, with only the read-only capability in scope. */
export function survey(options: Reclaim.SurveyOptions): Promise<Plan.Plan> {
  return looking(Reclaim.survey(options));
}

/**
 * Survey the tree, recording what the inventory told the progress port.
 *
 * A plan is deduplicated, so it cannot say how often a root was walked; the
 * progress port is told which roots each search walks and every match it
 * reaches, which is what lets a test prove a root was walked once rather than
 * walked twice and merged.
 *
 * @param options - Where to look and what to consider.
 * @returns The plan, the roots each search walked, and each path reported as found.
 */
export async function surveyRecording(options: Reclaim.SurveyOptions): Promise<{
  readonly plan: Plan.Plan;
  readonly walked: ReadonlyArray<ReadonlyArray<string>>;
  readonly found: ReadonlyArray<string>;
}> {
  const walked: Array<ReadonlyArray<string>> = [];
  const found: Array<string> = [];
  const recording = Layer.succeed(
    ScanProgress,
    ScanProgress.of({
      scanning: (_lookingFor, roots) =>
        Effect.sync(() => {
          walked.push(roots);
        }),
      found: (path) =>
        Effect.sync(() => {
          found.push(path);
        }),
      measured: () => Effect.void,
      done: Effect.void,
    }),
  );

  const plan = await Effect.runPromise(
    Reclaim.survey(options).pipe(Effect.provide(Layer.provide(DiskInventoryLive, recording))),
  );

  return { plan, walked, found };
}

/**
 * The single refusal a run reported, failing the test when there is not exactly one.
 *
 * A refusal is an ordinary outcome rather than a failed effect: the entries
 * behind it were confirmed too, and the archives already written are the only
 * pointer to files whose worktrees are gone.
 *
 * @param outcome - What the run reported.
 * @returns The one refusal it carried.
 */
export function refusal(outcome: Reclaim.Outcome): Reclaim.Refusal {
  return only(outcome.refused);
}

/** The helpers that act on the current test's tree. */
export type TreeHarness = {
  /** The options a run of the tool would have, pointed at the tree. */
  readonly surveying: (
    selection: Reclaim.Selection,
    caches: Plan.CacheDisposition,
  ) => Reclaim.SurveyOptions;
  /** Run an effect over the whole machine, archiving into the tree. */
  readonly acting: <A, E>(effect: Effect.Effect<A, E, DiskInventory | DiskMutator>) => Promise<A>;
  /** Carry out a plan for real. */
  readonly apply: (plan: Plan.Plan) => Promise<Reclaim.Outcome>;
};

/**
 * Bind the tree-dependent helpers to whichever tree the running test has.
 *
 * Each suite owns its tree's lifecycle - created before every test, removed
 * after - so the tree is read through `current` at call time rather than
 * captured once.
 *
 * @param current - Reads the running test's tree.
 * @returns The helpers that act on it.
 */
export function bindToTree(current: () => TempTree): TreeHarness {
  /**
   * The options a run of the tool would have, pointed at this test's tree.
   *
   * @param selection - Which categories to consider.
   * @param caches - What the run does with every cache it finds.
   * @returns The survey options.
   */
  function surveying(
    selection: Reclaim.Selection,
    caches: Plan.CacheDisposition,
  ): Reclaim.SurveyOptions {
    return {
      sourceRoots: [current().sourceRoot],
      worktreeRoot: current().worktreeRoot,
      tempRoots: { _tag: "Given", roots: [current().tempRoot] },
      selection,
      policy: { caches, vitestTempStaleBefore: vitestStaleBefore() },
    };
  }

  /**
   * Run an effect over the whole machine, mutations included.
   *
   * Archives land inside the tree rather than in the user's home, and the clock
   * is stopped, so the file an archive will occupy is known before it is written.
   *
   * @template A - What the effect produces.
   * @template E - How it can fail.
   * @param effect - The effect to run.
   * @returns Its result.
   */
  function acting<A, E>(effect: Effect.Effect<A, E, DiskInventory | DiskMutator>): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.mergeAll(Inventory, makeDiskMutator(current().archiveRoot))),
        Effect.provideService(Clock.Clock, frozenClockAt(RUN_AT)),
      ),
    );
  }

  /** Carry out a plan for real. */
  function apply(plan: Plan.Plan): Promise<Reclaim.Outcome> {
    return acting(Reclaim.apply(plan));
  }

  return { surveying, acting, apply };
}
