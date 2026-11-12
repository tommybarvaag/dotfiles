/**
 * Test data: watch states reachable through the module's own transitions, never hand-built JSON.
 */
import { Arbitrary, Schema } from "effect";
import * as WatchState from "./watch-state.ts";

/** Head SHAs shared with the observation arbitraries, so generated states and observations overlap. */
export const HEAD_SHAS = ["sha-1", "sha-2", "sha-3"] as const;

/** Review item IDs shared with the observation arbitraries. */
export const ITEM_IDS = ["a", "b", "c", "d", "e"] as const;

const headSha = Arbitrary.schema(Schema.Literals(HEAD_SHAS));

/** A state built by surfacing items, reserving retries, and celebrating, in any order and number. */
export const watchState: Arbitrary.Arbitrary<WatchState.WatchState> = Arbitrary.all({
  seen: Arbitrary.array(Arbitrary.schema(Schema.Literals(ITEM_IDS)), { maxLength: 6 }),
  reserved: Arbitrary.array(headSha, { maxLength: 6 }),
  celebrated: Arbitrary.array(headSha, { maxLength: 3 }),
}).pipe(
  Arbitrary.map(({ seen, reserved, celebrated }) => {
    const afterSeen = WatchState.markSeen(WatchState.initial, seen);
    const afterRetries = reserved.reduce(WatchState.reserveRetry, afterSeen);
    return celebrated.reduce(WatchState.markCelebrated, afterRetries);
  }),
);
