import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Context, Duration, Effect, Exit, Fiber, Layer, Result, Scope } from "effect";
import { TestClock } from "effect/testing";
import { CommandFailed, type CommandRunner } from "./command-runner.ts";
import { FileLock } from "./file-lock.ts";
import { gitHubForgeLayer } from "./github.ts";
import type { WatchPolicy } from "./pr-snapshot.ts";
import { parsePrNumber } from "./pr-target.ts";
import { argvHas, editedFixture, FixtureJson, fixtureText, GH_CONTEXTS, GH_PR, recordedRunner } from "./recorded-runner.ts";
import { StateStore } from "./state-store.ts";
import { Babysitter, type WatchEvent } from "./watcher.ts";

const policy: WatchPolicy = {
  reviewBots: ["chatgpt-codex-connector"],
  requester: "octo-operator",
  retryBudget: 1,
  replyMarker: "[babysit]",
};
const pr42 = parsePrNumber(42) ?? assert.fail("42 is a PR number");
const repo = { _tag: "github", owner: "acme", name: "widgets" } as const;

/** Keep only the passing `build` check. */
const onlyPassingBuild = (json: FixtureJson) => json.set([...GH_CONTEXTS, "nodes"], [json.get([...GH_CONTEXTS, "nodes", 1])]);

const allGreen = editedFixture("github-pr-open.json", (json) => {
  json.set([...GH_PR, "mergeStateStatus"], "CLEAN");
  json.set([...GH_PR, "reviewDecision"], "APPROVED");
  onlyPassingBuild(json);
  json.set([...GH_PR, "reviewThreads", "nodes"], []);
  json.set([...GH_PR, "reviews", "nodes"], []);
  json.set([...GH_PR, "comments", "nodes"], []);
});
const greenWithFeedback = editedFixture("github-pr-open.json", onlyPassingBuild);
/** Two completed workflow runs with failures (502 and 504), both rerunnable. */
const twoFailedRuns = editedFixture("github-pr-open.json", (json) => {
  json.set([...GH_CONTEXTS, "nodes", 5, "status"], "COMPLETED");
  json.set([...GH_CONTEXTS, "nodes", 5, "conclusion"], "SUCCESS");
});
const conflicting = editedFixture("github-pr-open.json", (json) => {
  json.set([...GH_PR, "mergeable"], "CONFLICTING");
  json.set([...GH_PR, "mergeStateStatus"], "DIRTY");
});
const merged = editedFixture("github-pr-open.json", (json) => json.set([...GH_PR, "state"], "MERGED"));

const promise = <A>(thunk: () => Promise<A>) => Effect.promise(thunk);

/** The PID of a process that has already exited. */
const deadPid = () =>
  promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", ""]);
        child.on("error", reject);
        child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
      }),
  );

const statePath = () => promise(async () => join(await mkdtemp(join(tmpdir(), "babysit-test-")), "github-acme-widgets-42.json"));

const savedState = (path: string) => promise(async () => JSON.parse(await readFile(path, "utf8")));

/** The real file-backed store and lock files, as the CLI wires them. */
const fileStore = (path: string) => StateStore.layerFile(path).pipe(Layer.provide(FileLock.layer), Layer.provide(NodeServices.layer));

type FakeGh = { readonly layer: Layer.Layer<CommandRunner>; readonly reruns: ReadonlyArray<string> };

/**
 * A `gh` stand-in: GraphQL answers come from `replies` in order (the last repeats); reruns
 * succeed except for `failingRuns`, and `onRerun` sees each rerun before it is answered.
 */
