import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer } from "effect";
import { FileLock } from "./file-lock.ts";
import { gatedFileSystem, Gates } from "./gated-file-system.ts";
import { StateStore } from "./state-store.ts";
import * as WatchState from "./watch-state.ts";

const exists = (path: string) =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );

describe("StateStore.layerFile", () => {
  it.live("an interrupted save finishes its rename before the transaction lock is released", () =>
    Effect.gen(function* () {
      const path = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "babysit-store-"))), "state.json");
      const gates = new Gates();
      let racing = true;
      // Hold the rename onto the state file: the platform cannot cancel it once it has started.
      const fs = gatedFileSystem(gates, (operation, target) => racing && operation === "rename" && target === path);
      const layer = StateStore.layerFile(path).pipe(Layer.provide(FileLock.layer), Layer.provide(Layer.mergeAll(fs, NodePath.layer)));
      const store = Context.get(yield* Layer.build(layer), StateStore);
      const next = WatchState.reserveRetry(WatchState.initial, "sha-1");

      yield* Effect.gen(function* () {
        const transaction = yield* Effect.forkChild(store.transact((tx) => tx.save(next)));
        const renaming = yield* gates.nth(1);
        // Ctrl-C lands mid-rename.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(transaction));
        // Room for the transaction's scope to release its lock, if the save could be abandoned.
        yield* Effect.sleep("50 millis");
        assert.ok(yield* exists(`${path}.lock`), "the transaction lock is held until the rename lands");

        renaming.open();
        yield* Fiber.join(interrupting);
        assert.ok(!(yield* exists(`${path}.lock`)), "then the lock is released");
        const saved: unknown = JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")));
        assert.deepEqual(saved, next, "the interrupted save completed under the lock");
      }).pipe(Effect.ensuring(Effect.suspend(() => ((racing = false), gates.openAll()))));
    }),
  );
});
