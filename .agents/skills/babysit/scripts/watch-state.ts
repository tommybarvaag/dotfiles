import { array, constant, number, object, string, withDefault } from "./decode.ts";
import type { Decoder, ShapeMismatch } from "./decode.ts";
import type { Result } from "./result.ts";

/**
 * What the watcher remembers between polls of one pull request.
 *
 * Observations are taken outside the state lock, so a delayed observation of an older head SHA
 * can be decided after a newer one. Every field is therefore keyed by what it describes and only
 * ever grows (bounded by dropping the oldest entries): applying observations in any order yields
 * the same counts, so a late observation can neither reset another SHA's retry budget nor reopen
 * a celebration.
 */
export type WatchState = {
  readonly version: 2;
  /** Review item IDs already surfaced, oldest first. */
  readonly seenItemIds: ReadonlyArray<string>;
  /** Flaky-retry cycles spent per head SHA, least recently reserved first. */
  readonly retries: ReadonlyArray<{ readonly headSha: string; readonly used: number }>;
  /** Head SHAs whose all-green CI was already celebrated, oldest first. */
  readonly celebratedShas: ReadonlyArray<string>;
};

/** Seen IDs kept on disk; older ones are dropped first. */
const SEEN_LIMIT = 5000;
/** Head SHAs remembered for retries and celebrations; a PR rarely has this many live commits. */
const SHA_LIMIT = 50;

/** The state of a pull request the watcher has never polled. */
export const initial: WatchState = { version: 2, seenItemIds: [], retries: [], celebratedShas: [] };

const decoder: Decoder<WatchState> = object({
  version: constant(2),
  seenItemIds: withDefault(array(string), []),
  retries: withDefault(array(object({ headSha: string, used: number })), []),
  celebratedShas: withDefault(array(string), []),
});

/**
 * Parse a state file's JSON.
 *
 * @param input - The parsed JSON of a state file.
 * @returns The state, or a mismatch when the file is not a version-2 state file.
 */
export function parse(input: unknown): Result<WatchState, ShapeMismatch> {
  return decoder(input, "$");
}

/**
 * Whether a review item was already surfaced.
 *
 * @param state - The current state.
 * @param itemId - A review item ID.
 * @returns `true` when the item was surfaced in an earlier snapshot.
 */
export function hasSeen(state: WatchState, itemId: string): boolean {
  return state.seenItemIds.includes(itemId);
}

/**
 * Record review items as surfaced.
 *
 * @param state - The current state.
 * @param itemIds - Items surfaced in this snapshot.
 * @returns The next state.
 */
export function markSeen(state: WatchState, itemIds: ReadonlyArray<string>): WatchState {
  const fresh = itemIds.filter((id) => !state.seenItemIds.includes(id));
  if (fresh.length === 0) return state;
  return { ...state, seenItemIds: [...state.seenItemIds, ...fresh].slice(-SEEN_LIMIT) };
}

/**
 * Retry cycles already spent on a head SHA.
 *
 * @param state - The current state.
 * @param headSha - The pull request's current head SHA.
 * @returns The count; `0` for a SHA never retried.
 */
export function retriesUsed(state: WatchState, headSha: string): number {
  return state.retries.find((entry) => entry.headSha === headSha)?.used ?? 0;
}

/**
 * Reserve one flaky-retry cycle on a head SHA. Persist the result before triggering any rerun:
 * the cycle counts as spent even if the reruns then fail part-way, so a retry loop cannot
 * exceed the budget through partial failures.
 *
 * @param state - The current state.
 * @param headSha - The SHA whose checks are about to be rerun.
 * @returns The next state.
 */
export function reserveRetry(state: WatchState, headSha: string): WatchState {
  const others = state.retries.filter((entry) => entry.headSha !== headSha);
  return { ...state, retries: [...others, { headSha, used: retriesUsed(state, headSha) + 1 }].slice(-SHA_LIMIT) };
}

/**
 * Whether all-green CI was already celebrated for a head SHA.
 *
 * @param state - The current state.
 * @param headSha - A head SHA.
 * @returns `true` after {@link markCelebrated} for that SHA.
 */
export function wasCelebrated(state: WatchState, headSha: string): boolean {
  return state.celebratedShas.includes(headSha);
}

/**
 * Record that all-green CI was celebrated for a head SHA.
 *
 * @param state - The current state.
 * @param headSha - The green SHA.
 * @returns The next state.
 */
export function markCelebrated(state: WatchState, headSha: string): WatchState {
  return wasCelebrated(state, headSha) ? state : { ...state, celebratedShas: [...state.celebratedShas, headSha].slice(-SHA_LIMIT) };
}
