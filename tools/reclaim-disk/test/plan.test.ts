import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import * as Cutoff from "../src/domain/cutoff.ts";
import * as Kilobytes from "../src/domain/kilobytes.ts";
import * as Plan from "../src/domain/plan.ts";
import type { WorktreeState } from "../src/domain/worktree.ts";

/** Brand a literal size for fixtures, failing loudly on a bad literal. */
function size(value: number): Kilobytes.Kilobytes {
  return Effect.runSync(Kilobytes.parse(value));
}

/** What a run with no `--age` does with the caches it finds. */
const deleteCaches: Plan.CacheDisposition = { _tag: "Delete" };

/** What a run with `--age 30` does, with the cutoff already resolved. */
const pruneCaches: Plan.CacheDisposition = {
  _tag: "PruneOlderThan",
  cutoff: Cutoff.before(
    new Date("2026-03-01T12:00:00Z"),
    Option.getOrThrow(Cutoff.parseAgeInDays(30)),
  ),
};

/** The instant every fixture Vitest temp directory is judged against. */
const VITEST_STALE_BEFORE = Cutoff.hoursBefore(
  new Date("2026-03-01T12:00:00Z"),
  Option.getOrThrow(Cutoff.parseAgeInHours(1)),
);

/**
 * A run's policy, with the cache disposition under test.
 *
 * @param caches - What the run does with every cache it finds.
 * @returns The policy.
 */
function policy(caches: Plan.CacheDisposition): Plan.Policy {
  return { caches, vitestTempStaleBefore: VITEST_STALE_BEFORE };
}

function vitestTempDir(path: string, kb: number, lastWritten: Date): Plan.Scanned {
  return {
    _tag: "Examined",
    target: { _tag: "VitestTempDir", path, size: size(kb), lastWritten },
  };
}

function turboCache(path: string, kb: number): Plan.Scanned {
  return { _tag: "Examined", target: { _tag: "TurboCache", path, size: size(kb) } };
}

function worktree(
  path: string,
  kb: number,
  state: WorktreeState,
  repository = "/src/repo",
): Plan.Scanned {
  return {
    _tag: "Examined",
    target: { _tag: "AgentWorktree", path, size: size(kb), repository, state },
  };
}

function unexamined(path: string, reason: string): Plan.Scanned {
  return { _tag: "Unexamined", path, reason };
}

describe("decideWorktree", () => {
  test("clean worktrees are deleted", () => {
    expect(Plan.decideWorktree({ _tag: "Clean" })).toEqual({ _tag: "Delete" });
  });

  test("untracked-only worktrees are archived first", () => {
    const disposition = Plan.decideWorktree({
      _tag: "UntrackedOnly",
      files: ["plans/"],
      ignored: [],
    });

    expect(disposition._tag).toBe("ArchiveThenDelete");
    expect(disposition._tag === "ArchiveThenDelete" ? disposition.files : []).toEqual(["plans/"]);
  });

  test("an irreplaceable ignored path is archived, not silently deleted", () => {
    const disposition = Plan.decideWorktree({ _tag: "IgnoredOnly", ignored: [".env"] });

    expect(disposition._tag).toBe("ArchiveThenDelete");
    expect(disposition._tag === "ArchiveThenDelete" ? disposition.files : []).toEqual([".env"]);
  });

  test("a worktree holding only regenerable ignored output is deleted outright", () => {
    // Archiving these would put a dependency tree in a tarball on every run.
    const disposition = Plan.decideWorktree({
      _tag: "IgnoredOnly",
      ignored: ["node_modules/", "packages/app/node_modules/", "apps/web/.next/", "dist/"],
    });

    expect(disposition).toEqual({ _tag: "Delete" });
  });

  test("ignored paths ride along with the untracked ones into the archive", () => {
    const disposition = Plan.decideWorktree({
      _tag: "UntrackedOnly",
      files: ["notes.md"],
      ignored: ["node_modules/", ".env"],
    });

    expect(disposition._tag === "ArchiveThenDelete" ? disposition.files : []).toEqual([
      "notes.md",
      ".env",
    ]);
  });

  test("tracked changes are never deleted", () => {
    const disposition = Plan.decideWorktree({
      _tag: "TrackedDirty",
      entries: [" M src/index.ts"],
    });

    expect(disposition._tag).toBe("Keep");
  });

  test("nothing that holds an irreplaceable path is deleted outright", () => {
    const states: ReadonlyArray<WorktreeState> = [
      { _tag: "Clean" },
      { _tag: "IgnoredOnly", ignored: [".env"] },
      { _tag: "IgnoredOnly", ignored: ["node_modules/"] },
      { _tag: "UntrackedOnly", files: ["a"], ignored: [] },
      { _tag: "TrackedDirty", entries: ["a"] },
    ];

    const deleting = states.filter((state) => Plan.decideWorktree(state)._tag === "Delete");

    // Only the two states that prove nothing would be lost: genuinely clean,
    // and holding only what a rebuild puts back.
    expect(deleting).toEqual([
      { _tag: "Clean" },
      { _tag: "IgnoredOnly", ignored: ["node_modules/"] },
    ]);
  });
});

