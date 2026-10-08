#!/usr/bin/env node
/**
 * CLI entry and composition root for the babysit watcher.
 *
 *   node babysit.ts --pr auto --once
 *   node babysit.ts --pr auto --watch
 *   node babysit.ts --pr <number|url> --retry-failed-now
 *   node babysit.ts --pr <number|url> --check-thread <thread-id>
 *
 * Prints JSON to stdout: one snapshot (`--once`), one snapshot per line (`--watch`), or a retry
 * report. Exit codes: 0 success, 1 forge/state failure, 2 usage error, 130 interrupted.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Duration, Effect, Layer, Redacted, Result, Schema } from "effect";
import { findAzurePrForBranch, azureDevOpsForgeLayer } from "./azure-devops.ts";
import { CommandRunner } from "./command-runner.ts";
import { casesHandled } from "./defects.ts";
import { FileLock } from "./file-lock.ts";
import { findGitHubPrForCurrentBranch, gitHubForgeLayer } from "./github.ts";
import { identityKey, type WatchPolicy } from "./pr-snapshot.ts";
import {
  describeTarget,
  parsePrArgument,
  parseRemoteUrl,
  stateKey,
  type Forge,
  type PrArgument,
  type PrTarget,
} from "./pr-target.ts";
import { StateStore } from "./state-store.ts";
import { Babysitter, type WatchEvent } from "./watcher.ts";

/** GitHub logins are unique and immutable per account, so well-known review bots can be defaults. */
const GITHUB_REVIEW_BOTS: ReadonlyArray<string> = ["chatgpt-codex-connector", "copilot-pull-request-reviewer", "claude"];

const USAGE = `Usage: node babysit.ts [--pr auto|<number>|<url>] [--once | --watch | --retry-failed-now | --check-thread <id>] [options]

Babysit a GitHub or Azure DevOps pull request: snapshot its state, CI and review feedback as JSON.

Modes (default --once):
  --once                One snapshot as a JSON document.
  --watch               Poll until the PR closes or a stop_* action; one JSON snapshot per line,
                        printed when something changes or as a heartbeat.
  --retry-failed-now    Rerun failed checks when the snapshot offers retry_failed_checks.
                        Spends one retry cycle first; exits 1 if any rerun failed. A rerun is skipped
                        (stale_head / not_terminal) when the PR moved on since the snapshot.
  --check-thread <id>   Read one review thread in full (every comment) and report whether
                        you may reply to or resolve it without asking (threadWrite). Read-only.

Options:
  --pr <value>          auto (PR of the current branch, default), a PR number, or a PR URL.
  --forge <forge>       github | azdo. Overrides detection from the PR URL / origin remote.
  --interval <seconds>  --watch poll interval (default 60).
  --retry-budget <n>    Flaky-retry cycles per head SHA (default 3).
  --requester <id>      Who asked for babysitting, as they confirmed it: their GitHub login, or
                        their Azure DevOps sign-in name (e.g. ada@contoso.com). Only threads
                        whose human participants are all this person are auto-writable.
  --review-bot <id>     Also trust review feedback from this bot (repeatable): its GitHub login,
                        or its Azure DevOps identity ID (a snapshot item's author.key).
                        GitHub defaults: ${GITHUB_REVIEW_BOTS.join(", ")}. Azure DevOps: none.
  --state-dir <path>    Where watch state lives (default \${XDG_STATE_HOME:-~/.local/state}/babysit).
  -h, --help            Show this help.
`;

const REPLY_MARKER = "[babysit]";
const HEARTBEAT_EVERY = 10;
const MAX_CONSECUTIVE_ERRORS = 5;

type Mode =
  | { readonly _tag: "once" }
  | { readonly _tag: "watch" }
  | { readonly _tag: "retry" }
  | { readonly _tag: "check-thread"; readonly threadId: string };

/** Parsed command line. */
type Config = {
  readonly mode: Mode;
  readonly pr: PrArgument;
  readonly forge: Forge | null;
  readonly interval: Duration.Duration;
  /** Bot keys from `--review-bot`; GitHub adds its defaults once the forge is known. */
  readonly reviewBots: ReadonlyArray<string>;
  readonly requester: string | null;
  readonly retryBudget: number;
  readonly stateDir: string;
};

