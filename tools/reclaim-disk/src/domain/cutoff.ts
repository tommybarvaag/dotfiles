/**
 * How old a turbo cache entry, or a Vitest temp directory, must be before this
 * tool will delete it.
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

/** A whole number of days, from one to `MAX_AGE_IN_DAYS`. */
export type AgeInDays = number & { readonly [AgeInDaysBrand]: true };

/** The instant before which a cache entry counts as stale. */
export type Cutoff = Date & { readonly [CutoffBrand]: true };

/** Milliseconds in an hour. */
const HOUR = 60 * 60 * 1000;

/** Milliseconds in a day. */
const DAY = 24 * HOUR;

/**
 * The oldest age `--age` accepts, in days: ten years.
 *
 * An unbounded age is not merely silly. Large enough, it resolves to a `Date`
 * that is not an instant at all, which `format` cannot render; well before
 * that it reaches back past 1970, which macOS `find -newermt` cannot parse.
 * Ten years back from any plausible run lands comfortably after both.
 */
export const MAX_AGE_IN_DAYS = 3_650;

/** The oldest age `--temp-age` accepts, in hours: the same ten years. */
export const MAX_AGE_IN_HOURS = MAX_AGE_IN_DAYS * 24;

/**
 * Whether a number is a whole count from one to a bound, the rule every age shares.
 *
 * @param value - The candidate count.
 * @param max - The largest count accepted.
 * @returns `true` when the value is a whole number between 1 and `max`.
 */
function isWholeUpTo(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/**
 * Parse an age in days from an untrusted number.
 *
 * Zero and negative ages are rejected rather than resolved: `--age -5` would
 * otherwise produce a cutoff in the *future*, which every entry predates, so a
 * run that promised to prune stale entries would delete the whole cache. Ages
 * past `MAX_AGE_IN_DAYS` are rejected too, so every accepted age resolves to a
 * real instant after 1970.
 *
 * @param value - The candidate number of days.
 * @returns The branded age, or `None` when the value is not a whole number of days between 1 and `MAX_AGE_IN_DAYS`.
 */
export function parseAgeInDays(value: number): Option.Option<AgeInDays> {
  if (!isWholeUpTo(value, MAX_AGE_IN_DAYS)) {
    return Option.none();
  }

  // SAFETY: TypeScript cannot express the brand. The guard above proved the value is a whole number of days between 1 and MAX_AGE_IN_DAYS, which is the whole AgeInDays invariant, and this parser is the only way to brand a number as one.
  return Option.some(value as AgeInDays);
}

/**
 * Resolve an age into the instant that many days before a starting point.
 *
 * Total, because an `AgeInDays` is positive and bounded by construction.
 *
 * @param now - The instant the run started.
 * @param age - How many days before `now` the cutoff falls.
 * @returns The resolved cutoff.
 */
export function before(now: Date, age: AgeInDays): Cutoff {
  // SAFETY: TypeScript cannot express the brand. `age` is between one day and MAX_AGE_IN_DAYS by construction, so the result is a valid instant strictly before `now`, which is the whole Cutoff invariant.
  return new Date(now.getTime() - age * DAY) as Cutoff;
}

declare const AgeInHoursBrand: unique symbol;

/** A whole number of hours, from one to `MAX_AGE_IN_HOURS`. */
export type AgeInHours = number & { readonly [AgeInHoursBrand]: true };

/**
 * Parse an age in hours from an untrusted number.
 *
 * The same rule as days, for the same reason: a zero or negative age would
 * resolve to a cutoff every Vitest temp directory predates, including the one
 * a run is writing into right now. The upper bound is `MAX_AGE_IN_HOURS`, for
 * the same reason as `MAX_AGE_IN_DAYS`.
 *
 * @param value - The candidate number of hours.
 * @returns The branded age, or `None` when the value is not a whole number of hours between 1 and `MAX_AGE_IN_HOURS`.
 */
export function parseAgeInHours(value: number): Option.Option<AgeInHours> {
  if (!isWholeUpTo(value, MAX_AGE_IN_HOURS)) {
    return Option.none();
  }

  // SAFETY: TypeScript cannot express the brand. The guard above proved the value is a whole number of hours between 1 and MAX_AGE_IN_HOURS, which is the whole AgeInHours invariant, and this parser is the only way to brand a number as one.
  return Option.some(value as AgeInHours);
}

/**
 * Resolve an age in hours into the instant that many hours before a starting point.
 *
 * @param now - The instant the run started.
 * @param age - How many hours before `now` the cutoff falls.
 * @returns The resolved cutoff.
 */
export function hoursBefore(now: Date, age: AgeInHours): Cutoff {
  // SAFETY: TypeScript cannot express the brand. `age` is between one hour and MAX_AGE_IN_HOURS by construction, so the result is a valid instant strictly before `now`, which is the whole Cutoff invariant.
  return new Date(now.getTime() - age * HOUR) as Cutoff;
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
