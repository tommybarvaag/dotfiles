/**
 * Integration tests for the live adapter, exercised against a real temporary
 * directory tree. No module mocks: `du`, `find`, and `git` actually run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Option } from "effect";
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskInventoryLive } from "../src/adapters/bun-disk.ts";
import { ScanProgressSilent } from "../src/adapters/terminal-progress.ts";
import * as Cutoff from "../src/domain/cutoff.ts";
import * as Kilobytes from "../src/domain/kilobytes.ts";
import { DiskInventory } from "../src/ports.ts";

let root = "";

/** Size of each fixture blob, large enough that `du` reports whole kilobytes. */
const BLOB_KB = 512;

/**
 * The live inventory with progress reporting suppressed.
 *
 * Progress is a separate port precisely so a test can drop it without the
 * adapter knowing, and without any output polluting the test run.
 */
const InventoryUnderTest = Layer.provide(DiskInventoryLive, ScanProgressSilent);

/** Brand an age for fixtures, failing loudly on a bad literal. */
function age(days: number): Cutoff.AgeInDays {
  return Option.getOrThrow(Cutoff.parseAgeInDays(days));
}

/** Resolve an age the way the command line does, failing loudly on a bad literal. */
function staleBefore(days: number): Cutoff.Cutoff {
  return Cutoff.before(new Date(), age(days));
}

/** Run an inventory call against the live adapter. */
function inventory<A, E>(
  use: (service: DiskInventory["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    Effect.flatMap(DiskInventory, use).pipe(Effect.provide(InventoryUnderTest)),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reclaim-disk-test-"));

  const cache = join(root, "repo", ".turbo", "cache");
  await mkdir(join(cache, "old-entry"), { recursive: true });
  await mkdir(join(cache, "new-entry"), { recursive: true });

  const blob = Buffer.alloc(BLOB_KB * 1024, 0);
  await writeFile(join(cache, "old-entry", "blob"), blob);
  await writeFile(join(cache, "new-entry", "blob"), blob);

  // Backdate the old entry well past any cutoff the tests use.
  const longAgo = new Date("2025-01-01T00:00:00Z");
  await utimes(join(cache, "old-entry"), longAgo, longAgo);

  // A decoy: `.turbo` holds things other than the regenerable cache, and only
  // a `cache` directory is a target.
  await mkdir(join(root, "other-repo", ".turbo", "daemon"), { recursive: true });
});

afterAll(async () => {
  if (root !== "") {
    await rm(root, { recursive: true, force: true });
  }
});

