/**
 * Boundary parsing for untrusted CLI JSON: two Effect Schema field helpers the forge protocols
 * need (`nullable`, `withDefault`), and {@link decodeJson}, which parses text and translates any
 * schema failure into one {@link ShapeMismatch} that names where the input went wrong.
 *
 * Protocol enums are decoded with `Schema.Literals`, so a value a forge adds later fails closed
 * as a `ShapeMismatch` instead of being silently defaulted.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

/** Raised when untrusted JSON does not have the shape a schema expects. */
export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("ShapeMismatch", {
  /** JSON path of the offending value, such as `$.data.repository.pullRequest.state`. */
  path: Schema.String,
  /** A short description of what was expected there. */
  expected: Schema.String,
}) {
  /** Where the input went wrong and what was expected. */
  override get message(): string {
    return `Expected ${this.expected} at ${this.path}`;
  }
}

/**
 * A field that may be `null` or absent, normalizing both to `null`.
 *
 * @template S - The schema of a present value.
 * @param schema - Schema for the present value.
 * @returns A struct field schema whose decoded type is `S["Type"] | null`.
 */
export function nullable<S extends Schema.Top>(schema: S) {
  return withDefault(Schema.NullOr(schema), null);
}

/**
 * A field that may be `null` or absent, substituting a fallback for both.
 *
 * @template S - The schema of a present value.
 * @param schema - Schema for the present value.
 * @param fallback - Encoded value used when the input is `null` or absent.
 * @returns A struct field schema that never yields the fallback's absence.
 */
export function withDefault<S extends Schema.Top>(schema: S, fallback: S["Encoded"]) {
  return Schema.optionalKey(Schema.NullishOr(Schema.toEncoded(schema))).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transformOptional((present) =>
        Option.some(Option.getOrElse(Option.filter(present, (value) => value !== null && value !== undefined), () => fallback)),
      ),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
}

const standardFormatter = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Translate a schema failure into a `ShapeMismatch` naming the first offending path.
 *
 * @param error - The schema failure.
 * @returns The mismatch.
 */
export function shapeMismatchOf(error: Schema.SchemaError): ShapeMismatch {
  const [first] = standardFormatter(error.issue).issues;
  const path = (first?.path ?? [])
    .map((segment) => {
      const key = typeof segment === "object" ? segment.key : segment;
      return typeof key === "number" ? `[${key}]` : `.${String(key)}`;
    })
    .join("");
  return new ShapeMismatch({ path: `$${path}`, expected: (first?.message ?? error.message).replace(/^Expected /, "") });
}

/**
 * Parse JSON text and decode it in one step.
 *
 * @template S - The schema of the top-level value.
 * @param schema - Schema for the top-level value.
 * @returns A function from raw text (typically CLI stdout) to the decoded value, or a mismatch
 *   (at `$` when the text is not JSON).
 */
export function decodeJson<S extends Schema.Decoder<unknown>>(schema: S) {
  const decode = Schema.decodeUnknownEffect(schema);
  return (text: string): Effect.Effect<S["Type"], ShapeMismatch> =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () => new ShapeMismatch({ path: "$", expected: "valid JSON" }),
      });
      return yield* decode(parsed).pipe(Effect.mapError(shapeMismatchOf));
    });
}
