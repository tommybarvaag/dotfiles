/**
 * Leaked Vitest temp directories, surveyed and removed end to end.
 *
 * The same real service over the same real adapters as `reclaim.test.ts`,
 * against a temp root inside a throwaway tree. Every decoy is a shape that
 * really sat in a temp root beside Vitest's directories, and each test asserts
 * what survived and what the report named.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type * as Plan from "../src/domain/plan.ts";
import * as Reclaim from "../src/reclaim.ts";
import {
  bindToTree,
  deleteCaches,
  looking,
  only,
  refusal,
  survey,
  surveyRecording,
} from "./reclaim-harness.ts";
import {
  createRepository,
  createTempTree,
  createTurboCache,
  createVitestTempDir,
  entryExists,
  exists,
  listFiles,
  removeTempTree,
  sha1,
  type TempTree,
  writeBlob,
} from "./temp-tree.ts";

let tree: TempTree;

beforeEach(async () => {
  tree = await createTempTree();
});

afterEach(async () => {
  await removeTempTree(tree);
});

const { surveying, apply } = bindToTree(() => tree);

/**
 * Every path a plan names, whichever section it is in.
 *
 * @param plan - The plan to read.
 * @returns Each path the report would print.
 */
function named(plan: Plan.Plan): ReadonlyArray<string> {
  return [
    ...plan.reclaiming.map((entry) => entry.target.path),
    ...plan.keeping.map((entry) => entry.target.path),
    ...plan.unexamined.map((entry) => entry.path),
  ];
}