describe("DiskInventoryLive", () => {
  test("finds .turbo/cache under a root, and never a .turbo without one", async () => {
    const found = await inventory((service) => service.findTurboCaches(root));

    expect(found.matches).toEqual([join(root, "repo", ".turbo", "cache")]);
    expect(found.skipped).toEqual([]);
  });

  test("a directory it cannot descend into is reported rather than skipped in silence", async () => {
    const tree = await mkdtemp(join(tmpdir(), "reclaim-disk-denied-"));

    try {
      // One readable repository, and one whose intermediate directory hides a
      // cache behind an `EACCES`. Treating the second as "no subdirectories"
      // is what made the report say the machine held one cache when it held
      // two, with nothing anywhere saying a directory had been skipped.
      await mkdir(join(tree, "open", "repo", ".turbo", "cache"), { recursive: true });
      const locked = join(tree, "locked");
      await mkdir(join(locked, "repo", ".turbo", "cache"), { recursive: true });
      await chmod(locked, 0o000);

      const found = await inventory((service) => service.findTurboCaches(tree));

      expect(found.matches).toEqual([join(tree, "open", "repo", ".turbo", "cache")]);
      expect(found.skipped).toHaveLength(1);
      expect(found.skipped[0]?.path).toBe(locked);
      expect(found.skipped[0]?.reason).toContain("could not be listed");
    } finally {
      await chmod(join(tree, "locked"), 0o755);
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("a root that does not exist holds nothing, rather than ending the run", async () => {
    // Both roots are defaulted, so this is a machine that has simply never run
    // an agent - and the other category's report still has to print.
    const found = await inventory((service) => service.findWorktrees(join(root, "never-created")));

    expect(found).toEqual({ matches: [], skipped: [] });
  });

  test("a root that exists and cannot be read ends the scan", async () => {
    const tree = await mkdtemp(join(tmpdir(), "reclaim-disk-unreadable-root-"));

    try {
      await chmod(tree, 0o000);

      const failure = await inventory((service) => Effect.flip(service.findTurboCaches(tree)));

      expect(failure._tag).toBe("ScanFailed");
      expect(failure.root).toBe(tree);
      expect(failure.message).toContain(`could not scan ${tree} looking for build caches`);
    } finally {
      await chmod(tree, 0o755);
      await rm(tree, { recursive: true, force: true });
    }
  });

  test("measures the whole cache", async () => {
    const cache = join(root, "repo", ".turbo", "cache");
    const size = await inventory((service) => service.sizeOf(cache));

    // Both blobs plus directory overhead.
    expect(size).toBeGreaterThanOrEqual(BLOB_KB * 2);
  });

  test("measures only entries older than the cutoff", async () => {
    const cache = join(root, "repo", ".turbo", "cache");
    const stale = await inventory((service) => service.sizeOfStaleEntries(cache, staleBefore(30)));
    const total = await inventory((service) => service.sizeOf(cache));

    // The backdated entry counts; the fresh one does not.
    expect(stale).toBeGreaterThanOrEqual(BLOB_KB);
    expect(stale).toBeLessThan(total);
  });

  test("reports zero when no entry predates the cutoff", async () => {
    const cache = join(root, "repo", ".turbo", "cache");

    // Ten years, not a century: macOS `find` cannot parse a pre-1970 date and
    // exits non-zero, which is now a reported failure rather than a silent zero.
    const stale = await inventory((service) =>
      service.sizeOfStaleEntries(cache, staleBefore(3_650)),
    );

    expect(stale).toBe(Kilobytes.zero);
  });

  test("a directory that cannot be measured fails instead of reporting zero", async () => {
    const missing = join(root, "no-such-directory");
    const failure = await inventory((service) => Effect.flip(service.sizeOf(missing)));

    expect(failure._tag).toBe("SizeUnavailable");
    expect(failure.path).toBe(missing);
  });

  test("stale entries of a directory that cannot be read fail instead of reporting zero", async () => {
    const missing = join(root, "no-such-directory");
    const failure = await inventory((service) =>
      Effect.flip(service.sizeOfStaleEntries(missing, staleBefore(30))),
    );

    expect(failure._tag).toBe("SizeUnavailable");
    expect(failure.path).toBe(missing);
  });

  test("selects entries on the cutoff instant, not the calendar day it falls on", async () => {
    const cache = await mkdtemp(join(tmpdir(), "reclaim-disk-instant-"));

    try {
      // The cutoff falls late in the UTC day, so truncating it to `2026-09-15`
      // would hand `find` local midnight instead - a different moment in every
      // timezone, and up to a day and an offset away from the resolved instant.
      const cutoff = Cutoff.before(new Date("2026-09-16T23:30:00Z"), age(1));

      const older = join(cache, "older");
      await mkdir(older);
      await writeFile(join(older, "blob"), Buffer.alloc(BLOB_KB * 1024, 0));
      const before = new Date("2026-09-15T12:00:00Z");
      await utimes(older, before, before);

      const newer = join(cache, "newer");
      await mkdir(newer);
      await writeFile(join(newer, "blob"), Buffer.alloc(BLOB_KB * 1024, 0));
      const after = new Date("2026-09-16T12:00:00Z");
      await utimes(newer, after, after);

      const stale = await inventory((service) => service.sizeOfStaleEntries(cache, cutoff));

      // Exactly the entry that predates the instant, and not the one after it.
      expect(stale).toBeGreaterThanOrEqual(BLOB_KB);
      expect(stale).toBeLessThan(BLOB_KB * 2);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  test("reads free space as a positive size", async () => {
    const free = await inventory((service) => service.freeSpace);

    expect(free).toBeGreaterThan(0);
  });

  test("a directory that is not a repository yields no turbo caches", async () => {
    const empty = await mkdtemp(join(tmpdir(), "reclaim-disk-empty-"));

    try {
      expect(await inventory((service) => service.findTurboCaches(empty))).toEqual({
        matches: [],
        skipped: [],
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
