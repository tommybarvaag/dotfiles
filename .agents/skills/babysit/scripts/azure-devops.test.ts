import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { azureDevOpsForgeLayer, findAzurePrForBranch, makeAzureDevOpsClient } from "./azure-devops.ts";
import { FileLock } from "./file-lock.ts";
import { parsePrNumber, type AzureRepo } from "./pr-target.ts";
import { argvHas, editedFixture, fixtureText, recordedRunner, type Route } from "./recorded-runner.ts";
import { StateStore } from "./state-store.ts";
import { Babysitter } from "./watcher.ts";

const HEAD = "1111111111111111111111111111111111111111";

const repo: AzureRepo = {
  _tag: "azdo",
  organization: "acme",
  organizationUrl: "https://dev.azure.com/acme",
  project: "Acme Platform",
  name: "widgets",
};
const pr77 = parsePrNumber(77) ?? assert.fail("77 is a PR number");

type Overrides = {
  readonly prShow?: Route["reply"];
  readonly policies?: Route["reply"];
  readonly threads?: Route["reply"];
};

function routes(overrides: Overrides = {}, first: ReadonlyArray<Route> = []) {
  return recordedRunner([
    ...first,
    { when: argvHas("repos", "pr", "show"), reply: overrides.prShow ?? { stdout: fixtureText("azdo-pr-show.json") } },
    { when: argvHas("policy", "list"), reply: overrides.policies ?? { stdout: fixtureText("azdo-policy-list.json") } },
    { when: argvHas("policy", "queue", "eval-build"), reply: { stdout: "" } },
    { when: argvHas("policy", "queue"), reply: { fails: "TF401019: policy evaluation not found" } },
    { when: argvHas("pullRequestThreads"), reply: overrides.threads ?? { stdout: fixtureText("azdo-threads.json") } },
    { when: argvHas("timeline", "buildId=9001"), reply: { stdout: fixtureText("azdo-build-timeline.json") } },
    { when: argvHas("timeline", "buildId=9002"), reply: { stdout: fixtureText("azdo-build-timeline-running.json") } },
  ]);
}

const client = (recorded: ReturnType<typeof routes>) => makeAzureDevOpsClient(repo, pr77).pipe(Effect.provide(recorded.layer));

const observe = (recorded = routes()) => Effect.flatMap(client(recorded), (azdo) => azdo.observe);