function fakeGh(
  replies: ReadonlyArray<string>,
  options: { readonly failingRuns?: ReadonlyArray<string>; readonly onRerun?: () => void; readonly latency?: Duration.Input } = {},
): FakeGh {
  let call = 0;
  const reruns: string[] = [];
  const delayed = <A, E>(effect: Effect.Effect<A, E>) =>
    options.latency === undefined ? effect : Effect.sleep(options.latency).pipe(Effect.andThen(effect));
  const { layer } = recordedRunner([
    {
      when: argvHas("graphql"),
      reply: {
        respond: () =>
          delayed(
            Effect.sync(() => {
              const reply = replies[Math.min(call, replies.length - 1)] ?? "";
              call += 1;
              return reply;
            }),
          ),
      },
    },
    {
      when: argvHas("rerun"),
      reply: {
        respond: (argv) =>
          delayed(
            Effect.suspend(() => {
              const runId = argv[3] ?? "";
              options.onRerun?.();
              if (options.failingRuns?.includes(runId)) return Effect.fail(CommandFailed.of(argv, "exit", "HTTP 403"));
              reruns.push(runId);
              return Effect.succeed("");
            }),
          ),
      },
    },
  ]);
  return { layer, reruns };
}

/** A babysitter over the real GitHub adapter, a fake `gh`, and the given store. */
function sitter(gh: Layer.Layer<CommandRunner>, store: Layer.Layer<StateStore>, overrides: Partial<WatchPolicy> = {}) {
  return Babysitter.layer({ ...policy, ...overrides }).pipe(
    Layer.provideMerge(Layer.mergeAll(gitHubForgeLayer(repo, pr42).pipe(Layer.provide(gh)), store)),
  );
}

/** Build a babysitter in the test's scope. */
const build = (layer: Layer.Layer<Babysitter>) =>
  Layer.build(layer).pipe(Effect.map((context) => Context.get(context, Babysitter)));

/** Build a babysitter over the real file store at `path`. */
const onFile = (path: string, gh: FakeGh, overrides: Partial<WatchPolicy> = {}) => build(sitter(gh.layer, fileStore(path), overrides));

const refusal = (error: { readonly _tag: string } & ({ readonly reason: string } | object)) =>
  error._tag === "NothingToRetry" && "reason" in error ? error.reason : error._tag;

/** Hold a lock file at `path` in a scope of its own until `close` runs. */
const holdLock = (path: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* FileLock.use((locks) => locks.tryAcquire(path)).pipe(Scope.provide(scope), Effect.provide(FileLock.layer.pipe(Layer.provide(NodeServices.layer))));
    return Scope.close(scope, Exit.void);
  });

