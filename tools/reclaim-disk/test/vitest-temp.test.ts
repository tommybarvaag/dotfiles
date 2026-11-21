/**
 * The rule that decides a temp directory is Vitest's, over plain listings.
 *
 * Every decoy here is a shape that really sat in a temp root beside Vitest's
 * directories: a repository checkout and a log directory with 21-character
 * names, and near-misses of Vitest's own layout.
 */
import { describe, expect, test } from "bun:test";
import * as VitestTemp from "../src/domain/vitest-temp.ts";

const NAME = "Cjkj_H4LKz5PpUh7WCbX1";
const MODULE = "45ece3b38edbf99024eeaa7c9b262c9cdc2d262b";
const EARLY = new Date("2026-11-21T09:00:00Z");
const LATE = new Date("2026-11-21T10:56:00Z");

function environment(
  name: string,
  modified: Date,
  entries: ReadonlyArray<VitestTemp.ModuleEntry>,
): VitestTemp.ProjectEntry {
  return { kind: "Directory", name, modified, entries };
}

function listing(
  entries: ReadonlyArray<VitestTemp.ProjectEntry>,
  name = NAME,
): VitestTemp.ProjectListing {
  return { name, modified: EARLY, entries };
}

describe("isCandidateName", () => {
  test("accepts exactly 21 nanoid characters", () => {
    expect(VitestTemp.isCandidateName(NAME)).toBe(true);
    expect(VitestTemp.isCandidateName("-_-4IS0myTJXSXM7B4Rn-")).toBe(true);
  });

  test("rejects other lengths and characters", () => {
    expect(VitestTemp.isCandidateName("Cjkj_H4LKz5PpUh7WCbX")).toBe(false);
    expect(VitestTemp.isCandidateName("Cjkj_H4LKz5PpUh7WCbX12")).toBe(false);
    expect(VitestTemp.isCandidateName("Cjkj.H4LKz5PpUh7WCbX1")).toBe(false);
  });
});

describe("recognise", () => {
  test("a project holding environments of transformed modules is recognised, dated by its newest write", () => {
    const recognition = VitestTemp.recognise(
      listing([
        environment("ssr", LATE, [{ name: MODULE, kind: "File" }]),
        environment("client", EARLY, [{ name: MODULE, kind: "File" }]),
      ]),
    );

    expect(recognition).toEqual({ _tag: "Recognised", lastWritten: LATE });
  });

  test("a repository checkout with a nanoid-shaped name is not", () => {
    const recognition = VitestTemp.recognise(
      listing(
        [
          { kind: "File", name: "package.json" },
          environment("packages", EARLY, [{ name: "app", kind: "Directory" }]),
        ],
        "toast-review-ha6vdvqk",
      ),
    );

    expect(recognition._tag).toBe("Unrecognised");
  });

  test("a directory of log files with a nanoid-shaped name is not", () => {
    const recognition = VitestTemp.recognise(
      listing([{ kind: "File", name: "latest.log" }], "cursor-agent-logs-501"),
    );

    expect(recognition._tag).toBe("Unrecognised");
  });

  test("one file not named by a SHA-1 disqualifies the whole directory", () => {
    const recognition = VitestTemp.recognise(
      listing([
        environment("ssr", EARLY, [
          { name: MODULE, kind: "File" },
          { name: "notes.md", kind: "File" },
        ]),
      ]),
    );

    expect(recognition).toEqual({
      _tag: "Unrecognised",
      reason: "ssr/notes.md is not a transformed module",
    });
  });

  test("a symlink or a nested directory disqualifies it, whatever it is named", () => {
    for (const kind of ["Other", "Directory"] as const) {
      const recognition = VitestTemp.recognise(
        listing([environment("ssr", EARLY, [{ name: MODULE, kind }])]),
      );

      expect(recognition._tag).toBe("Unrecognised");
    }
  });

  test("a project holding no modules is evidence of nothing", () => {
    expect(VitestTemp.recognise(listing([environment("ssr", EARLY, [])]))._tag).toBe(
      "Unrecognised",
    );
    expect(VitestTemp.recognise(listing([]))._tag).toBe("Unrecognised");
  });
});
