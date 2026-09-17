/**
 * Defect helpers for conditions that make correct execution impossible.
 *
 * These throw. Expected failures are values elsewhere in this tool; reaching
 * one of these means an internal invariant is already broken.
 */

/**
 * Assert that a union has been handled exhaustively.
 *
 * @param unexpectedCase - The value TypeScript proved to be `never`.
 * @returns Never returns.
 * @throws Always, because reaching this call means a union member was added without handling it.
 */
export function casesHandled(unexpectedCase: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(unexpectedCase)}`);
}

/**
 * Signal a violated internal invariant.
 *
 * @param message - What was expected to hold.
 * @returns Never returns.
 * @throws Always, because the caller has proven an impossible state.
 */
export function shouldNeverHappen(message?: string): never {
  throw new Error(message ?? "Invariant violated");
}