describe("Vitest temp directories", () => {
  /** A stale project directory, as a killed run leaves one. */
  const STALE = "Cjkj_H4LKz5PpUh7WCbX1";

  /** A project directory a run wrote into minutes ago. */
  const FRESH = "8712f0Ev63ntQifCOeFFS";

  test("a stale one is removed, a fresh one is kept, and nothing that only looks like one is touched", async () => {
    const stale = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2, client: 1 });
    const fresh = await createVitestTempDir(tree.tempRoot, FRESH, 0, { ssr: 2 });

    // Each of these sat in a real temp root beside Vitest's directories.
    const checkout = join(tree.tempRoot, "toast-review-ha6vdvqk");
    await mkdir(join(checkout, "packages"), { recursive: true });
    await writeFile(join(checkout, "package.json"), "{}\n");

    const logs = join(tree.tempRoot, "cursor-agent-logs-501");
    await mkdir(logs);
    await writeBlob(join(logs, "latest.log"), 1);

    const lookalike = await createVitestTempDir(tree.tempRoot, "AAAAAAAAAAAAAAAAAAAAA", 3, {
      ssr: 2,
    });
    await writeBlob(join(lookalike, "ssr", "notes.md"), 2);

    const empty = join(tree.tempRoot, "EEEEEEEEEEEEEEEEEEEEE");
    await mkdir(join(empty, "ssr"), { recursive: true });

    const plan = await survey(surveying("vitest-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(stale);
    expect(only(plan.keeping).target.path).toBe(fresh);
    expect(plan.unexamined).toEqual([]);

    for (const decoy of [checkout, logs, lookalike, empty]) {
      expect(named(plan)).not.toContain(decoy);
    }

    const outcome = await apply(plan);

    expect(outcome.refused).toEqual([]);
    expect(outcome.removed).toBe(1);
    expect(await exists(stale)).toBe(false);

    const survivors = [fresh, checkout, logs, lookalike, empty];

    expect(await Promise.all(survivors.map((survivor) => exists(survivor)))).toEqual(
      survivors.map(() => true),
    );
  });

  test("one written to between the survey and the deletion is refused and survives", async () => {
    const project = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2 });

    const plan = await survey(surveying("vitest-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(project);

    // A run that is still going transforms another module.
    await writeBlob(join(project, "ssr", sha1("a module transformed just now")), 3);

    const outcome = await apply(plan);

    expect(await exists(project)).toBe(true);
    expect(outcome.removed).toBe(0);
    expect(refusal(outcome).path).toBe(project);
    expect(refusal(outcome).remains).toBe("Untouched");
  });

  test("a 21-character checkout holding a file is dropped without reading the rest of it", async () => {
    // A file beside the directories already rules it out, so the unreadable
    // directory beside it is never listed - and never shows up as a row about
    // a directory this tool had no business reading.
    const checkout = join(tree.tempRoot, "toast-review-ha6vdvqk");
    const locked = join(checkout, "packages");
    await mkdir(locked, { recursive: true });
    await writeFile(join(checkout, "package.json"), "{}\n");
    await chmod(locked, 0o000);

    const plan = await survey(surveying("vitest-only", deleteCaches));

    expect(plan.reclaiming).toEqual([]);
    expect(plan.keeping).toEqual([]);
    expect(plan.unexamined).toEqual([]);
  });

  test("a 21-character directory whose readable subdirectory disqualifies it is dropped, however its unreadable sibling fails", async () => {
    // Every entry is a directory, so nothing rules it out before descending.
    // The README in `packages` does, and it has to win over `secret` failing
    // to list, whichever of the two is read first.
    const decoy = join(tree.tempRoot, "subdir-only-decoy-123");
    await mkdir(join(decoy, "packages"), { recursive: true });
    await writeFile(join(decoy, "packages", "README.md"), "# not a module\n");
    const locked = join(decoy, "secret");
    await mkdir(locked);
    await chmod(locked, 0o000);

    const plan = await survey(surveying("vitest-only", deleteCaches));

    expect(plan.reclaiming).toEqual([]);
    expect(plan.keeping).toEqual([]);
    expect(plan.unexamined).toEqual([]);
  });

  /**
   * Survey one stale project directory, replace it before the deletion, and apply.
   *
   * @param replace - What happens at the planned path between the two.
   * @returns The planned path and what the run reported.
   */
  async function replacedBeforeApply(
    replace: (project: string) => Promise<void>,
  ): Promise<{ readonly project: string; readonly outcome: Reclaim.Outcome }> {
    const project = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2 });
    const plan = await survey(surveying("vitest-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(project);

    await rm(project, { recursive: true });
    await replace(project);

    return { project, outcome: await apply(plan) };
  }

  test("one replaced by a regular file before the deletion is refused, and the file survives", async () => {
    const { project, outcome } = await replacedBeforeApply((path) => writeBlob(path, 1));

    expect(outcome.removed).toBe(0);
    expect(refusal(outcome).path).toBe(project);
    expect(refusal(outcome).remains).toBe("Untouched");
    expect(await exists(project)).toBe(true);
  });

  test("one replaced by a dangling symlink before the deletion is refused, and the link survives", async () => {
    const { project, outcome } = await replacedBeforeApply((path) =>
      symlink(join(tree.root, "nowhere"), path),
    );

    expect(outcome.removed).toBe(0);
    expect(refusal(outcome).path).toBe(project);
    expect(refusal(outcome).remains).toBe("Untouched");
    expect(await entryExists(project)).toBe(true);
  });

  test("one replaced by a symlink to a directory before the deletion is refused, and both survive", async () => {
    const elsewhere = await createVitestTempDir(tree.root, FRESH, 3, { ssr: 2 });
    const { project, outcome } = await replacedBeforeApply((path) => symlink(elsewhere, path));

    expect(outcome.removed).toBe(0);
    expect(refusal(outcome).path).toBe(project);
    expect(refusal(outcome).remains).toBe("Untouched");
    expect(await entryExists(project)).toBe(true);
    expect(await listFiles(elsewhere)).toHaveLength(2);
  });

  test("one whose environment directory became a symlink before the deletion is refused", async () => {
    const elsewhere = await createVitestTempDir(tree.root, FRESH, 3, { ssr: 2 });
    const project = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2 });
    const plan = await survey(surveying("vitest-only", deleteCaches));

    await rm(join(project, "ssr"), { recursive: true });
    await symlink(join(elsewhere, "ssr"), join(project, "ssr"));

    const outcome = await apply(plan);

    expect(outcome.removed).toBe(0);
    expect(refusal(outcome).remains).toBe("Untouched");
    expect(await entryExists(join(project, "ssr"))).toBe(true);
    expect(await listFiles(elsewhere)).toHaveLength(2);
  });

  test("one its run removed before the deletion reached it counts as done, not refused", async () => {
    const project = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2 });

    const plan = await survey(surveying("vitest-only", deleteCaches));

    // The run closed cleanly and cleared its own directory.
    await rm(project, { recursive: true });

    const outcome = await apply(plan);

    expect(outcome.refused).toEqual([]);
    expect(outcome.removed).toBe(1);
  });

  // The machine's defaults are spelled out and handed to this same walk, so a
  // `/tmp` beside `/private/tmp` is exactly this case.
  test("a root reached by two spellings, as /tmp and /private/tmp are, is walked once", async () => {
    const project = await createVitestTempDir(tree.tempRoot, STALE, 3, { ssr: 2 });
    const link = join(tree.root, "tmp-link");
    await symlink(tree.tempRoot, link);

    const { plan, walked, found } = await surveyRecording({
      ...surveying("vitest-only", deleteCaches),
      tempRoots: { _tag: "Given", roots: [link, tree.tempRoot] },
    });

    expect(only(plan.reclaiming).target.path).toBe(project);
    expect(walked).toEqual([[tree.tempRoot]]);
    expect(found).toEqual([project]);

    const outcome = await apply(plan);

    expect(outcome.refused).toEqual([]);
    expect(await exists(project)).toBe(false);
  });

  test("a temp root that does not exist holds nothing, and the other categories still report", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);

    const plan = await survey({
      ...surveying("all", deleteCaches),
      tempRoots: { _tag: "Given", roots: [join(tree.root, "never-created")] },
    });

    expect(only(plan.reclaiming).target.path).toBe(cache);
  });

  test("a temp root that exists and cannot be read fails the scan, naming it", async () => {
    const locked = join(tree.root, "locked-temp");
    await mkdir(locked);
    await chmod(locked, 0o000);

    const failure = await looking(
      Effect.flip(
        Reclaim.survey({
          ...surveying("vitest-only", deleteCaches),
          tempRoots: { _tag: "Given", roots: [locked] },
        }),
      ),
    );

    expect(failure._tag).toBe("ScanFailed");
    expect(failure.root).toBe(locked);
  });
});
