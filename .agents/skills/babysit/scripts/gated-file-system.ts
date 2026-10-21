/**
 * Test support: the real Node `FileSystem` with chosen `remove` / `rename` calls held at a gate.
 *
 * A gated call models the platform's own behaviour: once started, the underlying `rm` or
 * `rename` cannot be cancelled. Interrupting the fiber that waits on it stops the wait, but the
 * operation still runs to completion when the test opens its gate. That is exactly the window in
 * which an interrupted release or save could race another command.
 */
import { rename, rm } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";

/** One held operation. */
export type GatedCall = {
  readonly operation: "remove" | "rename";
  readonly path: string;
  /** Let the underlying operation run. */
  readonly open: () => void;
  /** Settles once the underlying operation has run. */
  readonly done: Promise<void>;
};

/** Which calls to hold. */
export type GateRule = (operation: "remove" | "rename", path: string) => boolean;

/** The gated calls seen so far, and a way to wait for the next one. */
export class Gates {
  /** Every gated call so far, in start order. */
  readonly calls: GatedCall[] = [];
  readonly #waiters = new Map<number, Array<(call: GatedCall) => void>>();

  /** Record a call and hand it to whoever waits for that call number. */
  add(call: GatedCall): void {
    this.calls.push(call);
    for (const resolve of this.#waiters.get(this.calls.length) ?? []) resolve(call);
    this.#waiters.delete(this.calls.length);
  }

  /**
   * Wait for the `n`th gated call (1-based).
   *
   * @param n - Which call.
   * @returns The call, once it has started.
   */
  nth(n: number): Effect.Effect<GatedCall> {
    return Effect.promise(
      () =>
        new Promise<GatedCall>((resolve) => {
          const existing = this.calls[n - 1];
          if (existing !== undefined) resolve(existing);
          else this.#waiters.set(n, [...(this.#waiters.get(n) ?? []), resolve]);
        }),
    );
  }

  /** Open every gate, e.g. to let a stray operation show its damage. */
  openAll(): Effect.Effect<void> {
    return Effect.promise(async () => {
      for (const call of this.calls) call.open();
      await Promise.all(this.calls.map((call) => call.done));
    });
  }
}

/**
 * The Node file system with matching `remove` / `rename` calls held at a gate.
 *
 * @param gates - Where held calls are recorded.
 * @param rule - Which calls to hold.
 * @returns A `FileSystem` layer.
 */
export function gatedFileSystem(gates: Gates, rule: GateRule): Layer.Layer<FileSystem.FileSystem> {
  const hold = (operation: "remove" | "rename", path: string, run: () => Promise<void>): Effect.Effect<void> =>
    Effect.promise(() => {
      let open = (): void => undefined;
      const opened = new Promise<void>((resolve) => (open = resolve));
      const done = opened.then(run);
      gates.add({ operation, path, open, done });
      return done;
    });
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...real,
        remove: (path, options) => (rule("remove", path) ? hold("remove", path, () => rm(path, { force: true })) : real.remove(path, options)),
        rename: (from, to) => (rule("rename", to) ? hold("rename", to, () => rename(from, to)) : real.rename(from, to)),
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
