import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import * as Cutoff from "../src/domain/cutoff.ts";

/** Brand an age for fixtures, failing loudly on a bad literal. */
function age(days: number): Cutoff.AgeInDays {
  return Option.getOrThrow(Cutoff.parseAgeInDays(days));
}

const now = new Date("2026-03-01T12:00:00Z");

describe("parseAgeInDays", () => {
  test("accepts whole days of at least one", () => {
    expect(Cutoff.parseAgeInDays(1)).toEqual(Option.some(age(1)));
    expect(Cutoff.parseAgeInDays(3_650)).toEqual(Option.some(age(3_650)));
  });

  test("rejects zero and negative ages", () => {
    // A negative age would resolve to a cutoff in the future, which every
    // entry predates - so `--age -5` would delete a whole cache under a report
    // promising stale entries only.
    expect(Cutoff.parseAgeInDays(0)).toEqual(Option.none());
    expect(Cutoff.parseAgeInDays(-5)).toEqual(Option.none());
  });

  test("rejects fractional ages", () => {
    expect(Cutoff.parseAgeInDays(1.5)).toEqual(Option.none());
    expect(Cutoff.parseAgeInDays(Number.NaN)).toEqual(Option.none());
  });
});

describe("before", () => {
  test("resolves an age to an instant that many days earlier", () => {
    expect(Cutoff.format(Cutoff.before(now, age(30)))).toBe("2026-01-30 12:00:00 +0000");
    expect(Cutoff.format(Cutoff.before(now, age(1)))).toBe("2026-02-28 12:00:00 +0000");
  });

  test("a resolved cutoff never moves", () => {
    const cutoff = Cutoff.before(now, age(30));

    // The whole point of resolving once: crossing midnight between the survey
    // and the deletion cannot change which entries were selected.
    expect(Cutoff.format(cutoff)).toBe(Cutoff.format(cutoff));
    expect(cutoff.getTime()).toBeLessThan(now.getTime());
  });
});

describe("format", () => {
  test("renders the whole instant, not the day it falls on", () => {
    // The time of day and the offset are what stop `find -newermt` reading the
    // cutoff as local midnight, which is a different moment in every timezone -
    // and, west of UTC, a later one than the report names.
    const cutoff = Cutoff.before(new Date("2026-09-16T23:30:00Z"), age(1));

    expect(Cutoff.format(cutoff)).toBe("2026-09-15 23:30:00 +0000");
  });

  test("the rendered instant is the resolved one", () => {
    const cutoff = Cutoff.before(now, age(7));

    expect(new Date(Cutoff.format(cutoff).replace(" +0000", "Z").replace(" ", "T")).getTime()).toBe(
      cutoff.getTime(),
    );
  });
});
