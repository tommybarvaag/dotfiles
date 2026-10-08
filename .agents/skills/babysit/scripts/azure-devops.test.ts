import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { azureDevOpsClient, findAzurePrForBranch } from "./azure-devops.ts";
import { parsePrNumber, type AzureRepo } from "./pr-target.ts";
import { argvHas, editedFixture, fixtureText, recordedRunner, type Route } from "./recorded-runner.ts";
import type { CommandRunner } from "./command-runner.ts";
import { ok } from "./result.ts";
import { fileStateStore } from "./state-store.ts";
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

function routes(overrides: Overrides = {}) {
  return recordedRunner([
    { when: argvHas("repos", "pr", "show"), reply: overrides.prShow ?? { stdout: fixtureText("azdo-pr-show.json") } },
    { when: argvHas("policy", "list"), reply: overrides.policies ?? { stdout: fixtureText("azdo-policy-list.json") } },
    { when: argvHas("policy", "queue", "eval-build"), reply: { stdout: "" } },
    { when: argvHas("policy", "queue"), reply: { fails: "TF401019: policy evaluation not found" } },
    { when: argvHas("pullRequestThreads"), reply: overrides.threads ?? { stdout: fixtureText("azdo-threads.json") } },
    { when: argvHas("timeline", "buildId=9001"), reply: { stdout: fixtureText("azdo-build-timeline.json") } },
    { when: argvHas("timeline", "buildId=9002"), reply: { stdout: fixtureText("azdo-build-timeline-running.json") } },
  ]);
}

async function observe(recorded = routes()) {
  const observed = await azureDevOpsClient(recorded.runner, repo, pr77).observe();
  assert.equal(observed._tag, "ok", observed._tag === "err" ? observed.error.message : "");
  return observed._tag === "ok" ? observed.value : assert.fail("unreachable");
}

