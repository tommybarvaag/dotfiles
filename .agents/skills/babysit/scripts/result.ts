/** A successful outcome carrying a value. */
export type Ok<T> = { readonly _tag: "ok"; readonly value: T };

/** A failed outcome carrying a typed error. */
export type Err<E> = { readonly _tag: "err"; readonly error: E };

/** An expected success or failure, returned instead of thrown. */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Wrap a value as a successful result.
 *
 * @param value - The success value.
 * @returns An `ok` result.
 */
export function ok<T>(value: T): Ok<T> {
  return { _tag: "ok", value };
}

/**
 * Wrap an error as a failed result.
 *
 * @param error - The expected failure.
 * @returns An `err` result.
 */
export function err<E>(error: E): Err<E> {
  return { _tag: "err", error };
}

/**
 * Collect a list of results into one result, stopping at the first error.
 *
 * @param results - The results to collect.
 * @returns All success values in order, or the first error.
 */
export function all<T, E>(results: ReadonlyArray<Result<T, E>>): Result<ReadonlyArray<T>, E> {
  const values: T[] = [];
  for (const result of results) {
    if (result._tag === "err") return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Mark a branch the type checker has proven unreachable.
 *
 * @param unexpectedCase - The value TypeScript narrowed to `never`.
 * @throws Always: reaching this is a defect.
 */
export function casesHandled(unexpectedCase: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(unexpectedCase)}`);
}