describe("decideVitestTempDir", () => {
  test("a directory last written before the cutoff is deleted", () => {
    expect(Plan.decideVitestTempDir(new Date("2026-03-01T10:59:59Z"), VITEST_STALE_BEFORE)).toEqual(
      { _tag: "Delete" },
    );
  });

  test("a directory written at or after the cutoff is kept, because a run may still be using it", () => {
    for (const lastWritten of ["2026-03-01T11:00:00Z", "2026-03-01T11:59:00Z"]) {
      expect(Plan.decideVitestTempDir(new Date(lastWritten), VITEST_STALE_BEFORE)._tag).toBe(
        "Keep",
      );
    }
  });
});

describe("make", () => {
  test("stale Vitest temp directories are reclaimed and fresh ones are kept", () => {
    const plan = Plan.make(
      [
        vitestTempDir("/tmp/AAAAAAAAAAAAAAAAAAAAA", 500, new Date("2026-02-28T00:00:00Z")),
        vitestTempDir("/tmp/BBBBBBBBBBBBBBBBBBBBB", 700, new Date("2026-03-01T11:30:00Z")),
      ],
      policy(deleteCaches),
    );

    expect(plan.reclaiming.map((entry) => entry.target.path)).toEqual([
      "/tmp/AAAAAAAAAAAAAAAAAAAAA",
    ]);
    expect(plan.keeping.map((entry) => entry.target.path)).toEqual(["/tmp/BBBBBBBBBBBBBBBBBBBBB"]);
    expect(plan.reclaimable).toBe(size(500));
    expect(plan.pruning).toEqual([]);
  });

  test("a cache inside a removed worktree is dropped, and one inside a kept worktree is not", () => {
    const plan = Plan.make(
      [
        worktree("/w/app/gone", 900, { _tag: "Clean" }),
        turboCache("/w/app/gone/.turbo/cache", 400),
        worktree("/w/app/kept", 900, { _tag: "TrackedDirty", entries: [" M a.ts"] }),
        turboCache("/w/app/kept/.turbo/cache", 300),
        // Shares a prefix with a removed worktree without being inside it.
        turboCache("/w/app/gone-too/.turbo/cache", 200),
      ],
      policy(deleteCaches),
    );

    expect(plan.reclaiming.map((entry) => entry.target.path)).toEqual([
      "/w/app/gone",
      "/w/app/kept/.turbo/cache",
      "/w/app/gone-too/.turbo/cache",
    ]);
    expect(plan.reclaimable).toBe(size(1400));
  });

  test("turbo caches are always reclaimable", () => {
    const plan = Plan.make([turboCache("/a/.turbo/cache", 1024)], policy(deleteCaches));

    expect(plan.reclaiming).toHaveLength(1);
    expect(plan.keeping).toHaveLength(0);
    expect(plan.reclaimable).toBe(size(1024));
  });

  test("a cache carries the resolved cutoff rather than the option it came from", () => {
    const plan = Plan.make([turboCache("/a/.turbo/cache", 1024)], policy(pruneCaches));

    // Acting on this entry needs nothing but the entry: the cutoff travelled
    // with it, so a confirmation prompt left open across midnight cannot make
    // the deletion select a different set than the report showed.
    expect(plan.reclaiming[0]?.disposition).toEqual(pruneCaches);
  });

  test("dirty worktrees are kept and excluded from the total", () => {
    const plan = Plan.make(
      [
        turboCache("/a/.turbo/cache", 100),
        worktree("/w/dirty", 900, { _tag: "TrackedDirty", entries: [" M a.ts"] }),
      ],
      policy(deleteCaches),
    );

    expect(plan.reclaiming).toHaveLength(1);
    expect(plan.keeping).toHaveLength(1);
    expect(plan.keeping[0]?.disposition.reason).toBe("1 modified tracked file(s)");
    expect(plan.reclaimable).toBe(size(100));
  });

  test("untracked-only worktrees are reclaimable and counted", () => {
    const plan = Plan.make(
      [worktree("/w/untracked", 500, { _tag: "UntrackedOnly", files: ["plans/"], ignored: [] })],
      policy(deleteCaches),
    );

    expect(plan.reclaiming[0]?.disposition._tag).toBe("ArchiveThenDelete");
    expect(plan.reclaimable).toBe(size(500));
  });

  test("empty targets are dropped", () => {
    const plan = Plan.make([turboCache("/empty", 0)], policy(deleteCaches));

    expect(plan.reclaiming).toHaveLength(0);
    expect(plan.keeping).toHaveLength(0);
  });

  test("entries are ordered largest first", () => {
    const plan = Plan.make(
      [turboCache("/small", 10), turboCache("/big", 9000), turboCache("/mid", 500)],
      policy(deleteCaches),
    );

    expect(plan.reclaiming.map((entry) => entry.target.path)).toEqual(["/big", "/mid", "/small"]);
  });

  test("a directory that could not be examined is carried, and never reclaimed", () => {
    const plan = Plan.make(
      [unexamined("/w/app/stray", "could not be inspected: not a git repository")],
      policy(deleteCaches),
    );

    expect(plan.unexamined).toEqual([
      {
        _tag: "Unexamined",
        path: "/w/app/stray",
        reason: "could not be inspected: not a git repository",
      },
    ]);
    expect(plan.reclaiming).toHaveLength(0);
    expect(plan.reclaimable).toBe(size(0));
  });
});

