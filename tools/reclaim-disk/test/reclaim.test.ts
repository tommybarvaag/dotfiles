/**
 * The destructive half of the tool, exercised end to end.
 *
 * Every test here runs the real application service over the real adapters
 * against a real temporary tree: `du` measures it, `git status` classifies real
 * worktrees of a real repository, `tar` writes real archives, and `rm` really
 * deletes. There are no module mocks and no substitute mutator, because a
 * substitute cannot prove the thing worth proving - that when archiving fails
 * for a reason the filesystem produced, the worktree is still there afterwards.
 *
 * Each test asserts what survived, not that a function was called.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Clock, Effect, Layer, Option } from "effect";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DiskInventoryLive, makeDiskMutator } from "../src/adapters/bun-disk.ts";
import { ScanProgressSilent } from "../src/adapters/terminal-progress.ts";
import * as Cutoff from "../src/domain/cutoff.ts";
import type * as Plan from "../src/domain/plan.ts";
import { type DiskInventory, DiskMutator } from "../src/ports.ts";
import * as Reclaim from "../src/reclaim.ts";
import {
  addStaleRegistration,
  addWorktree,
  archiveEntries,
  cloneRepository,
  commitWorktree,
  createRepository,
  createTempTree,
  createTurboCache,
  encloseInRepository,
  exists,
  frozenClockAt,
  ignorePaths,
  listFiles,
  removeTempTree,
  runOrThrow,
  type TempTree,
  worktreeRegistrations,
  writeBlob,
} from "./temp-tree.ts";

/**
 * The read-only half of the machine, with progress suppressed.
 *
 * `survey` is run with nothing else in scope: no mutating capability exists in
 * its context, so "the survey deleted something" is not a failure this suite
 * has to catch - it is a program that would not compile.
 */
const Inventory = Layer.provide(DiskInventoryLive, ScanProgressSilent);

/** Text written into a worktree and never committed, standing in for the only copy of something. */
const ONLY_COPY = "the only copy of this\n";

/** What a run with no `--age` does with every cache it finds. */
const deleteCaches: Plan.CacheDisposition = { _tag: "Delete" };

/** The instant every applying run's clock is stopped at. */
const RUN_AT = new Date("2026-03-01T12:00:00Z");

let tree: TempTree;

beforeEach(async () => {
  tree = await createTempTree();
});

afterEach(async () => {
  await removeTempTree(tree);
});

/**
 * The single element of a collection, failing the test when there is not exactly one.
 *
 * @template A - The element type.
 * @param values - The collection to unwrap.
 * @returns Its only element.
 * @throws When the collection does not hold exactly one element.
 */