describe("Babysitter", () => {
  it.live("persists surfaced review items so the next snapshot only shows new ones", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      const babysitter = yield* onFile(path, fakeGh([fixtureText("github-pr-open.json")]));
      const first = yield* babysitter.snapshot;
      const firstIds = first.review.newItems.map((item) => item.id);
      assert.deepEqual(firstIds, [
        "github:review_comment:2001",
        "github:review_comment:2003",
        "github:review:3001",
        "github:issue_comment:4002",
      ]);
      const second = yield* babysitter.snapshot;
      assert.deepEqual(second.review.newItems, []);
      assert.deepEqual((yield* savedState(path)).seenItemIds, firstIds);
    }),
  );

  it.live("saves the retry reservation before triggering any rerun", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      const usedAtRerun: number[] = [];
      const gh = fakeGh([twoFailedRuns], {
        onRerun: () => usedAtRerun.push(JSON.parse(readFileSync(path, "utf8")).retries[0]?.used ?? 0),
      });
      yield* (yield* onFile(path, gh, { retryBudget: 2 })).retryFailedNow;
      assert.deepEqual(usedAtRerun, [1, 1], "the cycle was on disk before each rerun");
    }),
  );

  it.live("keeps the spent budget and reports each target when a rerun fails part-way", () =>
    Effect.gen(function* () {
      const gh = fakeGh([twoFailedRuns], { failingRuns: ["504"] });
      const babysitter = yield* onFile(yield* statePath(), gh);

      const retried = yield* babysitter.retryFailedNow;
      assert.deepEqual(
        retried.reruns.map((rerun) => [rerun._tag, rerun.target]),
        [
          ["triggered", { _tag: "github_run", runId: 502 }],
          ["failed", { _tag: "github_run", runId: 504 }],
        ],
      );
      assert.deepEqual(retried.retries, { used: 1, budget: 1 });
      assert.deepEqual(gh.reruns, ["502"]);

      assert.equal(refusal(yield* Effect.flip(babysitter.retryFailedNow)), "budget_exhausted");
      assert.deepEqual(gh.reruns, ["502"], "no rerun beyond the budget");
    }),
  );

  it.live("does not reopen a SHA's spent budget when an older observation's retry lands in between", () =>
    Effect.gen(function* () {
      const atSha = (sha: string) =>
        editedFixture("github-pr-open.json", (json) => {
          json.set([...GH_PR, "headRefOid"], sha);
          json.set([...GH_PR, "commits", "nodes", 0, "commit", "oid"], sha);
        });
      const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      // Retries decided in order: B, then a delayed observation of A, then B again (budget 1).
      const gh = fakeGh([atSha(shaB), atSha(shaA), atSha(shaB)]);
      const babysitter = yield* onFile(yield* statePath(), gh);
      yield* babysitter.retryFailedNow;
      yield* babysitter.retryFailedNow;
      assert.equal(refusal(yield* Effect.flip(babysitter.retryFailedNow)), "budget_exhausted");
      assert.deepEqual(gh.reruns, ["502", "502"], "B's runs were rerun once, A's once");
    }),
  );

  it.live("refuses a retry without changing anything, including seen review items", () =>
    Effect.gen(function* () {
      const babysitter = yield* onFile(yield* statePath(), fakeGh([greenWithFeedback]));
      assert.equal(refusal(yield* Effect.flip(babysitter.retryFailedNow)), "no_retryable_failures");
      assert.equal((yield* babysitter.snapshot).review.newItems.length, 4, "items are still new");
    }),
  );

  it.live("refuses to rerun anything at a strict stop", () =>
    Effect.gen(function* () {
      const gh = fakeGh([conflicting]);
      const babysitter = yield* onFile(yield* statePath(), gh);
      assert.equal(refusal(yield* Effect.flip(babysitter.retryFailedNow)), "pr_stopped");
      assert.deepEqual(gh.reruns, []);
    }),
  );

  it.live("serializes concurrent commands so no update is lost", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      // Separate babysitters, stores and locks on the same file behave like separate processes.
      const another = () => onFile(path, fakeGh([fixtureText("github-pr-open.json")], { latency: "30 millis" }));
      const [first, second, third] = [yield* another(), yield* another(), yield* another()];
      yield* Effect.all([first.snapshot, second.retryFailedNow, third.snapshot], { concurrency: "unbounded" });
      const state = yield* savedState(path);
      assert.deepEqual(
        state.retries,
        [{ headSha: "1111111111111111111111111111111111111111", used: 1 }],
        "the reservation survived the concurrent snapshots",
      );
      assert.equal(state.seenItemIds.length, 4);
    }),
  );

  it.live("reads the forge before taking the state lock, so a busy lock never delays observation", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      const release = yield* holdLock(`${path}.lock`);
      let observed = false;
      const gh = recordedRunner([
        {
          when: argvHas("graphql"),
          reply: { respond: () => Effect.sync(() => ((observed = true), allGreen)) },
        },
      ]);
      const babysitter = yield* build(sitter(gh.layer, fileStore(path)));
      const pending = yield* Effect.forkChild(babysitter.snapshot);
      yield* Effect.sleep("100 millis");
      assert.ok(observed, "the forge was read while another command held the state lock");
      yield* release;
      yield* Fiber.join(pending);
    }),
  );

  it.live("checks one thread in full before a write", () =>
    Effect.gen(function* () {
      const thread = JSON.stringify({
        data: {
          node: {
            id: "PRRT_t3",
            isResolved: false,
            isOutdated: false,
            path: "src/widget.ts",
            line: 7,
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  databaseId: 2003,
                  body: "P1",
                  url: "https://github.com/acme/widgets/pull/42#discussion_r2003",
                  createdAt: "2026-10-08T10:00:00Z",
                  authorAssociation: "NONE",
                  author: { __typename: "Bot", login: "chatgpt-codex-connector" },
                  pullRequestReview: { state: "COMMENTED" },
                },
              ],
            },
            pullRequest: { number: 42, repository: { owner: { login: "acme" }, name: "widgets" } },
          },
        },
      });
      const check = yield* (yield* onFile(yield* statePath(), fakeGh([thread]))).checkThread("PRRT_t3");
      assert.deepEqual(check.threadWrite, { _tag: "eligible" });
    }),
  );

  it.live("reports a corrupt state file instead of silently starting over", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      yield* promise(() => writeFile(path, '{"version": 9}'));
      const failure = yield* Effect.flip((yield* onFile(path, fakeGh([allGreen]))).snapshot);
      assert.equal(failure._tag, "StateFileError");
    }),
  );
});