describe("pruning", () => {
  test("names the repository that owns each worktree being removed", () => {
    const plan = Plan.make(
      [
        worktree("/w/app/agent-1", 900, { _tag: "Clean" }, "/src/app"),
        worktree(
          "/w/app/agent-2",
          800,
          { _tag: "UntrackedOnly", files: ["notes.md"], ignored: [] },
          "/src/app",
        ),
        worktree("/w/api/agent-1", 700, { _tag: "Clean" }, "/src/api"),
      ],
      policy(deleteCaches),
    );

    // Each owner once, however many of its worktrees go.
    expect(plan.pruning).toEqual(["/src/api", "/src/app"]);
  });

  test("a repository whose worktree is kept is never pruned", () => {
    const plan = Plan.make(
      [
        worktree("/w/app/agent-1", 900, { _tag: "Clean" }, "/src/app"),
        worktree(
          "/w/other/agent-1",
          900,
          { _tag: "TrackedDirty", entries: [" M a.ts"] },
          "/src/bystander",
        ),
      ],
      policy(deleteCaches),
    );

    expect(plan.pruning).toEqual(["/src/app"]);
  });

  test("a plan that removes no worktree prunes nothing", () => {
    expect(Plan.make([turboCache("/a/.turbo/cache", 1024)], policy(deleteCaches)).pruning).toEqual(
      [],
    );
  });
});

describe("kilobytes", () => {
  test("formats at the largest sensible unit", () => {
    expect(Kilobytes.format(size(512))).toBe("512 KB");
    expect(Kilobytes.format(size(2048))).toBe("2.0 MB");
    expect(Kilobytes.format(size(249_561_088))).toBe("238.0 GB");
  });

  test("rejects fractional and negative sizes", () => {
    expect(Effect.runSync(Effect.flip(Kilobytes.parse(-1)))._tag).toBe("InvalidKilobytes");
    expect(Effect.runSync(Effect.flip(Kilobytes.parse(1.5)))._tag).toBe("InvalidKilobytes");
  });

  test("parses du output fields", () => {
    expect(Effect.runSync(Kilobytes.parseField("  249561088 "))).toBe(size(249_561_088));
    expect(Effect.runSync(Effect.flip(Kilobytes.parseField("abc")))._tag).toBe("InvalidKilobytes");
  });

  test("difference clamps at zero", () => {
    expect(Kilobytes.difference(size(10), size(50))).toBe(size(0));
    expect(Kilobytes.difference(size(50), size(10))).toBe(size(40));
  });
});
