import { err, ok, type Result } from "./result.ts";

/** Raised when untrusted JSON does not have the shape a decoder expects. */
export class ShapeMismatch extends Error {
  readonly _tag = "ShapeMismatch" as const;
  /** JSON path of the offending value, such as `$.data.repository.pullRequest.state`. */
  readonly path: string;
  /** A short description of the expected shape. */
  readonly expected: string;

  /**
   * @param path - JSON path of the offending value.
   * @param expected - A short description of the expected shape.
   */
  constructor(path: string, expected: string) {
    super(`Expected ${expected} at ${path}`);
    this.path = path;
    this.expected = expected;
  }
}

/** Turns an unknown value at a JSON path into a typed value, or explains why it cannot. */
export type Decoder<T> = (input: unknown, path: string) => Result<T, ShapeMismatch>;

/** The value type a decoder produces. */
export type Decoded<D> = D extends Decoder<infer T> ? T : never;

/** Decode a string. */
export const string: Decoder<string> = (input, path) =>
  typeof input === "string" ? ok(input) : err(new ShapeMismatch(path, "string"));

/** Decode a finite number. */
export const number: Decoder<number> = (input, path) =>
  typeof input === "number" && Number.isFinite(input) ? ok(input) : err(new ShapeMismatch(path, "number"));

/** Decode a boolean. */
export const boolean: Decoder<boolean> = (input, path) =>
  typeof input === "boolean" ? ok(input) : err(new ShapeMismatch(path, "boolean"));

/**
 * Decode one of a fixed set of literals, such as a protocol enum. Anything else is a mismatch,
 * so a value the forge adds later surfaces as a typed error instead of a silent default.
 *
 * @param values - The accepted literals.
 * @returns A decoder for the literal union.
 */
export function literal<const L extends string | number>(values: ReadonlyArray<L>): Decoder<L> {
  return (input, path) => {
    const match = values.find((value) => value === input);
    return match === undefined
      ? err(new ShapeMismatch(path, `one of ${values.map((value) => JSON.stringify(value)).join("|")}`))
      : ok(match);
  };
}

/**
 * Decode exactly one primitive value.
 *
 * @param value - The only accepted value.
 * @returns A decoder for that value.
 */
export function constant<const V extends string | number | boolean>(value: V): Decoder<V> {
  return (input, path) => (input === value ? ok(value) : err(new ShapeMismatch(path, JSON.stringify(value))));
}

/**
 * Decode a value that may be `null` or absent, normalizing both to `null`.
 *
 * @param decoder - Decoder for the present value.
 * @returns A decoder that yields `null` for missing values.
 */
export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return (input, path) => (input === null || input === undefined ? ok(null) : decoder(input, path));
}

/**
 * Decode a value that may be absent, substituting a default.
 *
 * @param decoder - Decoder for the present value.
 * @param fallback - Value used when the input is `null` or absent.
 * @returns A decoder that never yields `null`.
 */
export function withDefault<T>(decoder: Decoder<T>, fallback: T): Decoder<T> {
  return (input, path) => (input === null || input === undefined ? ok(fallback) : decoder(input, path));
}

/**
 * Decode an array whose every element matches a decoder.
 *
 * @param decoder - Decoder applied to each element.
 * @returns A decoder for the array.
 */
export function array<T>(decoder: Decoder<T>): Decoder<ReadonlyArray<T>> {
  return (input, path) => {
    if (!Array.isArray(input)) return err(new ShapeMismatch(path, "array"));
    const values: T[] = [];
    for (const [index, element] of input.entries()) {
      const decoded = decoder(element, `${path}[${index}]`);
      if (decoded._tag === "err") return decoded;
      values.push(decoded.value);
    }
    return ok(values);
  };
}

/**
 * Decode an object with a known set of fields. Unlisted fields are ignored.
 *
 * @param shape - One decoder per field.
 * @returns A decoder for the object.
 */
export function object<S extends Record<string, Decoder<unknown>>>(
  shape: S,
): Decoder<{ readonly [K in keyof S]: Decoded<S[K]> }> {
  return (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return err(new ShapeMismatch(path, "object"));
    }
    const output: Record<string, unknown> = {};
    for (const [key, decoder] of Object.entries(shape)) {
      const decoded = decoder(Reflect.get(input, key), `${path}.${key}`);
      if (decoded._tag === "err") return decoded;
      output[key] = decoded.value;
    }
    // SAFETY: every key of `shape` was decoded by its own decoder above, so `output` holds exactly
    // the decoded type of each field. TypeScript cannot track that through Object.entries.
    return ok(output as { readonly [K in keyof S]: Decoded<S[K]> });
  };
}

/**
 * Decode the first alternative that matches, such as one member of a GraphQL union.
 *
 * @param first - The first alternative to try.
 * @param second - The alternative tried when the first fails.
 * @returns A decoder for either shape.
 */
export function either<A, B>(first: Decoder<A>, second: Decoder<B>): Decoder<A | B> {
  return (input, path) => {
    const decoded = first(input, path);
    return decoded._tag === "ok" ? decoded : second(input, path);
  };
}

/**
 * Transform a decoded value.
 *
 * @param decoder - The decoder to run first.
 * @param transform - Applied to its success value.
 * @returns A decoder yielding the transformed value.
 */
export function map<A, B>(decoder: Decoder<A>, transform: (value: A) => B): Decoder<B> {
  return (input, path) => {
    const decoded = decoder(input, path);
    return decoded._tag === "err" ? decoded : ok(transform(decoded.value));
  };
}

/**
 * Parse JSON text and decode it in one step.
 *
 * @param text - Raw JSON text, typically CLI stdout.
 * @param decoder - Decoder for the top-level value.
 * @returns The decoded value, or a mismatch at `$` when the text is not JSON.
 */
export function decodeJson<T>(text: string, decoder: Decoder<T>): Result<T, ShapeMismatch> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(new ShapeMismatch("$", "valid JSON"));
  }
  return decoder(parsed, "$");
}