describe("Babysitter.watch", () => {
  const interval = "1 minute";
  const collect = (events: WatchEvent[]) => (event: WatchEvent) => Effect.sync(() => void events.push(event));

  /** Run a watch on the test clock, stepping it one interval at a time until the loop ends. */
  const watchOnTestClock = (babysitter: Babysitter["Service"], events: WatchEvent[], heartbeatEvery: number) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        babysitter.watch({ interval, heartbeatEvery, maxConsecutiveErrors: 3 }, collect(events)),
      );
      for (let step = 0; step < 10; step += 1) yield* TestClock.adjust(interval);
      return yield* Effect.result(Fiber.join(fiber));
    });

  it.effect("emits on change and as a heartbeat, polls once per interval, and stops when the PR merges", () =>
    Effect.gen(function* () {
      const babysitter = yield* build(sitter(fakeGh([allGreen, allGreen, allGreen, allGreen, merged]).layer, StateStore.layerMemory()));
      const events: WatchEvent[] = [];
      const last = yield* watchOnTestClock(babysitter, events, 2);
      assert.ok(Result.isSuccess(last));
      const emitted = events.map((event) =>
        event._tag === "snapshot" ? [event.snapshot.actions.join("+"), event.snapshot.observedAt] : ["error", ""],
      );
      // Poll 1 celebrates; poll 2 changed (celebration done); poll 3 is the first unchanged poll
      // and stays silent; poll 4 is the second and re-emits as a heartbeat; poll 5 sees the merge.
      // The schedule spaces the polls one interval apart on the clock.
      assert.deepEqual(emitted, [
        ["celebrate_ci_green+ready_to_merge", "1970-01-01T00:00:00.000Z"],
        ["ready_to_merge", "1970-01-01T00:01:00.000Z"],
        ["ready_to_merge", "1970-01-01T00:03:00.000Z"],
        ["stop_pr_closed", "1970-01-01T00:04:00.000Z"],
      ]);
    }),
  );

  it.effect("gives up after consecutive errors, reporting each one", () =>
    Effect.gen(function* () {
      const failing = recordedRunner([{ when: () => true, reply: { fails: "HTTP 502" } }]);
      const babysitter = yield* build(sitter(failing.layer, StateStore.layerMemory()));
      const events: WatchEvent[] = [];
      const last = yield* watchOnTestClock(babysitter, events, 10);
      assert.ok(Result.isFailure(last));
      assert.deepEqual(
        events.map((event) => (event._tag === "error" ? event.consecutive : 0)),
        [1, 2, 3],
      );
    }),
  );

  it.effect("recovers from an error: the count resets once a poll succeeds", () =>
    Effect.gen(function* () {
      let call = 0;
      const flaky = recordedRunner([
        {
          when: argvHas("graphql"),
          reply: {
            respond: (argv) =>
              Effect.suspend(() => {
                call += 1;
                if (call === 1 || call === 3) return Effect.fail(CommandFailed.of(argv, "exit", "HTTP 502"));
                return Effect.succeed(call >= 5 ? merged : allGreen);
              }),
          },
        },
      ]);
      const babysitter = yield* build(sitter(flaky.layer, StateStore.layerMemory()));
      const events: WatchEvent[] = [];
      assert.ok(Result.isSuccess(yield* watchOnTestClock(babysitter, events, 10)));
      assert.deepEqual(
        events.map((event) => (event._tag === "error" ? `error ${event.consecutive}` : event.snapshot.actions[0])),
        ["error 1", "celebrate_ci_green", "error 1", "ready_to_merge", "stop_pr_closed"],
      );
    }),
  );
});

