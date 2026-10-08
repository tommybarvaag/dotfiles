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
 * report. Exit codes: 0 success, 1 forge/state failure, 2 usage error.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { findAzurePrForBranch, azureDevOpsClient } from "./azure-devops.ts";
import { execFileRunner, type CommandRunner } from "./command-runner.ts";
import type { ForgeClient } from "./forge-client.ts";
import { findGitHubPrForCurrentBranch, gitHubClient } from "./github.ts";
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
import { casesHandled, err, ok, type Result } from "./result.ts";
import { acquireWatcherLock, fileStateStore } from "./state-store.ts";
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
  readonly intervalMs: number;
  /** Bot keys from `--review-bot`; GitHub adds its defaults once the forge is known. */
  readonly reviewBots: ReadonlyArray<string>;
  readonly requester: string | null;
  readonly retryBudget: number;
  readonly stateDir: string;
};

/** Raised for an invalid command line. */
class UsageError extends Error {
  readonly _tag = "UsageError" as const;
}


function parseConfig(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): Result<Config | "help", UsageError> {
  let parsed;
  try {
    parsed = parseArgs({
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
    });
  } catch (cause) {
    return err(new UsageError(cause instanceof Error ? cause.message : String(cause)));
  }
  const values = parsed.values;
  if (values.help) return ok("help");

  const threadId = values["check-thread"];
  const modes: Mode[] = [
    ...(values.once ? [{ _tag: "once" } as const] : []),
    ...(values.watch ? [{ _tag: "watch" } as const] : []),
    ...(values["retry-failed-now"] ? [{ _tag: "retry" } as const] : []),
    ...(threadId === undefined ? [] : [{ _tag: "check-thread", threadId } as const]),
  ];
  if (modes.length > 1) {
    return err(new UsageError("Pick one of --once, --watch, --retry-failed-now, --check-thread"));
  }
  if (threadId !== undefined && threadId.trim() === "") return err(new UsageError("--check-thread needs a thread ID"));

  const pr = parsePrArgument(values.pr);
  if (pr._tag === "err") return err(new UsageError(pr.error.message));

  const forge = values.forge ?? null;
  if (forge !== null && forge !== "github" && forge !== "azdo") {
    return err(new UsageError(`--forge must be github or azdo; got "${forge}"`));
  }
  if (forge !== null && pr.value._tag === "url" && pr.value.target.repo._tag !== forge) {
    return err(new UsageError(`--forge ${forge} contradicts the ${pr.value.target.repo._tag} PR URL`));
  }

  const interval = Number(values.interval);
  if (!Number.isFinite(interval) || interval < 5) return err(new UsageError("--interval must be at least 5 seconds"));
  const budget = Number(values["retry-budget"]);
  if (!Number.isSafeInteger(budget) || budget < 0) return err(new UsageError("--retry-budget must be a whole number"));

  const stateHome = env["XDG_STATE_HOME"] ?? join(env["HOME"] ?? homedir(), ".local", "state");
  return ok({
    mode: modes[0] ?? { _tag: "once" },
    pr: pr.value,
    forge,
    intervalMs: interval * 1000,
    reviewBots: values["review-bot"].map(identityKey),
    requester: values.requester === undefined || values.requester.trim() === "" ? null : identityKey(values.requester),
    retryBudget: budget,
    stateDir: values["state-dir"] ?? join(stateHome, "babysit"),
  });
}

async function resolveTarget(
  runner: CommandRunner,
  config: Config,
  cwd: string,
): Promise<Result<PrTarget, Error>> {
  if (config.pr._tag === "url") return ok(config.pr.target);

  const remote = await runner(["git", "remote", "get-url", "origin"], { cwd });
  if (remote._tag === "err") return remote;
  const repo = parseRemoteUrl(remote.value, config.forge);
  if (repo._tag === "err") return repo;

  if (config.pr._tag === "number") return ok({ repo: repo.value, number: config.pr.number });

  if (repo.value._tag === "github") return findGitHubPrForCurrentBranch(runner, cwd);
  const branch = await runner(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  if (branch._tag === "err") return branch;
  return findAzurePrForBranch(runner, repo.value, branch.value.trim());
}

function policyFor(config: Config, forge: Forge): WatchPolicy {
  const defaults = forge === "github" ? GITHUB_REVIEW_BOTS : [];
  return {
    reviewBots: [...new Set([...defaults, ...config.reviewBots])],
    requester: config.requester,
    retryBudget: config.retryBudget,
    replyMarker: REPLY_MARKER,
  };
}

function clientFor(runner: CommandRunner, target: PrTarget): ForgeClient {
  return target.repo._tag === "github"
    ? gitHubClient(runner, target.repo, target.number)
    : azureDevOpsClient(runner, target.repo, target.number);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorJson(error: Error): { readonly error: { readonly tag: string; readonly message: string } } {
  const tag = Reflect.get(error, "_tag");
  return { error: { tag: typeof tag === "string" ? tag : error.name, message: error.message } };
}

function renderEvent(event: WatchEvent): unknown {
  return event._tag === "snapshot"
    ? event.snapshot
    : { ...errorJson(event.error), consecutiveErrors: event.consecutive, maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS };
}

async function main(): Promise<number> {
  const config = parseConfig(process.argv.slice(2), process.env);
  if (config._tag === "err") {
    process.stderr.write(`${config.error.message}\n\n${USAGE}`);
    return 2;
  }
  if (config.value === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const runner = execFileRunner();
  const target = await resolveTarget(runner, config.value, process.cwd());
  if (target._tag === "err") {
    print(errorJson(target.error));
    return 1;
  }

  const statePath = join(config.value.stateDir, `${stateKey(target.value)}.json`);
  const babysitter = new Babysitter(
    clientFor(runner, target.value),
    fileStateStore(statePath),
    policyFor(config.value, target.value.repo._tag),
    () => new Date(),
  );

  const mode = config.value.mode;
  switch (mode._tag) {
    case "once": {
      const snapshot = await babysitter.snapshot();
      print(snapshot._tag === "ok" ? snapshot.value : errorJson(snapshot.error));
      return snapshot._tag === "ok" ? 0 : 1;
    }
    case "retry": {
      const outcome = await babysitter.retryFailedNow();
      print(outcome._tag === "ok" ? outcome.value : errorJson(outcome.error));
      return outcome._tag === "ok" && outcome.value.reruns.every((rerun) => rerun._tag !== "failed") ? 0 : 1;
    }
    case "check-thread": {
      const check = await babysitter.checkThread(mode.threadId);
      print(check._tag === "ok" ? check.value : errorJson(check.error));
      return check._tag === "ok" ? 0 : 1;
    }
    case "watch": {
      const lock = await acquireWatcherLock(statePath);
      if (lock._tag === "err") {
        print(errorJson(lock.error));
        return 1;
      }
      const stop = (): void => {
        void lock.value.release().then((released) => {
          if (released._tag === "err") process.stderr.write(`babysit: ${released.error.message}\n`);
          process.exit(130);
        });
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stderr.write(`babysit: watching ${describeTarget(target.value)} (state ${statePath})\n`);
      const last = await babysitter.watch(
        { intervalMs: config.value.intervalMs, heartbeatEvery: HEARTBEAT_EVERY, maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS },
        { emit: (event) => print(renderEvent(event)), sleep: (ms) => sleep(ms) },
      );
      const released = await lock.value.release();
      if (released._tag === "err") print(errorJson(released.error));
      return last._tag === "ok" && released._tag === "ok" ? 0 : 1;
    }
    default:
      return casesHandled(mode);
  }
}

process.exitCode = await main();
