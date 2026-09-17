#!/usr/bin/env bun
/**
 * Composition root.
 *
 * The only place that knows both the command and the concrete machine. Wiring
 * lives here so every other module can be exercised against substitutes.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { BunDiskLive } from "./adapters/bun-disk.ts";
import { ScanProgressLive } from "./adapters/terminal-progress.ts";
import { reclaimDisk } from "./cli.ts";

// The progress renderer needs the platform's terminal, and the disk adapter
// needs the renderer, so the platform layer is supplied to both.
const ProgressLive = Layer.provide(ScanProgressLive, BunServices.layer);

const MainLive = Layer.mergeAll(
  BunServices.layer,
  ProgressLive,
  Layer.provide(BunDiskLive, ProgressLive),
);

const program = Command.run(reclaimDisk, { version: "1.0.0" }).pipe(Effect.provide(MainLive));

BunRuntime.runMain(program);