function only<A>(values: ReadonlyArray<A>): A {
  const [first, ...rest] = values;

  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one element, got ${values.length}`);
  }

  return first;
}

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
    sourceRoot: tree.sourceRoot,
    worktreeRoot: tree.worktreeRoot,
    selection,
    caches,
  };
}

/**
 * What a run with `--age` does, with the cutoff resolved as the command line resolves it.
 *
 * @param days - The age in days the flag carried.
 * @returns The disposition carrying the resolved cutoff.
 */
function pruneOlderThan(days: number): Plan.CacheDisposition {
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
function looking<A, E>(effect: Effect.Effect<A, E, DiskInventory>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Inventory)));
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
      Effect.provide(Layer.mergeAll(Inventory, makeDiskMutator(tree.archiveRoot))),
      Effect.provideService(Clock.Clock, frozenClockAt(RUN_AT)),
    ),
  );
}

/** Survey the tree, with only the read-only capability in scope. */
function survey(options: Reclaim.SurveyOptions): Promise<Plan.Plan> {
  return looking(Reclaim.survey(options));
}

/** Carry out a plan for real. */
function apply(plan: Plan.Plan): Promise<Reclaim.Outcome> {
  return acting(Reclaim.apply(plan));
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
function refusal(outcome: Reclaim.Outcome): Reclaim.Refusal {
  return only(outcome.refused);
}

/**
 * Archive an entry's untracked files through the real mutator, deleting nothing.
 *
 * Every run here shares one stopped clock, and the mutator names an archive
 * from the clock, so this reports exactly where the next attempt will write -
 * without this test having to know how the adapter builds the name.
 *
 * @param entry - The entry whose files are archived.
 * @returns The archive it wrote.
 */
function archiveOnce(entry: Plan.ReclaimingEntry): Promise<string> {
  const { disposition } = entry;

  if (disposition._tag !== "ArchiveThenDelete") {
    throw new Error(`expected an ArchiveThenDelete entry, got ${disposition._tag}`);
  }

  return acting(
    Effect.flatMap(DiskMutator, (mutator) =>
      mutator.archiveUntracked(entry.target.path, disposition.files),
    ),
  );
}

describe("survey", () => {
  test("changes nothing on disk, however much it plans to delete", async () => {
    const repository = await createRepository(tree, "app");
    await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);
    await addWorktree(tree, repository, "app", "agent-1");

    const sourceBefore = await listFiles(tree.sourceRoot);
    const worktreesBefore = await listFiles(tree.worktreeRoot);

    const plan = await survey(surveying("all", deleteCaches));

    // Not a vacuous pass: this plan would delete a cache and a worktree, and
    // prune the repository afterwards.
    expect(plan.reclaiming).toHaveLength(2);
    expect(plan.pruning).toEqual([repository]);

    expect(await listFiles(tree.sourceRoot)).toEqual(sourceBefore);
    expect(await listFiles(tree.worktreeRoot)).toEqual(worktreesBefore);
  });

  test("a directory it cannot measure is reported, and the rest of the plan survives", async () => {
    const unreadable = await createTurboCache(await createRepository(tree, "locked"), [
      { name: "old", ageInDays: 90 },
    ]);
    const readable = await createTurboCache(await createRepository(tree, "open"), [
      { name: "old", ageInDays: 90 },
    ]);

    // `du` exits non-zero with nothing on stdout here. Summing that as zero is
    // what made an unreadable directory disappear from the report; failing the
    // run is what made one unreadable directory hide every other target.
    await chmod(unreadable, 0o000);

    const plan = await survey(surveying("turbo-only", deleteCaches));

    expect(only(plan.unexamined).path).toBe(unreadable);
    expect(only(plan.unexamined).reason).toContain("could not be measured");
    expect(only(plan.reclaiming).target.path).toBe(readable);
  });

  test("a stray directory under the worktree root is reported, and the rest of the plan survives", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-1");

    // What a crashed agent leaves behind: a directory where a worktree should
    // be, that git knows nothing about.
    const stray = join(tree.worktreeRoot, "app", "stray");
    await mkdir(stray, { recursive: true });
    await writeBlob(join(stray, "leftover.bin"), 0);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    // Which reason git gives depends on whether the temp directory happens to
    // sit inside a repository, which is not this test's business - the two
    // reasons are asserted directly, on trees that control that.
    expect(only(plan.unexamined).path).toBe(stray);
    expect(only(plan.reclaiming).target.path).toBe(worktree);

    await apply(plan);

    // Reported and left alone, while the worktree beside it was still removed.
    expect(await exists(worktree)).toBe(false);
    expect(await exists(join(stray, "leftover.bin"))).toBe(true);
  });

  test("a directory that merely sits inside a repository is not treated as its worktree", async () => {
    // A worktree root inside a git repository: a dotfiles checkout of $HOME, or
    // a worktree root placed in a monorepo. `git -C` searches upward, so every
    // stray directory under it answers with that repository's status - and
    // answers it "clean".
    await encloseInRepository(tree.root);

    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-1");
    const stray = join(tree.worktreeRoot, "app", "stray");
    await mkdir(stray, { recursive: true });
    await writeBlob(join(stray, "leftover.bin"), 0);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.unexamined).path).toBe(stray);
    expect(only(plan.unexamined).reason).toContain("not a linked worktree");
    expect(only(plan.reclaiming).target.path).toBe(worktree);

    // And the enclosing repository is not named: pruning there would drop
    // registrations for worktrees the user never pointed this tool at.
    expect(plan.pruning).toEqual([repository]);

    await apply(plan);

    expect(await exists(join(stray, "leftover.bin"))).toBe(true);
  });

  test("a standalone clone sitting at worktree depth is reported, never deleted", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-1");

    // `git status` calls a clone clean, and it is - about the files. Its object
    // database is inside it, so deleting the directory takes every commit only
    // it holds, which is exactly what "clean" says nothing about.
    const clone = await cloneRepository(repository, join(tree.worktreeRoot, "scratch", "clone"));

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.unexamined).path).toBe(clone);
    expect(only(plan.unexamined).reason).toContain("standalone clone");
    expect(only(plan.reclaiming).target.path).toBe(worktree);
    expect(plan.pruning).toEqual([repository]);

    await apply(plan);

    expect(await exists(clone)).toBe(true);
    expect(await exists(worktree)).toBe(false);
  });
});

describe("apply", () => {
  test("removes a clean worktree and prunes the registration it left behind", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-1");

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition._tag).toBe("Delete");
    expect(await worktreeRegistrations(repository)).toHaveLength(2);

    const outcome = await apply(plan);

    expect(await exists(worktree)).toBe(false);
    expect(outcome.removed).toBe(1);
    expect(outcome.archives).toEqual([]);

    // The registration pointing at the deleted directory is gone, and the
    // repository's own is not.
    expect(await worktreeRegistrations(repository)).toHaveLength(1);
  });

  test("prunes only the repository that owned the removed worktree", async () => {
    const owner = await createRepository(tree, "owner");
    const bystander = await createRepository(tree, "bystander");
    const worktree = await addWorktree(tree, owner, "owner", "agent-1");

    // A repository with nothing to do with this run, holding a registration
    // `git worktree prune` would happily drop - an unmounted external disk, say.
    await addStaleRegistration(bystander, join(tree.root, "elsewhere", "feature"));
    const bystanderBefore = await worktreeRegistrations(bystander);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    // The plan names its whole effect: one repository, the one that owns the
    // worktree above.
    expect(plan.pruning).toEqual([owner]);
    expect(bystanderBefore).toHaveLength(2);

    await apply(plan);

    expect(await exists(worktree)).toBe(false);
    expect(await worktreeRegistrations(owner)).toHaveLength(1);
    expect(await worktreeRegistrations(bystander)).toEqual(bystanderBefore);
  });

  test("archives untracked files before removing the worktree that held them", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-2");
    await writeFile(join(worktree, "notes.md"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition._tag).toBe("ArchiveThenDelete");

    const outcome = await apply(plan);
    const archive = only(outcome.archives);

    // The worktree is gone, so the archive is now the only copy - it has to
    // actually hold the file.
    expect(await exists(worktree)).toBe(false);
    expect(await archiveEntries(archive)).toContain("notes.md");
  });

  test("archives a file whose name holds a space and a non-ASCII byte", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-norsk");
    await writeFile(join(worktree, "notes æ.md"), ONLY_COPY);
    await writeFile(join(worktree, "a b.txt"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition._tag).toBe("ArchiveThenDelete");

    const outcome = await apply(plan);

    // Read without `-z`, git would have handed `tar` the C-quoted literal
    // `"notes \303\246.md"`, which `tar` cannot stat: the archive would fail,
    // the worktree would survive, and every later entry of a confirmed plan
    // would be abandoned behind it.
    const entries = (await archiveEntries(only(outcome.archives))).map((entry) =>
      entry.normalize("NFC"),
    );

    expect(await exists(worktree)).toBe(false);
    expect(entries).toContain("notes æ.md".normalize("NFC"));
    expect(entries).toContain("a b.txt");
  });

  test("a failed archive leaves the worktree intact", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-3");
    await writeFile(join(worktree, "notes.md"), ONLY_COPY);

    // A real reason for `tar` to fail: the directory archives are written into
    // exists but cannot be written to.
    await mkdir(tree.archiveRoot);
    await chmod(tree.archiveRoot, 0o555);

    const plan = await survey(surveying("worktrees-only", deleteCaches));
    const outcome = await apply(plan);

    expect(refusal(outcome).path).toBe(worktree);
    expect(refusal(outcome).reason).toContain("could not be archived");
    expect(outcome.removed).toBe(0);
    expect(await exists(worktree)).toBe(true);
    expect(await readFile(join(worktree, "notes.md"), "utf8")).toBe(ONLY_COPY);
  });

  test("a removal that fails after archiving still reports the archive", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-9");
    await writeFile(join(worktree, "notes.md"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    // A real reason for `rm -r` to fail only after `tar` has succeeded: the
    // worktree's parent denies the unlink of the directory itself, which
    // `rm -r` reaches last, having already destroyed everything inside it.
    await chmod(dirname(worktree), 0o555);

    const outcome = await apply(plan).finally(() => chmod(dirname(worktree), 0o755));

    expect(refusal(outcome).remains).toBe("PartiallyRemoved");
    expect(refusal(outcome).reason).toContain("could not be removed");

    // The receipt is the point: `notes.md` is gone from disk, so the archive
    // named in the outcome is the only copy left of it.
    expect(await exists(join(worktree, "notes.md"))).toBe(false);
    expect(outcome.archives).toHaveLength(1);
    expect(await archiveEntries(only(outcome.archives))).toContain("notes.md");
    expect(Option.getOrNull(refusal(outcome).archive)).toBe(only(outcome.archives));
  });

  test("an archive that does not hold the files is rejected rather than allowing the delete", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-4");
    await writeFile(join(worktree, "notes.md"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    // Learn where the next archive goes, then leave something there that
    // swallows every byte written to it: `tar` succeeds and the archive holds
    // nothing, which is the one case a clean exit code cannot rule out - and
    // which a size check cannot rule out either, a gzipped empty tar being 29
    // bytes rather than none.
    const destination = await archiveOnce(only(plan.reclaiming));
    await rm(destination);
    await symlink("/dev/null", destination);

    const outcome = await apply(plan);

    expect(refusal(outcome).path).toBe(worktree);
    expect(refusal(outcome).reason).toBe(
      `could not be archived to ${destination}: archive is missing notes.md`,
    );
    expect(refusal(outcome).remains).toBe("Untouched");
    expect(await exists(worktree)).toBe(true);
    expect(await readFile(join(worktree, "notes.md"), "utf8")).toBe(ONLY_COPY);
  });

  test("archives an untracked file whose name begins with @", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-at");

    // `tar` reads an argv operand beginning with `@` as "read entries from this
    // archive and add them to the output", and `--` does not turn that off. So
    // an argv invocation archived nothing for `@backup.tar`, exited 0 because
    // the name beside it really was a readable archive, and the worktree was
    // deleted with the only copy of that file inside it - no refusal, no
    // mention in the report.
    await runOrThrow("tar", ["-czf", join(worktree, "backup.tar"), "-C", worktree, "."]);
    await writeFile(join(worktree, "@backup.tar"), ONLY_COPY);
    await writeFile(join(worktree, "notes.md"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));
    const { disposition } = only(plan.reclaiming);

    // Not a vacuous pass: the plan really did name the file.
    expect(disposition._tag).toBe("ArchiveThenDelete");
    expect(disposition._tag === "ArchiveThenDelete" && disposition.files).toContain("@backup.tar");

    const outcome = await apply(plan);

    expect(outcome.refused).toEqual([]);
    expect(await exists(worktree)).toBe(false);
    expect(await archiveEntries(only(outcome.archives))).toContain("@backup.tar");
  });

  test("a removal denied partway through is reported as partly removed, not as untouched", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);

    // `rm -r` unlinks depth-first: emptying the cache needs write permission on
    // the cache itself, but unlinking the cache needs it on `.turbo`. Denying
    // only the latter is what leaves a target neither removed nor intact.
    await chmod(join(repository, ".turbo"), 0o555);

    const plan = await survey(surveying("turbo-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(cache);

    const outcome = await apply(plan);

    // What the report says has to match what is on disk: the entries are gone,
    // so calling this "refused" would tell the user the cache is still there.
    expect(refusal(outcome).path).toBe(cache);
    expect(refusal(outcome).reason).toContain("could not be removed");
    expect(refusal(outcome).remains).toBe("PartiallyRemoved");
    expect(outcome.removed).toBe(0);
    expect(await exists(cache)).toBe(true);
    expect(await exists(join(cache, "old"))).toBe(false);
  });

  test("a worktree written into since the survey is not deleted", async () => {
    const repository = await createRepository(tree, "app");
    const worktree = await addWorktree(tree, repository, "app", "agent-7");

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition._tag).toBe("Delete");

    // The agent this worktree belongs to wakes up while the confirmation
    // prompt is open and writes two hours of work into it.
    await writeFile(join(worktree, "resumed.md"), ONLY_COPY);

    const outcome = await apply(plan);

    expect(refusal(outcome).path).toBe(worktree);
    expect(refusal(outcome).reason).toBe(
      "changed since the survey: was clean, now 1 untracked file(s)",
    );
    expect(outcome.removed).toBe(0);
    expect(await readFile(join(worktree, "resumed.md"), "utf8")).toBe(ONLY_COPY);
  });

  test("a refused entry does not abandon the confirmed entries behind it", async () => {
    const repository = await createRepository(tree, "app");

    // Entries are ordered largest first, so bulking this one up puts the
    // refusal at the front: everything else in the plan sits behind it.
    const drifting = await addWorktree(tree, repository, "app", "agent-drift");
    await writeBlob(join(drifting, "bulk-1.bin"), 1);
    await writeBlob(join(drifting, "bulk-2.bin"), 2);
    await commitWorktree(drifting);

    const archiving = await addWorktree(tree, repository, "app", "agent-notes");
    await writeFile(join(archiving, "notes.md"), ONLY_COPY);
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);

    const plan = await survey(surveying("all", deleteCaches));

    expect(plan.reclaiming[0]?.target.path).toBe(drifting);

    // The agent owning the first worktree wakes up while the prompt is open.
    await writeFile(join(drifting, "resumed.md"), ONLY_COPY);

    const outcome = await apply(plan);

    expect(refusal(outcome).path).toBe(drifting);
    expect(await readFile(join(drifting, "resumed.md"), "utf8")).toBe(ONLY_COPY);

    // Everything behind the refusal was confirmed too, and still went - and the
    // archive holding the only copy of `notes.md` is named, which it can only
    // be if the run came back with an outcome rather than a failure.
    expect(await exists(archiving)).toBe(false);
    expect(await exists(cache)).toBe(false);
    expect(outcome.removed).toBe(2);
    expect(await archiveEntries(only(outcome.archives))).toContain("notes.md");

    // And the registration the removed worktree left behind was pruned: the
    // repository's own and the refused worktree's are all that remain.
    expect(await worktreeRegistrations(repository)).toEqual([repository, drifting]);
  });

  test("a worktree holding only a gitignored file is archived before it is removed", async () => {
    const repository = await createRepository(tree, "app");
    await ignorePaths(repository, [".env", "node_modules/"]);
    const worktree = await addWorktree(tree, repository, "app", "agent-env");

    // What an agent's setup writes: gitignored by design, and the only copy.
    // A plain `git status --porcelain` never mentions it, which is what made
    // this worktree read as clean and get deleted with no archive at all.
    await writeFile(join(worktree, ".env"), ONLY_COPY);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition._tag).toBe("ArchiveThenDelete");

    const outcome = await apply(plan);

    expect(await exists(worktree)).toBe(false);
    expect(await archiveEntries(only(outcome.archives))).toContain(".env");
  });

  test("a worktree holding only a regenerable ignored tree is deleted with no archive", async () => {
    const repository = await createRepository(tree, "app");
    await ignorePaths(repository, [".env", "node_modules/"]);
    const worktree = await addWorktree(tree, repository, "app", "agent-deps");

    // The other half of the ignored category: archiving this on every run would
    // put a dependency tree in a tarball to no purpose.
    await mkdir(join(worktree, "node_modules", "left-pad"), { recursive: true });
    await writeBlob(join(worktree, "node_modules", "left-pad", "index.js"), 0);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).disposition).toEqual({ _tag: "Delete" });

    const outcome = await apply(plan);

    expect(await exists(worktree)).toBe(false);
    expect(outcome.archives).toEqual([]);
  });

  test("a worktree holding modified tracked files is never removed", async () => {
    const repository = await createRepository(tree, "app");
    const dirty = await addWorktree(tree, repository, "app", "agent-dirty");
    const clean = await addWorktree(tree, repository, "app", "agent-clean");

    // An edit to a committed file: git can tell us it exists, but not what it was.
    await writeBlob(join(dirty, "blob.bin"), 7);

    const plan = await survey(surveying("worktrees-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(clean);
    expect(only(plan.keeping).target.path).toBe(dirty);

    const dirtyBefore = await listFiles(dirty);
    await apply(plan);

    // The mutator was in scope and did delete the other worktree, so the dirty
    // one surviving whole is a decision rather than an absence of opportunity.
    expect(await exists(clean)).toBe(false);
    expect(await listFiles(dirty)).toEqual(dirtyBefore);
  });

  test("a turbo-only run leaves worktrees and their registrations untouched", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [{ name: "old", ageInDays: 90 }]);
    await addWorktree(tree, repository, "app", "agent-1");

    const plan = await survey(surveying("turbo-only", deleteCaches));

    expect(only(plan.reclaiming).target.path).toBe(cache);

    // Nothing outside the reported entries: no repository is pruned when no
    // worktree is removed.
    expect(plan.pruning).toEqual([]);

    const worktreesBefore = await listFiles(tree.worktreeRoot);
    await apply(plan);

    expect(await exists(cache)).toBe(false);
    expect(await listFiles(tree.worktreeRoot)).toEqual(worktreesBefore);
    expect(await worktreeRegistrations(repository)).toHaveLength(2);
  });

  test("a pruned cache loses exactly the entries the survey measured", async () => {
    const repository = await createRepository(tree, "app");
    const cache = await createTurboCache(repository, [
      { name: "old", ageInDays: 90 },
      { name: "fresh", ageInDays: 0 },
    ]);

    const plan = await survey(surveying("turbo-only", pruneOlderThan(30)));
    const entry = only(plan.reclaiming);

    expect(entry.disposition._tag).toBe("PruneOlderThan");

    // The cutoff travelled with the entry, so the deletion selects the same
    // entries the report was built from.
    await apply(plan);

    expect(only(await listFiles(cache))).toContain(join("fresh", "artifact.bin"));
  });
});
