/**
 * Mark a branch the type checker has proven unreachable.
 *
 * @param unexpectedCase - The value TypeScript narrowed to `never`.
 * @throws Always: reaching this is a defect.
 */
export function casesHandled(unexpectedCase: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(unexpectedCase)}`);
}
