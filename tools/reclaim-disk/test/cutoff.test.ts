import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import * as Cutoff from "../src/domain/cutoff.ts";

/** Brand an age for fixtures, failing loudly on a bad literal. */
function age(days: number): Cutoff.AgeInDays {
  return Option.getOrThrow(Cutoff.parseAgeInDays(days));
}

/** Brand an age in hours for fixtures, failing loudly on a bad literal. */
function hours(count: number): Cutoff.AgeInHours {
  return Option.getOrThrow(Cutoff.parseAgeInHours(count));
}

const now = new Date("2026-03-01T12:00:00Z");

describe("parseAgeInDays", () => {
  test("accepts whole days of at least one", () => {
    expect(Cutoff.parseAgeInDays(1)).toEqual(Option.some(age(1)));
    expect(Cutoff.parseAgeInDays(3_650)).toEqual(Option.some(age(3_650)));
  });

  test("rejects zero and negative ages", () => {
    expect(Cutoff.parseAgeInDays(-1)).toEqual(Option.none());
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

describe("the age bound", () => {
  test("accepts every whole number of days from 1 to the bound, and nothing past it", () => {
    expect(Cutoff.parseAgeInDays(Cutoff.MAX_AGE_IN_DAYS)).toEqual(
      Option.some(age(Cutoff.MAX_AGE_IN_DAYS)),
    );
    expect(Cutoff.parseAgeInDays(Cutoff.MAX_AGE_IN_DAYS + 1)).toEqual(Option.none());
    expect(Cutoff.parseAgeInDays(999_999_999_999)).toEqual(Option.none());
  });

  test("accepts every whole number of hours from 1 to the bound, and nothing past it", () => {
    expect(Cutoff.parseAgeInHours(1)).toEqual(Option.some(hours(1)));
    expect(Cutoff.parseAgeInHours(Cutoff.MAX_AGE_IN_HOURS)).toEqual(
      Option.some(hours(Cutoff.MAX_AGE_IN_HOURS)),
    );
    expect(Cutoff.parseAgeInHours(0)).toEqual(Option.none());
    expect(Cutoff.parseAgeInHours(-1)).toEqual(Option.none());
    expect(Cutoff.parseAgeInHours(1.5)).toEqual(Option.none());
    expect(Cutoff.parseAgeInHours(Cutoff.MAX_AGE_IN_HOURS + 1)).toEqual(Option.none());
    expect(Cutoff.parseAgeInHours(999_999_999_999)).toEqual(Option.none());
  });

  test("the oldest cutoff either parser allows is a real instant after 1970", () => {
    // `find -newermt` cannot parse a date before 1970 on macOS, and an age
    // large enough to overflow `Date` resolves to an Invalid Date that
    // `format` cannot render at all.
    const oldest = [
      Cutoff.before(now, age(Cutoff.MAX_AGE_IN_DAYS)),
      Cutoff.hoursBefore(now, hours(Cutoff.MAX_AGE_IN_HOURS)),
    ];

    for (const cutoff of oldest) {
      expect(cutoff.getTime()).toBeGreaterThan(0);
      expect(() => Cutoff.format(cutoff)).not.toThrow();
    }
  });
});

describe("hoursBefore", () => {
  test("resolves an age to an instant exactly that many hours earlier", () => {
    expect(now.getTime() - Cutoff.hoursBefore(now, hours(1)).getTime()).toBe(60 * 60 * 1000);
    expect(Cutoff.format(Cutoff.hoursBefore(now, hours(36)))).toBe("2026-02-28 00:00:00 +0000");
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