describe("Azure DevOps adapter", () => {
  it("reads the PR, its policies and threads with the PR's project and repository IDs", async () => {
    const recorded = routes();
    await observe(recorded);
    const threads = recorded.calls.find((argv) => argv.includes("pullRequestThreads"));
    assert.ok(threads?.includes("project=proj-guid") && threads.includes("repositoryId=repo-guid"));
    const orgScoped = recorded.calls.filter((argv) => argv[1] === "repos" || argv[1] === "devops");
    assert.ok(orgScoped.length >= 4);
    assert.ok(orgScoped.every((argv) => argv.includes("--org") && argv.includes("https://dev.azure.com/acme")));
  });

  it("normalizes status, head SHA, votes and blocking policies", async () => {
    const observation = await observe();
    assert.equal(observation.pr.state, "open");
    assert.equal(observation.pr.headSha, "1111111111111111111111111111111111111111");
    assert.equal(observation.pr.headBranch, "feat/widget-cache");
    assert.equal(observation.pr.url, "https://dev.azure.com/acme/Acme%20Platform/_git/widgets/pullrequest/77");
    assert.equal(observation.reviewDecision, "changes_requested", "a -5 vote is waiting for the author");
    assert.deepEqual(observation.mergeability, { status: "blocked", detail: "blocking policies: Comment requirements" });
    assert.deepEqual(observation.completeness, { _tag: "complete" });
  });

  it("maps build and status policies to checks, skipping an expired optional build", async () => {
    const observation = await observe();
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
  });

  it("points at the failed task's log in the build timeline, with its error issues", async () => {
    const jobs = (await observe()).checks[0]?.failedJobs ?? [];
    assert.equal(jobs.length, 1, "the failed task, not its parent job/phase/stage");
    assert.equal(jobs[0]?.name, "Run unit tests");
    assert.deepEqual(jobs[0]?.errors, ["Bash exited with code '1'."]);
    assert.ok(jobs[0]?.log?.command.includes("logId=15"));
  });

  it("exposes a running build's failed task at once, without offering a rerun", async () => {
    const running = (await observe()).checks.find((check) => check.name === "widgets-e2e");
    assert.equal(running?.status, "pending");
    assert.equal(running?.retry, null, "requeueing waits until the build is terminal");
    assert.deepEqual(running?.failedJobs.map((job) => [job.name, job.errors]), [["Run e2e shard 1", ["3 tests failed."]]]);
  });

  it("classifies authors by subject descriptor and keys bots by immutable identity ID", async () => {
    const observation = await observe();
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
  });

  it("stops on a completed or abandoned PR without depending on any other call", async () => {
    for (const [status, state] of [["completed", "merged"], ["abandoned", "closed"]] as const) {
      const recorded = routes({
        prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => (json.status = status)) },
        policies: { fails: "HTTP 502" },
        threads: { fails: "HTTP 502" },
      });
      const observation = await observe(recorded);
      assert.equal(observation.pr.state, state);
      assert.equal(recorded.calls.length, 1);
    }
  });

  it("maps merge conflicts and a merge preview still being computed", async () => {
    const withMerge = async (mergeStatus: string | null) =>
      observe(routes({ prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => (json.mergeStatus = mergeStatus)) } }));
    assert.equal((await withMerge("conflicts")).mergeability.status, "conflicting");
    assert.equal((await withMerge("queued")).mergeability.status, "unknown");
    assert.equal((await withMerge(null)).mergeability.status, "unknown");
  });

  it("rejects protocol values it does not know instead of defaulting them", async () => {
    const cases: ReadonlyArray<Overrides> = [
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => (json.status = "notSet")) } },
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => (json.mergeStatus = "pondering")) } },
      { prShow: { stdout: editedFixture("azdo-pr-show.json", (json) => (json.reviewers[0].vote = 7)) } },
      { policies: { stdout: editedFixture("azdo-policy-list.json", (json) => (json[0].status = "maybe")) } },
      { threads: { stdout: editedFixture("azdo-threads.json", (json) => (json.value[1].status = "snoozed")) } },
    ];
    for (const overrides of cases) {
      const observed = await azureDevOpsClient(routes(overrides).runner, repo, pr77).observe();
      assert.equal(observed._tag === "err" ? observed.error._tag : null, "ShapeMismatch");
    }
  });

  it("reports an incomplete observation when threads continue on another page", async () => {
    const threads = { stdout: editedFixture("azdo-threads.json", (json) => (json.continuation_token = "next")) };
    assert.equal((await observe(routes({ threads }))).completeness._tag, "incomplete");
  });

  it("reads one thread for the fresh participant check", async () => {
    const single = editedFixture("azdo-threads.json", (json) => Object.assign(json, json.value[3]));
    const recorded = routes({ threads: { stdout: single } });
    const read = await azureDevOpsClient(recorded.runner, repo, pr77).readThread("13");
    assert.equal(read._tag, "ok");
    assert.deepEqual(
      read._tag === "ok" ? read.value.thread.participants.map((author) => author.key) : [],
      ["ada@acme.test", "operator@acme.test"],
    );
    assert.ok(recorded.calls.some((argv) => argv.includes("threadId=13")));
    const invalid = await azureDevOpsClient(recorded.runner, repo, pr77).readThread("PRRT_x");
    assert.equal(invalid._tag === "err" ? invalid.error._tag : null, "ThreadNotFound");
  });

  it("requeues a failed policy evaluation when the head is still the reserved SHA", async () => {
    const recorded = routes();
    const rerun = await azureDevOpsClient(recorded.runner, repo, pr77).rerun({ _tag: "azdo_policy", evaluationId: "eval-build" }, HEAD);
    assert.equal(rerun._tag === "ok" ? rerun.value._tag : null, "triggered");
    assert.deepEqual(recorded.calls.at(-1)?.slice(0, 9), ["az", "repos", "pr", "policy", "queue", "--id", "77", "--evaluation-id", "eval-build"]);
  });

  it("skips the requeue when the head moved or the build is not terminal", async () => {
    const queues = (recorded: ReturnType<typeof routes>) => recorded.calls.filter((argv) => argv.includes("queue")).length;
    const moved = routes();
    const stale = await azureDevOpsClient(moved.runner, repo, pr77).rerun({ _tag: "azdo_policy", evaluationId: "eval-build" }, "a-older-sha");
    assert.deepEqual(stale, { _tag: "ok", value: { _tag: "stale_head", currentHead: HEAD } });
    assert.equal(queues(moved), 0);

    const running = routes();
    const pending = await azureDevOpsClient(running.runner, repo, pr77).rerun({ _tag: "azdo_policy", evaluationId: "eval-running" }, HEAD);
    assert.deepEqual(pending, { _tag: "ok", value: { _tag: "not_terminal", status: "pending" } });
    assert.equal(queues(running), 0);
  });

  it("charges nothing to the current head when a delayed observation of an older head is retried", async () => {
    // The reviewer's scenario: observation of A is decided late, after the PR moved on to B.
    const atHead = (sha: string) => editedFixture("azdo-pr-show.json", (json) => (json.lastMergeSourceCommit.commitId = sha));
    const base = routes();
    const shows = [atHead("a".repeat(40)), atHead(HEAD)];
    const runner: CommandRunner = (argv, options) =>
      argvHas("repos", "pr", "show")(argv) ? Promise.resolve(ok(shows.shift() ?? atHead(HEAD))) : base.runner(argv, options);
    const statePath = join(await mkdtemp(join(tmpdir(), "babysit-azdo-")), "state.json");
    const policy = { reviewBots: [], requester: null, retryBudget: 1, replyMarker: "[babysit]" };
    const sitter = new Babysitter(azureDevOpsClient(runner, repo, pr77), fileStateStore(statePath), policy, () => new Date(0));
    const outcome = await sitter.retryFailedNow();
    assert.deepEqual(outcome._tag === "ok" ? outcome.value.reruns.map((rerun) => rerun._tag) : null, ["stale_head"]);
    assert.ok(!base.calls.some((argv) => argv.includes("queue")), "B's build was not requeued");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(state.retries, [{ headSha: "a".repeat(40), used: 1 }], "only A's budget was spent");
  });

  it("finds the single active PR for a branch, and refuses zero or several", async () => {
    const list = (stdout: string) => recordedRunner([{ when: argvHas("pr", "list"), reply: { stdout } }]).runner;
    assert.deepEqual(await findAzurePrForBranch(list('[{"pullRequestId":77}]'), repo, "feat/x"), {
      _tag: "ok",
      value: { repo, number: 77 },
    });
    const none = await findAzurePrForBranch(list("[]"), repo, "feat/x");
    const many = await findAzurePrForBranch(list('[{"pullRequestId":1},{"pullRequestId":2}]'), repo, "feat/x");
    assert.equal(none._tag === "err" ? none.error._tag : null, "NoOpenPullRequest");
    assert.equal(many._tag === "err" ? many.error._tag : null, "NoOpenPullRequest");
  });
});