/** Raised for an invalid command line. */
class UsageError extends Schema.TaggedError<UsageError>()("UsageError", { detail: Schema.String }) {
  override get message(): string {
    return this.detail;
  }
}

function usageError(detail: string): Result.Result<never, UsageError> {
  return Result.fail(new UsageError({ detail }));
}

function parseConfig(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Result.Result<Config | "help", UsageError> {
  const parsed = Result.try({
    try: () =>
      parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: false,
        options: {
          pr: { type: "string", default: "auto" },
          once: { type: "boolean", default: false },
          watch: { type: "boolean", default: false },
          "retry-failed-now": { type: "boolean", default: false },
          "check-thread": { type: "string" },
          forge: { type: "string" },
          interval: { type: "string", default: "60" },
          "retry-budget": { type: "string", default: "3" },
          "review-bot": { type: "string", multiple: true, default: [] },
          requester: { type: "string" },
          "state-dir": { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      }),
    catch: (cause) => new UsageError({ detail: cause instanceof Error ? cause.message : String(cause) }),
  });
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const values = parsed.success.values;
  if (values.help) return Result.succeed("help");

  const threadId = values["check-thread"];
  const modes: Mode[] = [
    ...(values.once ? [{ _tag: "once" } as const] : []),
    ...(values.watch ? [{ _tag: "watch" } as const] : []),
    ...(values["retry-failed-now"] ? [{ _tag: "retry" } as const] : []),
    ...(threadId === undefined ? [] : [{ _tag: "check-thread", threadId } as const]),
  ];
  if (modes.length > 1) return usageError("Pick one of --once, --watch, --retry-failed-now, --check-thread");
  if (threadId !== undefined && threadId.trim() === "") return usageError("--check-thread needs a thread ID");

  const pr = parsePrArgument(values.pr);
  if (Result.isFailure(pr)) return usageError(pr.failure.message);

  const forge = values.forge ?? null;
  if (forge !== null && forge !== "github" && forge !== "azdo") return usageError(`--forge must be github or azdo; got "${forge}"`);
  if (forge !== null && pr.success._tag === "url" && pr.success.target.repo._tag !== forge) {
    return usageError(`--forge ${forge} contradicts the ${pr.success.target.repo._tag} PR URL`);
  }

  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 5) return usageError("--interval must be at least 5 seconds");
  const budget = Number(values["retry-budget"]);
  if (!Number.isSafeInteger(budget) || budget < 0) return usageError("--retry-budget must be a whole number");

  const stateHome = env["XDG_STATE_HOME"] ?? join(env["HOME"] ?? homedir(), ".local", "state");
  return Result.succeed({
    mode: modes[0] ?? { _tag: "once" },
    pr: pr.success,
    forge,
    interval: Duration.seconds(interval),
    reviewBots: values["review-bot"].map(identityKey),
    requester: values.requester === undefined || values.requester.trim() === "" ? null : identityKey(values.requester),
    retryBudget: budget,
    stateDir: values["state-dir"] ?? join(stateHome, "babysit"),
  });
}

/** Resolve `--pr` to one pull request, reading the origin remote and branch when needed. */
const resolveTarget = Effect.fnUntraced(function* (config: Config, cwd: string) {
  if (config.pr._tag === "url") return config.pr.target;
  const runner = yield* CommandRunner;
  // An HTTPS remote can embed a token; it stays redacted until the parser takes it apart.
  const remote = Redacted.make(yield* runner.run(["git", "remote", "get-url", "origin"], { cwd }));
  const repo = yield* Effect.fromResult(parseRemoteUrl(remote, config.forge));
  if (config.pr._tag === "number") {
    const target: PrTarget = { repo, number: config.pr.number };
    return target;
  }
  if (repo._tag === "github") return yield* findGitHubPrForCurrentBranch(cwd);
  const branch = yield* runner.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return yield* findAzurePrForBranch(repo, branch.trim());
});

function policyFor(config: Config, forge: Forge): WatchPolicy {
  const defaults = forge === "github" ? GITHUB_REVIEW_BOTS : [];
  return {
    reviewBots: [...new Set([...defaults, ...config.reviewBots])],
    requester: config.requester,
    retryBudget: config.retryBudget,
    replyMarker: REPLY_MARKER,
  };
}

