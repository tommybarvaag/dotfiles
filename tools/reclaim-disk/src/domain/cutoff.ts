/**
 * How old a turbo cache entry must be before this tool will delete it.
 *
 * A day count is a moving target: resolved at the start of a run it names one
 * set of entries, resolved a minute later it names another. So `--age 30` is
 * parsed once, at the command line, and resolved once into the instant it
 * refers to. That resolved cutoff is what the plan carries, what the report
 * prints, and what the deletion is given — a run that crosses midnight while
 * the confirmation prompt is open still deletes exactly what it showed.
 *
 * Parsing returns an `Option` rather than a typed error because there is
 * exactly one way for an age to be wrong, and the command line owns the
 * wording of that message.
 */
import { Option } from "effect";

declare const AgeInDaysBrand: unique symbol;

declare const CutoffBrand: unique symbol;

/** A whole number of days, one or more. */
export type AgeInDays = number & { readonly [AgeInDaysBrand]: true };

/** The instant before which a cache entry counts as stale. */
export type Cutoff = Date & { readonly [CutoffBrand]: true };

/** Milliseconds in a day. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * Parse an age in days from an untrusted number.
 *
 * Zero and negative ages are rejected rather than resolved: `--age -5` would
 * otherwise produce a cutoff in the *future*, which every entry predates, so a
 * run that promised to prune stale entries would delete the whole cache.
 *
 * @param value - The candidate number of days.
 * @returns The branded age, or `None` when the value is not a positive whole number of days.
 */
export function parseAgeInDays(value: number): Option.Option<AgeInDays> {
  if (!Number.isInteger(value) || value < 1) {
    return Option.none();
  }

  // SAFETY: TypeScript cannot express the brand. The guard above proved the value is a whole number of at least one day, which is the whole AgeInDays invariant, and this parser is the only way to brand a number as one.
  return Option.some(value as AgeInDays);
}

/**
 * Resolve an age into the instant that many days before a starting point.
 *
 * Total, because an `AgeInDays` is positive by construction.
 *
 * @param now - The instant the run started.
 * @param age - How many days before `now` the cutoff falls.
 * @returns The resolved cutoff.
 */
export function before(now: Date, age: AgeInDays): Cutoff {
  // SAFETY: TypeScript cannot express the brand. `age` is at least one day by construction, so the result lies strictly before `now`, which is the whole Cutoff invariant.
  return new Date(now.getTime() - age * DAY) as Cutoff;
}

/**
 * Render a cutoff as the instant it is, in UTC.
 *
 * One rendering, used by both the report and the deletion, so the two cannot
 * name different moments. It has to carry the time and the offset: `find
 * -newermt` accepts a bare `YYYY-MM-DD` but reads it as *local* midnight, so a
 * cutoff truncated to its day would be enforced hours away from the instant
 * the domain resolved - earlier east of UTC, and later west of it, where the
 * run would delete entries the report said it would keep.
 *
 * @param cutoff - The resolved cutoff.
 * @returns The instant as `YYYY-MM-DD HH:MM:SS +0000`.
 */
export function format(cutoff: Cutoff): string {
  // `toISOString` is fixed-width: `YYYY-MM-DDTHH:mm:ss.sssZ`.
  const iso = cutoff.toISOString();

  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`;
}