describe("lock recovery errors", () => {
  it.live("name the exact lock file to remove, for transactions and for the watcher lock", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      yield* promise(() => writeFile(`${path}.lock`, "garbage"));
      const snapshot = yield* Effect.flip((yield* onFile(path, fakeGh([allGreen]))).snapshot);
      assert.equal(snapshot._tag, "LockNeedsRecovery");
      assert.match(snapshot.message, /no babysit process is running.*remove .*\.json\.lock$/);

      yield* promise(() => writeFile(`${path}.watch.lock`, "garbage"));
      const watcher = yield* Effect.flip(Effect.scoped(StateStore.use((store) => store.holdWatcherLock)).pipe(Effect.provide(fileStore(path))));
      assert.equal(watcher._tag, "LockNeedsRecovery");
      assert.match(watcher.message, /remove .*\.json\.watch\.lock$/);
    }),
  );

  it.live("name a damaged reaper lock that blocks reclaiming a dead owner's lock, through both wrappers", () =>
    Effect.gen(function* () {
      for (const lockSuffix of [".lock", ".watch.lock"]) {
        for (const damage of ["garbage", null] as const) {
          const path = yield* statePath();
          const lock = `${path}${lockSuffix}`;
          const pid = yield* deadPid();
          yield* promise(() => writeFile(lock, JSON.stringify({ pid, host: hostname(), token: "dead-owner" })));
          yield* promise(() => writeFile(`${lock}.reap`, damage ?? "{}"));
          if (damage === null) yield* promise(() => chmod(`${lock}.reap`, 0o000));
          const attempt: Effect.Effect<unknown, { readonly _tag: string; readonly message: string }> =
            lockSuffix === ".lock"
              ? (yield* onFile(path, fakeGh([allGreen]))).snapshot
              : Effect.scoped(StateStore.use((store) => store.holdWatcherLock)).pipe(Effect.provide(fileStore(path)));
          const failure = yield* Effect.flip(attempt);
          yield* promise(() => chmod(`${lock}.reap`, 0o600));
          assert.equal(failure._tag, "LockNeedsRecovery", `${lockSuffix} ${damage ?? "unreadable"}`);
          assert.ok(failure.message.endsWith(`remove ${lock}.reap`));
        }
      }
    }),
  );
});

describe("watcher lock", () => {
  it.live("allows one watcher per PR without blocking one-shot snapshots", () =>
    Effect.gen(function* () {
      const path = yield* statePath();
      const hold = StateStore.use((store) => store.holdWatcherLock).pipe(Effect.provide(fileStore(path)));
      const scope = yield* Scope.make();
      yield* hold.pipe(Scope.provide(scope));
      const second = yield* Effect.flip(Effect.scoped(hold));
      assert.equal(second._tag, "WatcherAlreadyRunning");
      yield* (yield* onFile(path, fakeGh([allGreen]))).snapshot;
      yield* Scope.close(scope, Exit.void);
      yield* Effect.scoped(hold);
    }),
  );

  it.effect("is enforced by the in-memory store too", () =>
    Effect.gen(function* () {
      const store = yield* Layer.build(StateStore.layerMemory()).pipe(Effect.map((context) => Context.get(context, StateStore)));
      yield* store.holdWatcherLock;
      assert.equal((yield* Effect.flip(Effect.scoped(store.holdWatcherLock)))._tag, "WatcherAlreadyRunning");
    }),
  );
});
