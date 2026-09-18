import { describe, expect, test } from "bun:test";
import { classify, describe as describeState, equals } from "../src/domain/worktree.ts";

describe("classify", () => {
  test("empty output is clean", () => {
    expect(classify([])).toEqual({ _tag: "Clean" });
    expect(classify([""])).toEqual({ _tag: "Clean" });
  });

  test("only untracked entries", () => {
    const state = classify(["?? plans/", "?? .plans-aside/"]);

    expect(state._tag).toBe("UntrackedOnly");
    expect(state._tag === "UntrackedOnly" ? state.files : []).toEqual(["plans/", ".plans-aside/"]);
  });

  test("only ignored entries are their own state, not clean", () => {
    // `git status --porcelain` alone never prints these, which is what made a
    // worktree holding nothing but a gitignored `.env` read as clean and get
    // deleted with no archive.
    const state = classify(["!! .env", "!! node_modules/"]);

    expect(state).toEqual({ _tag: "IgnoredOnly", ignored: [".env", "node_modules/"] });
  });

  test("ignored entries are carried alongside untracked ones", () => {
    const state = classify(["?? notes.md", "!! .env"]);

    expect(state).toEqual({ _tag: "UntrackedOnly", files: ["notes.md"], ignored: [".env"] });
  });

  test("any tracked change dominates ignored ones", () => {
    expect(classify(["!! .env", " M src/index.ts"])._tag).toBe("TrackedDirty");
  });

  test("a path is taken verbatim, spaces and non-ASCII included", () => {
    // What `git status --porcelain -z` prints for these names. Without `-z`
    // they arrive C-quoted - `"notes \303\246.md"` - and no `tar` can stat that.
    const state = classify(["?? notes æ.md", "?? a b.txt", '?? q"uote.txt', "?? trailing "]);

    expect(state._tag === "UntrackedOnly" ? state.files : []).toEqual([
      "notes æ.md",
      "a b.txt",
      'q"uote.txt',
      "trailing ",
    ]);
  });

  test("any tracked change dominates untracked ones", () => {
    const state = classify(["?? plans/", " M src/index.ts"]);

    expect(state._tag).toBe("TrackedDirty");
  });

  test("staged, renamed, and deleted entries all count as tracked", () => {
    for (const record of ["A  new.ts", " D gone.ts", "MM both.ts"]) {
      expect(classify([record])._tag).toBe("TrackedDirty");
    }
  });

  test("a rename is one entry, and its origin path is not read as a file", () => {
    // `-z` spells a rename across two records: the new path with the status,
    // then the origin path on its own. Counting the second would inflate the
    // report, and archiving it would be archiving a file that no longer exists.
    const state = classify(["R  renamed.ts", "?? origin.ts", " M other.ts"]);

    expect(state).toEqual({ _tag: "TrackedDirty", entries: ["R  renamed.ts", " M other.ts"] });
  });
});

describe("equals", () => {
  test("two readings of the same working tree match", () => {
    expect(equals({ _tag: "Clean" }, { _tag: "Clean" })).toBe(true);
    expect(
      equals(
        { _tag: "UntrackedOnly", files: ["a", "b"], ignored: [] },
        { _tag: "UntrackedOnly", files: ["a", "b"], ignored: [] },
      ),
    ).toBe(true);
  });

  test("a worktree that gained a file no longer matches", () => {
    // The disposition would still be "archive, then delete" - but the archive
    // would be built from the old list and the delete would take the new file.
    expect(
      equals(
        { _tag: "UntrackedOnly", files: ["a"], ignored: [] },
        { _tag: "UntrackedOnly", files: ["a", "later.md"], ignored: [] },
      ),
    ).toBe(false);
  });

  test("a clean worktree that became dirty no longer matches", () => {
    expect(equals({ _tag: "Clean" }, { _tag: "TrackedDirty", entries: [" M a.ts"] })).toBe(false);
    expect(equals({ _tag: "Clean" }, { _tag: "UntrackedOnly", files: ["a"], ignored: [] })).toBe(
      false,
    );
  });

  test("a worktree that gained an ignored path no longer matches", () => {
    // The `.env` an agent's setup writes while the prompt is open would
    // otherwise be deleted without ever entering an archive.
    expect(
      equals(
        { _tag: "UntrackedOnly", files: ["a"], ignored: [] },
        { _tag: "UntrackedOnly", files: ["a"], ignored: [".env"] },
      ),
    ).toBe(false);
    expect(equals({ _tag: "Clean" }, { _tag: "IgnoredOnly", ignored: [".env"] })).toBe(false);
  });
});

describe("describeState", () => {
  test("counts are reported", () => {
    expect(describeState({ _tag: "Clean" })).toBe("clean");
    expect(describeState({ _tag: "UntrackedOnly", files: ["a", "b"], ignored: [] })).toBe(
      "2 untracked file(s)",
    );
  });

  test("ignored paths are counted out loud rather than folded into clean", () => {
    // What the report row says is what the human confirming the delete sees.
    expect(describeState({ _tag: "IgnoredOnly", ignored: [".env"] })).toBe("1 ignored path(s)");
    expect(
      describeState({ _tag: "UntrackedOnly", files: ["a"], ignored: [".env", ".cache"] }),
    ).toBe("1 untracked file(s), 2 ignored path(s)");
  });
});
