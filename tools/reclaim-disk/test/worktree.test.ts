import { describe, expect, test } from "bun:test";
import { classify, decide, describe as describeState } from "../src/domain/worktree.ts";

describe("classify", () => {
  test("empty output is clean", () => {
    expect(classify([])).toEqual({ _tag: "Clean" });
    expect(classify(["", "   "])).toEqual({ _tag: "Clean" });
  });

  test("only untracked entries", () => {
    const state = classify(["?? plans/", "?? .plans-aside/"]);

    expect(state._tag).toBe("UntrackedOnly");
    expect(state._tag === "UntrackedOnly" ? state.files : []).toEqual(["plans/", ".plans-aside/"]);
  });

  test("any tracked change dominates untracked ones", () => {
    const state = classify(["?? plans/", " M src/index.ts"]);

    expect(state._tag).toBe("TrackedDirty");
  });

  test("staged, renamed, and deleted entries all count as tracked", () => {
    for (const line of ["A  new.ts", "R  old.ts -> new.ts", " D gone.ts", "MM both.ts"]) {
      expect(classify([line])._tag).toBe("TrackedDirty");
    }
  });
});

describe("decide", () => {
  test("clean worktrees are deleted", () => {
    expect(decide({ _tag: "Clean" })).toEqual({ _tag: "Delete" });
  });

  test("untracked-only worktrees are archived first", () => {
    const disposition = decide({ _tag: "UntrackedOnly", files: ["plans/"] });

    expect(disposition._tag).toBe("ArchiveThenDelete");
    expect(disposition._tag === "ArchiveThenDelete" ? disposition.files : []).toEqual(["plans/"]);
  });

  test("tracked changes are never deleted", () => {
    const disposition = decide({ _tag: "TrackedDirty", entries: [" M src/index.ts"] });

    expect(disposition._tag).toBe("Keep");
  });

  test("no state yields Delete except Clean", () => {
    const states = [
      { _tag: "Clean" as const },
      { _tag: "UntrackedOnly" as const, files: ["a"] as const },
      { _tag: "TrackedDirty" as const, entries: ["a"] as const },
    ];

    const deleting = states.filter((state) => decide(state)._tag === "Delete");

    expect(deleting).toHaveLength(1);
    expect(deleting[0]?._tag).toBe("Clean");
  });
});

describe("describeState", () => {
  test("counts are reported", () => {
    expect(describeState({ _tag: "Clean" })).toBe("clean");
    expect(describeState({ _tag: "UntrackedOnly", files: ["a", "b"] })).toBe("2 untracked file(s)");
  });
});
