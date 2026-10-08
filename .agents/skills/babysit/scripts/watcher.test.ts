import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { CommandFailed, type CommandRunner } from "./command-runner.ts";
import { gitHubClient } from "./github.ts";
import type { WatchPolicy } from "./pr-snapshot.ts";
import { parsePrNumber } from "./pr-target.ts";
import { editedFixture, fixtureText } from "./recorded-runner.ts";
import { err, ok } from "./result.ts";
import { acquireLock } from "./file-lock.ts";
import { acquireWatcherLock, fileStateStore } from "./state-store.ts";
import { Babysitter, type WatchEvent } from "./watcher.ts";

const policy: WatchPolicy = {
  reviewBots: ["chatgpt-codex-connector"],
  requester: "octo-operator",
  retryBudget: 1,
  replyMarker: "[babysit]",
};
const pr42 = parsePrNumber(42) ?? assert.fail("42 is a PR number");
const repo = { _tag: "github", owner: "acme", name: "widgets" } as const;
const clock = () => new Date("2026-10-08T12:00:00Z");

const allGreen = editedFixture("github-pr-open.json", (json) => {
  const pr = json.data.repository.pullRequest;
  pr.mergeStateStatus = "CLEAN";
  pr.reviewDecision = "APPROVED";
  const contexts = pr.commits.nodes[0].commit.statusCheckRollup.contexts;
  contexts.nodes = [contexts.nodes[1]];
  pr.reviewThreads.nodes = [];
  pr.reviews.nodes = [];
  pr.comments.nodes = [];
});
const greenWithFeedback = editedFixture("github-pr-open.json", (json) => {
  const contexts = json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts;
  contexts.nodes = [contexts.nodes[1]];
});
/** Two completed workflow runs with failures (502 and 504), both rerunnable. */
const twoFailedRuns = editedFixture("github-pr-open.json", (json) => {
  const node = json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[5];
  node.status = "COMPLETED";
  node.conclusion = "SUCCESS";
});
const conflicting = editedFixture("github-pr-open.json", (json) => {
  json.data.repository.pullRequest.mergeable = "CONFLICTING";
  json.data.repository.pullRequest.mergeStateStatus = "DIRTY";
});
const merged = editedFixture("github-pr-open.json", (json) => {
  json.data.repository.pullRequest.state = "MERGED";
});

/** The PID of a process that has already exited. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("error", reject);
    child.on("exit", () => (child.pid === undefined ? reject(new Error("no pid")) : resolve(child.pid)));
  });
}

async function statePath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "babysit-test-")), "github-acme-widgets-42.json");
}

type Runner = { readonly runner: CommandRunner; readonly reruns: string[] };

/**
 * A `gh` stand-in: GraphQL answers come from `replies` in order (the last repeats); reruns
 * succeed except for `failingRuns`, and `onRerun` sees each rerun before it is answered.
 */
function fakeGh(
  replies: ReadonlyArray<string>,
  options: { readonly failingRuns?: ReadonlyArray<string>; readonly onRerun?: () => void; readonly latencyMs?: number } = {},
): Runner {
  let call = 0;
  const reruns: string[] = [];
  const runner: CommandRunner = async (argv) => {
    if (options.latencyMs !== undefined) await delay(options.latencyMs);
    if (argv.includes("graphql")) {
      const reply = replies[Math.min(call, replies.length - 1)] ?? "";
      call += 1;
      return ok(reply);
    }
    if (argv.includes("rerun")) {
      const runId = argv[3] ?? "";
      options.onRerun?.();
      if (options.failingRuns?.includes(runId)) return err(new CommandFailed(argv, "exit", "HTTP 403"));
      reruns.push(runId);
      return ok("");
    }
    return err(new CommandFailed(argv, "missing", "unexpected"));
  };
  return { runner, reruns };
}

function sitter(runner: CommandRunner, path: string, overrides: Partial<WatchPolicy> = {}): Babysitter {
  return new Babysitter(gitHubClient(runner, repo, pr42), fileStateStore(path), { ...policy, ...overrides }, clock);
}