describe("Azure DevOps adapter", () => {
  it.effect("reads the PR, its policies and threads with the PR's project and repository IDs", () => Effect.gen(function* () {
    const recorded = routes();
    yield* observe(recorded);
    const threads = recorded.calls.find((argv) => argv.includes("pullRequestThreads"));
    assert.ok(threads?.includes("project=proj-guid") && threads.includes("repositoryId=repo-guid"));
    const orgScoped = recorded.calls.filter((argv) => argv[1] === "repos" || argv[1] === "devops");
    assert.ok(orgScoped.length >= 4);
    assert.ok(orgScoped.every((argv) => argv.includes("--org") && argv.includes("https://dev.azure.com/acme")));
  }));

  it.effect("normalizes status, head SHA, votes and blocking policies", () => Effect.gen(function* () {
    const observation = yield* observe();
    assert.equal(observation.pr.state, "open");
    assert.equal(observation.pr.headSha, "1111111111111111111111111111111111111111");
    assert.equal(observation.pr.headBranch, "feat/widget-cache");
    assert.equal(observation.pr.url, "https://dev.azure.com/acme/Acme%20Platform/_git/widgets/pullrequest/77");
    assert.equal(observation.reviewDecision, "changes_requested", "a -5 vote is waiting for the author");
    assert.deepEqual(observation.mergeability, { status: "blocked", detail: "blocking policies: Comment requirements" });
    assert.deepEqual(observation.completeness, { _tag: "complete" });
  }));

  it.effect("maps build and status policies to checks, skipping an expired optional build", () => Effect.gen(function* () {
    const observation = yield* observe();
    assert.deepEqual(
      observation.checks.map((check) => [check.name, check.status, check.required]),
      [
        ["widgets-ci", "failed", true],
        ["nightly-perf", "skipped", false],
        ["sonar/quality-gate", "passed", true],
        ["widgets-e2e", "pending", true],
      ],
    );
    assert.deepEqual(observation.checks[0]?.retry, {
      key: "azdo_policy:eval-build",
      ready: true,
      target: { _tag: "azdo_policy", evaluationId: "eval-build" },
    });
    assert.equal(observation.checks[0]?.url, "https://dev.azure.com/acme/Acme%20Platform/_build/results?buildId=9001");
  }));

  it.effect("points at the failed task's log in the build timeline, with its error issues", () => Effect.gen(function* () {
    const jobs = (yield* observe()).checks[0]?.failedJobs ?? [];
    assert.equal(jobs.length, 1, "the failed task, not its parent job/phase/stage");
    assert.equal(jobs[0]?.name, "Run unit tests");
    assert.deepEqual(jobs[0]?.errors, ["Bash exited with code '1'."]);
    assert.ok(jobs[0]?.log?.command.includes("logId=15"));
  }));

  it.effect("exposes a running build's failed task at once, without offering a rerun", () => Effect.gen(function* () {
    const running = (yield* observe()).checks.find((check) => check.name === "widgets-e2e");
    assert.equal(running?.status, "pending");
    assert.equal(running?.retry, null, "requeueing waits until the build is terminal");
    assert.deepEqual(running?.failedJobs.map((job) => [job.name, job.errors]), [["Run e2e shard 1", ["3 tests failed."]]]);
  }));

  it.effect("classifies authors by subject descriptor and keys bots by immutable identity ID", () => Effect.gen(function* () {
    const observation = yield* observe();
    const items = observation.reviewItems.map((item) => [item.id, item.author.key, item.author.role, item.thread?.resolved ?? null]);
    assert.deepEqual(items, [
      ["azdo:thread:11:comment:1", "ada@acme.test", "collaborator", false],
      ["azdo:thread:12:comment:1", "ada@acme.test", "collaborator", true],
      ["azdo:thread:13:comment:1", "ada@acme.test", "collaborator", false],
      ["azdo:thread:13:comment:2", "operator@acme.test", "collaborator", false],
      ["azdo:thread:14:comment:1", "svc-guid", "bot", false],
      ["azdo:thread:15:comment:1", "bob@acme.test", "collaborator", null],
      ["azdo:thread:17:comment:1", "sp-guid", "bot", false],
    ]);
    assert.equal(observation.reviewItems.at(-1)?.author.login, "SonarQube", "the display name is for reading only");
    assert.equal(observation.viewer, null);
    const inline = observation.reviewItems[0];
    assert.equal(inline?.thread?.path, "/src/cache.ts");
    assert.equal(inline?.thread?.line, 12);
    assert.equal(inline?.url, "https://dev.azure.com/acme/Acme%20Platform/_git/widgets/pullrequest/77?discussionId=11");
  }));

  it.effect("stops on a completed or abandoned PR without depending on any other call", () => Effect.gen(function* () {
    for (const [status, state] of [["completed", "merged"], ["abandoned", "closed"]] as const) {
      const recorded = routes({
        prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => json.set(["status"], status)) },
        policies: { fails: "HTTP 502" },
        threads: { fails: "HTTP 502" },
      });
      const observation = yield* observe(recorded);
      assert.equal(observation.pr.state, state);
      assert.equal(recorded.calls.length, 1);
    }
  }));

  it.effect("maps merge conflicts and a merge preview still being computed", () => Effect.gen(function* () {
    const withMerge = (mergeStatus: string | null) =>
      observe(routes({ prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => json.set(["mergeStatus"], mergeStatus)) } }));
    assert.equal((yield* withMerge("conflicts")).mergeability.status, "conflicting");
    assert.equal((yield* withMerge("queued")).mergeability.status, "unknown");
    assert.equal((yield* withMerge(null)).mergeability.status, "unknown");
  }));

  it.effect("rejects protocol values it does not know instead of defaulting them", () => Effect.gen(function* () {
    const cases: ReadonlyArray<Overrides> = [
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => json.set(["status"], "notSet")) } },
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => json.set(["mergeStatus"], "pondering")) } },
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => json.set(["reviewers", 0, "vote"], 7)) } },
      { policies: { stdout: editedFixture("azdo-policy-list.json", (json) => json.set([0, "status"], "maybe")) } },
      { threads: { stdout: editedFixture("azdo-threads.json", (json) => json.set(["value", 1, "status"], "snoozed")) } },
    ];
    for (const overrides of cases) {
      const failure = yield* Effect.flip(observe(routes(overrides)));
      assert.equal(failure._tag, "ShapeMismatch");
    }
  }));

  it.effect("reports an incomplete observation when threads continue on another page", () => Effect.gen(function* () {
    const threads = { stdout: editedFixture("azdo-threads.json", (json) => json.set(["continuation_token"], "next")) };
    assert.equal((yield* observe(routes({ threads }))).completeness._tag, "incomplete");
  }));

  it.effect("reads one thread for the fresh participant check", () => Effect.gen(function* () {
    const single = editedFixture("azdo-threads.json", (json) => json.replaceRoot(json.get(["value", 3])));
    const recorded = routes({ threads: { stdout: single } });
    const azdo = yield* client(recorded);
    const read = yield* azdo.readThread("13");
    assert.deepEqual(
      read.thread.participants.map((author) => author.key),
      ["ada@acme.test", "operator@acme.test"],
    );
    assert.ok(recorded.calls.some((argv) => argv.includes("threadId=13")));
    const invalid = yield* Effect.flip(azdo.readThread("PRRT_x"));
    assert.equal(invalid._tag, "ThreadNotFound");
  }));

  it.effect("requeues a failed policy evaluation when the head is still the reserved SHA", () => Effect.gen(function* () {
    const recorded = routes();
    const rerun = yield* (yield* client(recorded)).rerun({ _tag: "azdo_policy", evaluationId: "eval-build" }, HEAD);
    assert.equal(rerun._tag, "triggered");
    assert.deepEqual(recorded.calls.at(-1)?.slice(0, 9), ["az", "repos", "pr", "policy", "queue", "--id", "77", "--evaluation-id", "eval-build"]);
  }));

  it.effect("skips the requeue when the head moved or the build is not terminal", () => Effect.gen(function* () {
    const queues = (recorded: ReturnType<typeof routes>) => recorded.calls.filter((argv) => argv.includes("queue")).length;
    const moved = routes();
    const stale = yield* (yield* client(moved)).rerun({ _tag: "azdo_policy", evaluationId: "eval-build" }, "a-older-sha");
    assert.deepEqual(stale, { _tag: "stale_head", currentHead: HEAD });
    assert.equal(queues(moved), 0);

    const running = routes();
    const pending = yield* (yield* client(running)).rerun({ _tag: "azdo_policy", evaluationId: "eval-running" }, HEAD);
    assert.deepEqual(pending, { _tag: "not_terminal", status: "pending" });
    assert.equal(queues(running), 0);
  }));

  it.effect("charges nothing to the current head when a delayed observation of an older head is retried", () => Effect.gen(function* () {
    // The reviewer's scenario: observation of A is decided late, after the PR moved on to B.
    const atHead = (sha: string) => editedFixture("azdo-pr-show.json", (json) => json.set(["lastMergeSourceCommit", "commitId"], sha));
    const shows = [atHead("a".repeat(40)), atHead(HEAD)];
    const recorded = routes({}, [
      { when: argvHas("repos", "pr", "show"), reply: { respond: () => Effect.sync(() => shows.shift() ?? atHead(HEAD)) } },
    ]);
    const statePath = join(yield* Effect.promise(() => mkdtemp(join(tmpdir(), "babysit-azdo-"))), "state.json");
    const policy = { reviewBots: [], requester: null, retryBudget: 1, replyMarker: "[babysit]" };
    const store = StateStore.layerFile(statePath).pipe(Layer.provide(FileLock.layer), Layer.provide(NodeServices.layer));
    const babysitter = Babysitter.layer(policy).pipe(
      Layer.provide(Layer.mergeAll(azureDevOpsForgeLayer(repo, pr77).pipe(Layer.provide(recorded.layer)), store)),
    );
    const outcome = yield* Babysitter.use((sitter) => sitter.retryFailedNow).pipe(Effect.provide(babysitter));
    assert.deepEqual(outcome.reruns.map((rerun) => rerun._tag), ["stale_head"]);
    assert.ok(!recorded.calls.some((argv) => argv.includes("queue")), "B's build was not requeued");
    const state = JSON.parse(yield* Effect.promise(() => readFile(statePath, "utf8")));
    assert.deepEqual(state.retries, [{ headSha: "a".repeat(40), used: 1 }], "only A's budget was spent");
  }));

  it.effect("finds the single active PR for a branch, and refuses zero or several", () => Effect.gen(function* () {
    const find = (stdout: string) =>
      findAzurePrForBranch(repo, "feat/x").pipe(
        Effect.provide(recordedRunner([{ when: argvHas("pr", "list"), reply: { stdout } }]).layer),
      );
    assert.deepEqual(yield* find('[{"pullRequestId":77}]'), { repo, number: 77 });
    const none = yield* Effect.flip(find("[]"));
    const many = yield* Effect.flip(find('[{"pullRequestId":1},{"pullRequestId":2}]'));
    assert.equal(none._tag, "NoOpenPullRequest");
    assert.equal(many._tag, "NoOpenPullRequest");
  }));
});