/** Wire the babysitter for one pull request: its forge client, its state file, and the file locks. */
function babysitterLayer(config: Config, target: PrTarget, statePath: string) {
  const forge =
    target.repo._tag === "github" ? gitHubForgeLayer(target.repo, target.number) : azureDevOpsForgeLayer(target.repo, target.number);
  const store = StateStore.layerFile(statePath).pipe(Layer.provide(FileLock.layer));
  return Babysitter.layer(policyFor(config, target.repo._tag)).pipe(Layer.provideMerge(Layer.mergeAll(forge, store)));
}

const print = (value: unknown) => Console.log(JSON.stringify(value));

function errorJson(error: Error): { readonly error: { readonly tag: string; readonly message: string } } {
  const tag = Reflect.get(error, "_tag");
  return { error: { tag: typeof tag === "string" ? tag : error.name, message: error.message } };
}

function renderEvent(event: WatchEvent): unknown {
  return event._tag === "snapshot"
    ? event.snapshot
    : { ...errorJson(event.error), consecutiveErrors: event.consecutive, maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS };
}

/** Print a command's result or its error as JSON, and turn it into an exit code. */
function report<A, E extends Error, R>(effect: Effect.Effect<A, E, R>, succeeded: (value: A) => boolean = () => true) {
  return effect.pipe(
    Effect.matchEffect({
      onFailure: (error) => print(errorJson(error)).pipe(Effect.as(1)),
      onSuccess: (value) => print(value).pipe(Effect.as(succeeded(value) ? 0 : 1)),
    }),
  );
}

/** Run the chosen mode against one pull request. */
const runMode = Effect.fnUntraced(function* (config: Config, target: PrTarget, statePath: string) {
  const babysitter = yield* Babysitter;
  const mode = config.mode;
  switch (mode._tag) {
    case "once":
      return yield* report(babysitter.snapshot);
    case "retry":
      return yield* report(babysitter.retryFailedNow, (outcome) => outcome.reruns.every((rerun) => rerun._tag !== "failed"));
    case "check-thread":
      return yield* report(babysitter.checkThread(mode.threadId));
    case "watch":
      // The watcher lock lives in this scope: normal exit, failure and Ctrl-C (interruption) all release it.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* StateStore;
          const lock = yield* Effect.result(store.holdWatcherLock);
          if (Result.isFailure(lock)) {
            yield* print(errorJson(lock.failure));
            return 1;
          }
          yield* Console.error(`babysit: watching ${describeTarget(target)} (state ${statePath})`);
          const last = yield* Effect.result(
            babysitter.watch(
              { interval: config.interval, heartbeatEvery: HEARTBEAT_EVERY, maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS },
              (event) => print(renderEvent(event)),
            ),
          );
          const released = yield* Effect.result(lock.success.release);
          if (Result.isFailure(released)) yield* print(errorJson(released.failure));
          return Result.isSuccess(last) && Result.isSuccess(released) ? 0 : 1;
        }),
      );
    default:
      return casesHandled(mode);
  }
});

const main: Effect.Effect<number, never, NodeServices.NodeServices> = Effect.gen(function* () {
  const parsed = parseConfig(process.argv.slice(2), process.env);
  if (Result.isFailure(parsed)) {
    yield* Console.error(`${parsed.failure.message}\n\n${USAGE.trimEnd()}`);
    return 2;
  }
  if (parsed.success === "help") {
    yield* Console.log(USAGE.trimEnd());
    return 0;
  }
  const config = parsed.success;

  const target = yield* Effect.result(resolveTarget(config, process.cwd()));
  if (Result.isFailure(target)) {
    yield* print(errorJson(target.failure));
    return 1;
  }
  const statePath = join(config.stateDir, `${stateKey(target.success)}.json`);
  return yield* runMode(config, target.success, statePath).pipe(Effect.provide(babysitterLayer(config, target.success, statePath)));
}).pipe(Effect.provide(CommandRunner.layer));

// Exit codes travel through `process.exitCode` so buffered stdout is flushed before Node exits.
NodeRuntime.runMain(
  main.pipe(
    Effect.flatMap((code) => Effect.sync(() => void (process.exitCode = code))),
    Effect.provide(NodeServices.layer),
  ),
);
