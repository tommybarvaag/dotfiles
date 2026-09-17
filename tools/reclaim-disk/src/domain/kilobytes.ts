/**
 * Disk sizes measured in kilobytes.
 *
 * Every size in this tool comes from `du -sk` or `df -k`, so kilobytes are the
 * single unit crossing module boundaries. Branding stops a raw byte or
 * megabyte count from being passed where a kilobyte count is expected.
 */
import { Effect, Schema } from "effect";

declare const KilobytesBrand: unique symbol;

/** A non-negative, integral disk size in kilobytes. */
export type Kilobytes = number & { readonly [KilobytesBrand]: true };

/** A value that could not be parsed as a non-negative integral kilobyte count. */
export class InvalidKilobytes extends Schema.TaggedError<InvalidKilobytes>()("InvalidKilobytes", {
  received: Schema.String,
}) {}

/** A size of zero. */
// SAFETY: 0 is finite, integral, and non-negative, so it satisfies the Kilobytes invariant by inspection.
export const zero = 0 as Kilobytes;

/**
 * Parse a kilobyte count from an untrusted number.
 *
 * @param value - The candidate size.
 * @returns The branded size, failing with `InvalidKilobytes` when the value is negative, fractional, or not finite.
 */
export function parse(value: number): Effect.Effect<Kilobytes, InvalidKilobytes> {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return Effect.fail(new InvalidKilobytes({ received: String(value) }));
  }

  // SAFETY: TypeScript cannot express the brand. The guard above proved the value is finite, integral, and non-negative, which is the whole Kilobytes invariant. `parse` and `parseField` are the only ways to brand an arbitrary number.
  return Effect.succeed(value as Kilobytes);
}

/**
 * Parse a kilobyte count from the leading integer field of command output.
 *
 * `du -sk` and `df -k` both emit whitespace-separated columns whose first
 * numeric field is the size.
 *
 * @param text - The raw output field.
 * @returns The branded size, failing with `InvalidKilobytes` when no leading integer is present.
 */
export function parseField(text: string): Effect.Effect<Kilobytes, InvalidKilobytes> {
  const trimmed = text.trim();

  if (!/^\d+$/.test(trimmed)) {
    return Effect.fail(new InvalidKilobytes({ received: text }));
  }

  return parse(Number.parseInt(trimmed, 10));
}

/**
 * Add two sizes.
 *
 * @param left - The first size.
 * @param right - The second size.
 * @returns The summed size.
 */
export function add(left: Kilobytes, right: Kilobytes): Kilobytes {
  // SAFETY: The sum of two non-negative integers is a non-negative integer, so the Kilobytes invariant is preserved without re-parsing.
  return (left + right) as Kilobytes;
}

/**
 * Sum a collection of sizes.
 *
 * @param sizes - The sizes to total.
 * @returns The combined size, or zero when the collection is empty.
 */
export function sum(sizes: Iterable<Kilobytes>): Kilobytes {
  let total = zero;

  for (const size of sizes) {
    total = add(total, size);
  }

  return total;
}

/**
 * Subtract one size from another, clamping at zero.
 *
 * Used to report freed space, where a concurrent write can make the later
 * reading smaller than the earlier one.
 *
 * @param later - The size measured second.
 * @param earlier - The size measured first.
 * @returns The non-negative difference.
 */
export function difference(later: Kilobytes, earlier: Kilobytes): Kilobytes {
  // SAFETY: Math.max clamps the result at 0, and the difference of two integers is an integer, so the Kilobytes invariant holds.
  return Math.max(0, later - earlier) as Kilobytes;
}

/**
 * Render a size for human reading, choosing the largest unit that keeps the
 * number above one.
 *
 * @param size - The size to render.
 * @returns A string such as `"238.4 GB"`, `"1.5 MB"`, or `"812 KB"`.
 */
export function format(size: Kilobytes): string {
  if (size >= 1_048_576) {
    return `${(size / 1_048_576).toFixed(1)} GB`;
  }

  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} MB`;
  }

  return `${size} KB`;
}

/**
 * Determine whether a size is worth reporting.
 *
 * @param size - The size to test.
 * @returns `true` when the size is greater than zero.
 */
export function isSignificant(size: Kilobytes): boolean {
  return size > 0;
}