async function savedState(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("Babysitter", () => {
  it("persists surfaced review items so the next snapshot only shows new ones", async () => {
    const path = await statePath();
    const babysitter = sitter(fakeGh([fixtureText("github-pr-open.json")]).runner, path);

    const first = await babysitter.snapshot();
    assert.equal(first._tag, "ok");
    const firstIds = first._tag === "ok" ? first.value.review.newItems.map((item) => item.id) : [];
    assert.deepEqual(firstIds, [
      "github:review_comment:2001",
      "github:review_comment:2003",
      "github:review:3001",
      "github:issue_comment:4002",
    ]);
    const second = await babysitter.snapshot();
    assert.deepEqual(second._tag === "ok" ? second.value.review.newItems : null, []);
    assert.deepEqual((await savedState(path)).seenItemIds, firstIds);
  });

  it("saves the retry reservation before triggering any rerun", async () => {
    const path = await statePath();
    const usedAtRerun: number[] = [];
    const gh = fakeGh([twoFailedRuns], {
      onRerun: () => usedAtRerun.push(JSON.parse(readFileSync(path, "utf8")).retries[0]?.used ?? 0),
    });
    const retried = await sitter(gh.runner, path, { retryBudget: 2 }).retryFailedNow();
    assert.equal(retried._tag, "ok");
    assert.deepEqual(usedAtRerun, [1, 1], "the cycle was on disk before each rerun");
  });

  it("keeps the spent budget and reports each target when a rerun fails part-way", async () => {
    const path = await statePath();
    const gh = fakeGh([twoFailedRuns], { failingRuns: ["504"] });
    const babysitter = sitter(gh.runner, path);

    const retried = await babysitter.retryFailedNow();
    assert.equal(retried._tag, "ok");
    if (retried._tag !== "ok") return;
    assert.deepEqual(
      retried.value.reruns.map((rerun) => [rerun._tag, rerun.target]),
      [
        ["triggered", { _tag: "github_run", runId: 502 }],
        ["failed", { _tag: "github_run", runId: 504 }],
      ],
    );
    assert.deepEqual(retried.value.retries, { used: 1, budget: 1 });
    assert.deepEqual(gh.reruns, ["502"]);

    const refused = await babysitter.retryFailedNow();
    assert.equal(refused._tag === "err" && refused.error._tag === "NothingToRetry" ? refused.error.reason : null, "budget_exhausted");
    assert.deepEqual(gh.reruns, ["502"], "no rerun beyond the budget");
  });

  it("does not reopen a SHA's spent budget when an older observation's retry lands in between", async () => {
    const atSha = (sha: string) =>
      editedFixture("github-pr-open.json", (json) => {
        json.data.repository.pullRequest.headRefOid = sha;
        json.data.repository.pullRequest.commits.nodes[0].commit.oid = sha;
      });
    const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    // Retries decided in order: B, then a delayed observation of A, then B again (budget 1).
    const gh = fakeGh([atSha(shaB), atSha(shaA), atSha(shaB)]);
    const babysitter = sitter(gh.runner, await statePath());
    assert.equal((await babysitter.retryFailedNow())._tag, "ok");
    assert.equal((await babysitter.retryFailedNow())._tag, "ok");
    const third = await babysitter.retryFailedNow();
    assert.equal(third._tag === "err" && third.error._tag === "NothingToRetry" ? third.error.reason : null, "budget_exhausted");
    assert.deepEqual(gh.reruns, ["502", "502"], "B's runs were rerun once, A's once");
  });

  it("refuses a retry without changing anything, including seen review items", async () => {
    const path = await statePath();
    const babysitter = sitter(fakeGh([greenWithFeedback]).runner, path);
    const refused = await babysitter.retryFailedNow();
    assert.equal(refused._tag === "err" && refused.error._tag === "NothingToRetry" ? refused.error.reason : null, "no_retryable_failures");
    const snapshot = await babysitter.snapshot();
    assert.equal(snapshot._tag === "ok" ? snapshot.value.review.newItems.length : 0, 4, "items are still new");
  });

  it("refuses to rerun anything at a strict stop", async () => {
    const gh = fakeGh([conflicting]);
    const refused = await sitter(gh.runner, await statePath()).retryFailedNow();
    assert.equal(refused._tag === "err" && refused.error._tag === "NothingToRetry" ? refused.error.reason : null, "pr_stopped");
    assert.deepEqual(gh.reruns, []);
  });

  it("serializes concurrent commands so no update is lost", async () => {
    const path = await statePath();
    // Separate stores on the same file behave like separate processes.
    const commands = [
      sitter(fakeGh([fixtureText("github-pr-open.json")], { latencyMs: 30 }).runner, path).snapshot(),
      sitter(fakeGh([fixtureText("github-pr-open.json")], { latencyMs: 30 }).runner, path).retryFailedNow(),
      sitter(fakeGh([fixtureText("github-pr-open.json")], { latencyMs: 30 }).runner, path).snapshot(),
    ];
    const results = await Promise.all(commands);
    assert.ok(results.every((result) => result._tag === "ok"));
    const state = await savedState(path);
    assert.deepEqual(state.retries, [{ headSha: "1111111111111111111111111111111111111111", used: 1 }], "the reservation survived the concurrent snapshots");
    assert.equal(state.seenItemIds.length, 4);
  });

  it("reads the forge before taking the state lock, so a busy lock never delays observation", async () => {
    const path = await statePath();
    const held = await acquireLock(`${path}.lock`, { timeoutMs: 1_000, pollMs: 10 });
    assert.equal(held._tag, "ok");
    let observed = false;
    const gh = fakeGh([allGreen]);
    const runner: CommandRunner = async (argv, options) => {
      observed = true;
      return gh.runner(argv, options);
    };
    const pending = sitter(runner, path).snapshot();
    await delay(100);
    assert.ok(observed, "the forge was read while another command held the state lock");
    if (held._tag === "ok") await held.value.release();
    assert.equal((await pending)._tag, "ok");
  });

  it("checks one thread in full before a write", async () => {
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
    const check = await sitter(fakeGh([thread]).runner, await statePath()).checkThread("PRRT_t3");
    assert.deepEqual(check._tag === "ok" ? check.value.threadWrite : null, { _tag: "eligible" });
  });

  it("watch emits on change and as a heartbeat, and stops when the PR merges", async () => {
    const babysitter = sitter(fakeGh([allGreen, allGreen, allGreen, allGreen, merged]).runner, await statePath());
    const events: WatchEvent[] = [];
    let sleeps = 0;
    const last = await babysitter.watch(
      { intervalMs: 60_000, heartbeatEvery: 2, maxConsecutiveErrors: 3 },
      { emit: (event) => events.push(event), sleep: async () => void (sleeps += 1) },
    );
    assert.equal(last._tag, "ok");
    const actions = events.map((event) => (event._tag === "snapshot" ? event.snapshot.actions.join("+") : "error"));
    // Poll 1 celebrates; poll 2 changed (celebration done); poll 3 is the first unchanged poll
    // and stays silent; poll 4 is the second and re-emits as a heartbeat; poll 5 sees the merge.
    assert.deepEqual(actions, ["celebrate_ci_green+ready_to_merge", "ready_to_merge", "ready_to_merge", "stop_pr_closed"]);
    assert.equal(sleeps, 4);
  });

  it("watch gives up after consecutive errors, reporting each one", async () => {
    const failing: CommandRunner = async (argv) => err(new CommandFailed(argv, "exit", "HTTP 502"));
    const events: WatchEvent[] = [];
    const last = await sitter(failing, await statePath()).watch(
      { intervalMs: 1, heartbeatEvery: 10, maxConsecutiveErrors: 3 },
      { emit: (event) => events.push(event), sleep: async () => undefined },
    );
    assert.equal(last._tag, "err");
    assert.deepEqual(
      events.map((event) => (event._tag === "error" ? event.consecutive : 0)),
      [1, 2, 3],
    );
  });

  it("reports a corrupt state file instead of silently starting over", async () => {
    const path = await statePath();
    await writeFile(path, '{"version": 9}');
    const snapshot = await sitter(fakeGh([allGreen]).runner, path).snapshot();
    assert.equal(snapshot._tag === "err" ? snapshot.error._tag : null, "StateFileError");
  });
});

describe("lock recovery errors", () => {
  it("name the exact lock file to remove, for transactions and for the watcher lock", async () => {
    const path = await statePath();
    await writeFile(`${path}.lock`, "garbage");
    const snapshot = await sitter(fakeGh([allGreen]).runner, path).snapshot();
    assert.equal(snapshot._tag === "err" ? snapshot.error._tag : null, "LockNeedsRecovery");
    assert.match(snapshot._tag === "err" ? snapshot.error.message : "", /no babysit process is running.*remove .*\.json\.lock$/);

    await writeFile(`${path}.watch.lock`, "garbage");
    const watcher = await acquireWatcherLock(path);
    assert.equal(watcher._tag === "err" ? watcher.error._tag : null, "LockNeedsRecovery");
    assert.match(watcher._tag === "err" ? watcher.error.message : "", /remove .*\.json\.watch\.lock$/);
  });

  it("name a damaged reaper lock that blocks reclaiming a dead owner's lock, through both wrappers", async () => {
    for (const lockSuffix of [".lock", ".watch.lock"]) {
      for (const damage of ["garbage", null] as const) {
        const path = await statePath();
        const lock = `${path}${lockSuffix}`;
        await writeFile(lock, JSON.stringify({ pid: await deadPid(), host: hostname(), token: "dead-owner" }));
        await writeFile(`${lock}.reap`, damage ?? "{}");
        if (damage === null) await chmod(`${lock}.reap`, 0o000);
        const result =
          lockSuffix === ".lock" ? await sitter(fakeGh([allGreen]).runner, path).snapshot() : await acquireWatcherLock(path);
        await chmod(`${lock}.reap`, 0o600);
        assert.equal(result._tag === "err" ? result.error._tag : null, "LockNeedsRecovery", `${lockSuffix} ${damage ?? "unreadable"}`);
        assert.ok((result._tag === "err" ? result.error.message : "").endsWith(`remove ${lock}.reap`));
      }
    }
  });
});

describe("acquireWatcherLock", () => {
  it("allows one watcher per PR without blocking one-shot snapshots", async () => {
    const path = await statePath();
    const watcher = await acquireWatcherLock(path);
    assert.equal(watcher._tag, "ok");
    const second = await acquireWatcherLock(path);
    assert.equal(second._tag === "err" ? second.error._tag : null, "WatcherAlreadyRunning");
    assert.equal((await sitter(fakeGh([allGreen]).runner, path).snapshot())._tag, "ok");
    if (watcher._tag === "ok") await watcher.value.release();
    assert.equal((await acquireWatcherLock(path))._tag, "ok");
  });
});
