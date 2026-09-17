/**
 * Integration tests for the live adapter, exercised against a real temporary
 * directory tree. No module mocks: `du`, `find`, and `git` actually run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskInventoryLive } from "../src/adapters/bun-disk.ts";
import { ScanProgressSilent } from "../src/adapters/terminal-progress.ts";
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

/** Run an inventory call against the live adapter. */
function inventory<A, E>(
  use: (service: DiskInventory["Service"]) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(Effect.flatMap(DiskInventory, use).pipe(Effect.provide(InventoryUnderTest)));
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
});

afterAll(async () => {
  if (root !== "") {
    await rm(root, { recursive: true, force: true });
  }
});

describe("DiskInventoryLive", () => {
  test("finds the turbo cache under a root", async () => {
    const found = await inventory((service) => service.findTurboCaches(root));

    expect(found).toEqual([join(root, "repo", ".turbo", "cache")]);
  });

  test("measures the whole cache", async () => {
    const cache = join(root, "repo", ".turbo", "cache");
    const size = await inventory((service) => service.sizeOf(cache));

    // Both blobs plus directory overhead.
    expect(size).toBeGreaterThanOrEqual(BLOB_KB * 2);
  });

  test("measures only entries older than the cutoff", async () => {
    const cache = join(root, "repo", ".turbo", "cache");
    const stale = await inventory((service) => service.sizeOfStaleEntries(cache, 30));
    const total = await inventory((service) => service.sizeOf(cache));

    // The backdated entry counts; the fresh one does not.
    expect(stale).toBeGreaterThanOrEqual(BLOB_KB);
    expect(stale).toBeLessThan(total);
  });

  test("reports zero when no entry predates the cutoff", async () => {
    const cache = join(root, "repo", ".turbo", "cache");
    const stale = await inventory((service) => service.sizeOfStaleEntries(cache, 36_500));

    expect(stale).toBe(Kilobytes.zero);
  });

  test("reads free space as a positive size", async () => {
    const free = await inventory((service) => service.freeSpace);

    expect(free).toBeGreaterThan(0);
  });

  test("a directory that is not a repository yields no turbo caches", async () => {
    const empty = await mkdtemp(join(tmpdir(), "reclaim-disk-empty-"));

    try {
      expect(await inventory((service) => service.findTurboCaches(empty))).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
