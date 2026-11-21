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
  entries: ReadonlyArray<VitestTemp.DirectoryEntry>,
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

describe("screen", () => {
  test("a nanoid-named directory holding only directories is a candidate naming each of them", () => {
    expect(
      VitestTemp.screen(NAME, [
        { name: "ssr", kind: "Directory" },
        { name: "client", kind: "Directory" },
      ]),
    ).toEqual({ _tag: "Candidate", environments: ["ssr", "client"] });
  });

  test("a file or symlink beside the directories rules it out before any is read", () => {
    for (const kind of ["File", "Other"] as const) {
      expect(
        VitestTemp.screen(NAME, [
          { name: "packages", kind: "Directory" },
          { name: "package.json", kind },
        ]),
      ).toEqual({ _tag: "Unrecognised", reason: "holds package.json, which is not a directory" });
    }
  });

  test("a name that is not a nanoid rules it out whatever it holds", () => {
    expect(VitestTemp.screen("not-a-nanoid", [{ name: "ssr", kind: "Directory" }])._tag).toBe(
      "Unrecognised",
    );
  });
});

describe("screenEnvironment", () => {
  test("an environment of transformed modules counts them and carries when it was written", () => {
    expect(
      VitestTemp.screenEnvironment(
        environment("ssr", LATE, [
          { name: MODULE, kind: "File" },
          { name: "da39a3ee5e6b4b0d3255bfef95601890afd80709", kind: "File" },
        ]),
      ),
    ).toEqual({ _tag: "Modules", modules: 2, lastWritten: LATE });
  });

  test("one entry that is not a transformed module disqualifies the candidate on its own", () => {
    expect(
      VitestTemp.screenEnvironment(
        environment("packages", EARLY, [{ name: "README.md", kind: "File" }]),
      ),
    ).toEqual({ _tag: "Unrecognised", reason: "packages/README.md is not a transformed module" });
  });

  test("an entry that is not a directory disqualifies the candidate", () => {
    expect(VitestTemp.screenEnvironment({ kind: "Other", name: "ssr" })).toEqual({
      _tag: "Unrecognised",
      reason: "holds ssr, which is not a directory",
    });
  });

  test("an empty environment adds no modules without disqualifying the candidate", () => {
    expect(VitestTemp.screenEnvironment(environment("ssr", EARLY, []))).toEqual({
      _tag: "Modules",
      modules: 0,
      lastWritten: EARLY,
    });
  });
});
