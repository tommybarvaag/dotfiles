import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import * as Kilobytes from "../src/domain/kilobytes.ts";
import * as Plan from "../src/domain/plan.ts";
import type { ReclaimTarget } from "../src/domain/plan.ts";

/** Brand a literal size for fixtures, failing loudly on a bad literal. */
function size(value: number): Kilobytes.Kilobytes {
  return Effect.runSync(Kilobytes.parse(value));
}

function turboCache(path: string, kb: number): ReclaimTarget {
  return { _tag: "TurboCache", path, size: size(kb), prunedByAge: false };
}

describe("make", () => {
  test("turbo caches are always reclaimable", () => {
    const plan = Plan.make([turboCache("/a/.turbo/cache", 1024)]);

    expect(plan.reclaiming).toHaveLength(1);
    expect(plan.keeping).toHaveLength(0);
    expect(plan.reclaimable).toBe(size(1024));
  });

  test("dirty worktrees are kept and excluded from the total", () => {
    const plan = Plan.make([
      turboCache("/a/.turbo/cache", 100),
      {
        _tag: "AgentWorktree",
        path: "/w/dirty",
        size: size(900),
        state: { _tag: "TrackedDirty", entries: [" M a.ts"] },
      },
    ]);

    expect(plan.reclaiming).toHaveLength(1);
    expect(plan.keeping).toHaveLength(1);
    expect(plan.reclaimable).toBe(size(100));
  });

  test("untracked-only worktrees are reclaimable and counted", () => {
    const plan = Plan.make([
      {
        _tag: "AgentWorktree",
        path: "/w/untracked",
        size: size(500),
        state: { _tag: "UntrackedOnly", files: ["plans/"] },
      },
    ]);

    expect(plan.reclaiming[0]?.disposition._tag).toBe("ArchiveThenDelete");
    expect(plan.reclaimable).toBe(size(500));
  });

  test("empty targets are dropped", () => {
    const plan = Plan.make([turboCache("/empty", 0)]);

    expect(plan.reclaiming).toHaveLength(0);
    expect(plan.keeping).toHaveLength(0);
  });

  test("entries are ordered largest first", () => {
    const plan = Plan.make([
      turboCache("/small", 10),
      turboCache("/big", 9000),
      turboCache("/mid", 500),
    ]);

    expect(plan.reclaiming.map((entry) => entry.target.path)).toEqual(["/big", "/mid", "/small"]);
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
