import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import type { Argv } from "./command-runner.ts";
import { findGitHubPrForCurrentBranch, makeGitHubClient } from "./github.ts";
import { parsePrNumber, type GitHubRepo } from "./pr-target.ts";
import {
  argvHas,
  editedFixture,
  FixtureJson,
  fixtureText,
  GH_CONTEXTS,
  GH_PR,
  recordedRunner,
  type FixtureEdit,
  type Route,
} from "./recorded-runner.ts";

const repo: GitHubRepo = { _tag: "github", owner: "acme", name: "widgets" };
const pr42 = parsePrNumber(42) ?? assert.fail("42 is a PR number");
const HEAD = "1111111111111111111111111111111111111111";
const EMPTY_PAGE = { hasNextPage: false, endCursor: null };

/** Matches a `gh api graphql` call whose query contains every fragment and none of `unless`. */
function query(fragments: ReadonlyArray<string>, unless: ReadonlyArray<string> = []): (argv: Argv) => boolean {
  return (argv) =>
    argv.some(
      (arg) =>
        arg.startsWith("query=") && fragments.every((part) => arg.includes(part)) && !unless.some((part) => arg.includes(part)),
    );
}

const isMainQuery = query(["viewer", "reviewThreads(first: 100)"]);
const isContextsPage = query(["contexts(first: 100, after: $cursor)"]);
const isThreadsPage = query(["reviewThreads(first: 100, after: $cursor)"]);
const isReviewsPage = query(["reviews(first: 100, after: $cursor)"]);
const isCommentsPage = query(["pullRequest(number: $number) { comments(first: 100, after: $cursor)"]);
const isThreadCommentsPage = query(["node(id: $id)", "after: $cursor"]);
const isThreadQuery = query(["node(id: $id)", "pullRequest { number"]);

function client(routes: ReadonlyArray<Route>) {
  const recorded = recordedRunner([...routes, { when: argvHas("rerun"), reply: { stdout: "" } }]);
  return { client: makeGitHubClient(repo, pr42).pipe(Effect.provide(recorded.layer)), calls: recorded.calls };
}

const observe = (routes: ReadonlyArray<Route>) => Effect.flatMap(client(routes).client, (github) => github.observe);

const onePage = (graphql: string): ReadonlyArray<Route> => [{ when: isMainQuery, reply: { stdout: graphql } }];

/** A copy of the fixture's first check run, as another job. */
function extraCheckRun(databaseId: number, name: string, conclusion: string): unknown {
  const run = new FixtureJson(JSON.parse(fixtureText("github-pr-open.json"))).object([...GH_CONTEXTS, "nodes", 2]);
  return { ...run, databaseId, name, conclusion };
}

const pagedMain = editedFixture("github-pr-open.json", (json) => {
  json.set([...GH_CONTEXTS, "pageInfo"], { hasNextPage: true, endCursor: "contexts-2" });
  json.set([...GH_PR, "reviewThreads", "pageInfo"], { hasNextPage: true, endCursor: "threads-2" });
  json.set([...GH_PR, "reviewThreads", "nodes", 2, "comments", "pageInfo"], { hasNextPage: true, endCursor: "t3-comments-2" });
  json.set([...GH_PR, "reviews", "pageInfo"], { hasNextPage: true, endCursor: "reviews-2" });
  json.set([...GH_PR, "comments", "pageInfo"], { hasNextPage: true, endCursor: "comments-2" });
});

const comment = (databaseId: number, login: string, association: string, body: string) => ({
  databaseId,
  body,
  url: `https://github.com/acme/widgets/pull/42#discussion_r${databaseId}`,
  createdAt: "2026-10-08T11:00:00Z",
  authorAssociation: association,
  author: { __typename: "User", login },
  pullRequestReview: { state: "COMMENTED" },
});

function contextsPage(oid: string) {
  return JSON.stringify({
    data: { repository: { pullRequest: { commits: { nodes: [{ commit: {
      oid,
      statusCheckRollup: { contexts: { pageInfo: EMPTY_PAGE, nodes: [extraCheckRun(1009, "typecheck", "FAILURE")] } },
    } }] } } } },
  });
}

const laterPages: ReadonlyArray<Route> = [
  { when: isThreadCommentsPage, reply: { stdout: JSON.stringify({ data: { node: { comments: { pageInfo: EMPTY_PAGE, nodes: [
    comment(2010, "carol", "COLLABORATOR", "I disagree with the bot here."),
  ] } } } }) } },
  { when: isContextsPage, reply: { stdout: contextsPage(HEAD) } },
  { when: isThreadsPage, reply: { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: EMPTY_PAGE, nodes: [
    { id: "PRRT_t6", isResolved: false, isOutdated: false, path: "src/late.ts", line: 3,
      comments: { pageInfo: EMPTY_PAGE, nodes: [comment(2011, "alice", "COLLABORATOR", "Thread on page two.")] } },
  ] } } } } }) } },
  { when: isReviewsPage, reply: { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviews: { pageInfo: EMPTY_PAGE, nodes: [
    { databaseId: 3010, state: "CHANGES_REQUESTED", body: "Second page review", url: "https://github.com/acme/widgets/pull/42#pullrequestreview-3010",
      submittedAt: "2026-10-08T11:00:00Z", authorAssociation: "MEMBER", author: { __typename: "User", login: "bob" } },
  ] } } } } }) } },
  { when: isCommentsPage, reply: { stdout: JSON.stringify({ data: { repository: { pullRequest: { comments: { pageInfo: EMPTY_PAGE, nodes: [
    { databaseId: 4010, body: "Comment on page two", url: "https://github.com/acme/widgets/pull/42#issuecomment-4010",
      createdAt: "2026-10-08T11:00:00Z", authorAssociation: "MEMBER", author: { __typename: "User", login: "bob" } },
  ] } } } } }) } },
];

describe("GitHub adapter", () => {
  it.effect("queries the PR by owner, repo and number through gh api graphql", () => Effect.gen(function* () {
    const { client: makeClient, calls } = client(onePage(fixtureText("github-pr-open.json")));
    yield* (yield* makeClient).observe;
    const [argv] = calls;
    assert.ok(argv !== undefined);
    assert.deepEqual(argv.slice(0, 3), ["gh", "api", "graphql"]);
    assert.ok(argv.includes("owner=acme") && argv.includes("repo=widgets") && argv.includes("number=42"));
    assert.equal(calls.length, 1, "no follow-up page when every connection fits one page");
  }));

  it.effect("normalizes PR state, mergeability, review decision and the advisory viewer", () => Effect.gen(function* () {
    const observation = yield* observe(onePage(fixtureText("github-pr-open.json")));
    assert.equal(observation.pr.state, "open");
    assert.equal(observation.pr.headSha, HEAD);
    assert.equal(observation.mergeability.status, "clean", "UNSTABLE is mergeable; failing checks are reported as CI");
    assert.equal(observation.reviewDecision, "changes_requested");
    assert.equal(observation.viewer, "octo-operator");
    assert.deepEqual(observation.completeness, { _tag: "complete" });
  }));

  it.effect("follows every page of checks, threads, thread comments, reviews and comments", () => Effect.gen(function* () {
    const { client: makeClient, calls } = client([{ when: isMainQuery, reply: { stdout: pagedMain } }, ...laterPages]);
    const observation = yield* (yield* makeClient).observe;
    assert.deepEqual(observation.completeness, { _tag: "complete" });
    assert.equal(observation.checks.find((check) => check.name === "typecheck")?.status, "failed");
    const ids = observation.reviewItems.map((item) => item.id);
    for (const id of ["github:review_comment:2010", "github:review_comment:2011", "github:review:3010", "github:issue_comment:4010"]) {
      assert.ok(ids.includes(id), id);
    }
    const botThread = observation.reviewItems.find((item) => item.id === "github:review_comment:2003")?.thread;
    assert.deepEqual(
      botThread?.participants.map((author) => [author.login, author.role]),
      [["chatgpt-codex-connector", "bot"], ["carol", "collaborator"]],
      "a human on a later comment page is a participant",
    );
    const cursors = calls.flatMap((argv) => argv.filter((arg) => arg.startsWith("cursor=")));
    assert.deepEqual(cursors.sort(), ["cursor=comments-2", "cursor=contexts-2", "cursor=reviews-2", "cursor=t3-comments-2", "cursor=threads-2"]);
  }));

  it.effect("reports an incomplete observation when the head moves between check pages", () => Effect.gen(function* () {
    const routes: ReadonlyArray<Route> = [
      { when: isMainQuery, reply: { stdout: pagedMain } },
      { when: isContextsPage, reply: { stdout: contextsPage("2222222222222222222222222222222222222222") } },
      ...laterPages,
    ];
    const observation = yield* observe(routes);
    assert.equal(observation.completeness._tag, "incomplete");
    assert.ok(!observation.checks.some((check) => check.name === "typecheck"), "the other commit's checks are not mixed in");
  }));

  it.effect("reports an incomplete observation when a page has no cursor to follow", () => Effect.gen(function* () {
    const observation = yield* observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.set([...GH_PR, "reviewThreads", "pageInfo"], { hasNextPage: true, endCursor: null });
        }),
      ),
    );
    assert.deepEqual(observation.completeness, { _tag: "incomplete", reasons: ["review threads: stopped after 1 pages"] });
  }));

  it.effect("collapses only true re-runs of the same job", () => Effect.gen(function* () {
    const observation = yield* observe(onePage(fixtureText("github-pr-open.json")));
    const builds = observation.checks.filter((check) => check.name === "build");
    assert.equal(builds.length, 1, "the cancelled run of the same workflow, event and job is superseded");
    assert.equal(builds[0]?.status, "passed");

    const twoEvents = yield* observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.set([...GH_CONTEXTS, "nodes", 0, "checkSuite", "workflowRun", "event"], "push");
        }),
      ),
    );
    assert.equal(twoEvents.checks.filter((check) => check.name === "build").length, 2, "push and pull_request runs both count");
  }));

  it.effect("keeps checks from different suites of the same app separate when no workflow ties them", () => Effect.gen(function* () {
    const vercel = (databaseId: number, suite: number, conclusion: string) => ({
      __typename: "CheckRun",
      databaseId,
      name: "Vercel",
      status: "COMPLETED",
      conclusion,
      detailsUrl: null,
      isRequired: false,
      checkSuite: { databaseId: suite, app: { databaseId: 8329, slug: "vercel" }, workflowRun: null },
    });
    const withVercel = (nodes: ReadonlyArray<unknown>) =>
      editedFixture("github-pr-open.json", (json) => {
        json.set([...GH_CONTEXTS, "nodes"], nodes);
      });
    const separate = yield* observe(onePage(withVercel([vercel(1, 10, "FAILURE"), vercel(2, 11, "SUCCESS")])));
    assert.deepEqual(separate.checks.map((check) => check.status), ["failed", "passed"], "a passing suite never hides a failing one");
    const rerequested = yield* observe(onePage(withVercel([vercel(1, 10, "FAILURE"), vercel(2, 10, "SUCCESS")])));
    assert.deepEqual(rerequested.checks.map((check) => check.status), ["passed"], "a re-run inside one suite supersedes");
  }));

  it.effect("treats the DRAFT merge state as a draft to keep watching", () => Effect.gen(function* () {
    const observation = yield* observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.set([...GH_PR, "isDraft"], true);
          json.set([...GH_PR, "mergeStateStatus"], "DRAFT");
        }),
      ),
    );
    assert.deepEqual(observation.mergeability, { status: "blocked", detail: "the pull request is a draft" });
  }));

  it.effect("returns a merged or closed PR from the first page, without following any other page", () => Effect.gen(function* () {
    const terminal = editedFixture("github-pr-open.json", (json) => {
      json.set([...GH_PR, "state"], "MERGED");
      json.set([...GH_PR, "reviewThreads", "pageInfo"], { hasNextPage: true, endCursor: "threads-2" });
      json.set([...GH_PR, "comments", "pageInfo"], { hasNextPage: true, endCursor: "comments-2" });
    });
    const { client: makeClient, calls } = client([{ when: isMainQuery, reply: { stdout: terminal } }]);
    const observed = yield* (yield* makeClient).observe;
    assert.equal(observed.pr.state, "merged");
    assert.equal(calls.length, 1);
  }));

  it.effect("classifies checks and offers a rerun only for completed workflow runs", () => Effect.gen(function* () {
    const observation = yield* observe(onePage(fixtureText("github-pr-open.json")));
    const byStatus = (status: string) => observation.checks.filter((check) => check.status === status).map((c) => c.name);
    assert.deepEqual(byStatus("failed"), ["test", "e2e", "deploy/preview"]);
    assert.deepEqual(byStatus("pending"), ["lint", "e2e-shard-2"]);
    assert.deepEqual(byStatus("skipped"), ["docs"]);
    const test = observation.checks.find((check) => check.name === "test");
    assert.equal(test?.retry?.ready, true);
    assert.equal(observation.checks.find((check) => check.name === "e2e")?.retry?.ready, false, "run 504 is still going");
    assert.equal(observation.checks.find((check) => check.name === "deploy/preview")?.retry, null);
  }));

  it.effect("points at the job-logs API, which serves a failed job before its run finishes", () => Effect.gen(function* () {
    const observation = yield* observe(onePage(fixtureText("github-pr-open.json")));
    const log = observation.checks.find((check) => check.name === "e2e")?.failedJobs[0]?.log;
    assert.deepEqual(log, {
      kind: "github_job",
      runId: 504,
      jobId: 1005,
      endpoint: "repos/acme/widgets/actions/jobs/1005/logs",
      command: ["gh", "api", "--allow-escape-sequences", "repos/acme/widgets/actions/jobs/1005/logs"],
    });
  }));

  it.effect("surfaces published feedback only, classifying authors by association", () => Effect.gen(function* () {
    const observation = yield* observe(onePage(fixtureText("github-pr-open.json")));
    const byId = new Map(observation.reviewItems.map((item) => [item.id, item]));
    assert.ok(!byId.has("github:review_comment:2005"), "comment in a PENDING review");
    assert.ok(!byId.has("github:review:3003"), "PENDING review");
    assert.ok(!byId.has("github:review:3002"), "empty COMMENTED envelope");
    assert.equal(byId.get("github:review:3001")?.verdict, "changes_requested");
    assert.equal(byId.get("github:review_comment:2001")?.author.role, "collaborator");
    assert.equal(byId.get("github:review_comment:2003")?.author.role, "bot");
    assert.equal(byId.get("github:review_comment:2004")?.author.role, "outsider");
    assert.deepEqual(byId.get("github:review_comment:2003")?.author.key, "chatgpt-codex-connector");
    assert.equal(byId.get("github:review_comment:2006")?.author.role, "collaborator", "the CLI's own account gets no special trust");
    assert.equal(byId.get("github:issue_comment:4003")?.author.login, "ghost");
    assert.deepEqual(
      byId.get("github:review_comment:2001")?.thread?.participants.map((author) => author.role),
      ["collaborator", "collaborator"],
    );
  }));

  it.effect("rejects protocol values it does not know instead of defaulting them", () => Effect.gen(function* () {
    const cases: ReadonlyArray<FixtureEdit> = [
      (json) => json.set([...GH_PR, "state"], "LOCKED"),
      (json) => json.set([...GH_PR, "mergeStateStatus"], "SOMETHING_NEW"),
      (json) => json.set([...GH_PR, "reviewDecision"], "MAYBE"),
      (json) => json.set([...GH_CONTEXTS, "nodes", 2, "conclusion"], "EXPLODED"),
    ];
    for (const edit of cases) {
      const failure = yield* Effect.flip(observe(onePage(editedFixture("github-pr-open.json", edit))));
      assert.equal(failure._tag, "ShapeMismatch");
    }
  }));

  it.effect("reports a merged PR and conflicting merges", () => Effect.gen(function* () {
    const merged = yield* observe(onePage(editedFixture("github-pr-open.json", (json) => json.set([...GH_PR, "state"], "MERGED"))));
    assert.equal(merged.pr.state, "merged");
    const conflicting = yield* observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.set([...GH_PR, "mergeable"], "CONFLICTING");
          json.set([...GH_PR, "mergeStateStatus"], "DIRTY");
        }),
      ),
    );
    assert.equal(conflicting.mergeability.status, "conflicting");
  }));

  it.effect("reads one thread in full for the fresh participant check, and only from this PR", () => Effect.gen(function* () {
    const threadReply = (number: number) =>
      JSON.stringify({
        data: {
          node: {
            id: "PRRT_t3",
            isResolved: false,
            isOutdated: false,
            path: "src/widget.ts",
            line: 7,
            comments: {
              pageInfo: { hasNextPage: true, endCursor: "t3-comments-2" },
              nodes: [{ ...comment(2003, "chatgpt-codex-connector", "NONE", "P1"), author: { __typename: "Bot", login: "chatgpt-codex-connector" } }],
            },
            pullRequest: { number, repository: { owner: { login: "acme" }, name: "widgets" } },
          },
        },
      });
    const routes = (number: number): ReadonlyArray<Route> => [
      { when: isThreadCommentsPage, reply: laterPages[0]?.reply ?? { fails: "missing" } },
      { when: isThreadQuery, reply: { stdout: threadReply(number) } },
    ];
    const read = yield* (yield* client(routes(42)).client).readThread("PRRT_t3");
    assert.deepEqual(
      read.thread.participants.map((author) => author.login),
      ["chatgpt-codex-connector", "carol"],
    );
    const elsewhere = yield* Effect.flip((yield* client(routes(7)).client).readThread("PRRT_t3"));
    assert.equal(elsewhere._tag, "ThreadNotFound");
  }));

  it.effect("reruns failed jobs of one workflow run", () => Effect.gen(function* () {
    const { client: makeClient, calls } = client(onePage(fixtureText("github-pr-open.json")));
    const rerun = yield* (yield* makeClient).rerun({ _tag: "github_run", runId: 502 }, HEAD);
    assert.equal(rerun._tag, "triggered");
    assert.deepEqual(calls.at(-1), ["gh", "run", "rerun", "502", "--failed", "-R", "acme/widgets"]);
  }));

  it.effect("finds the PR for the current branch through gh pr view", () => Effect.gen(function* () {
    const recorded = recordedRunner([
      { when: argvHas("pr", "view"), reply: { stdout: '{"url":"https://github.com/acme/widgets/pull/9"}' } },
    ]);
    const target = yield* findGitHubPrForCurrentBranch("/work").pipe(Effect.provide(recorded.layer));
    assert.deepEqual(target, { repo, number: 9 });
    const missing = yield* Effect.result(findGitHubPrForCurrentBranch("/work").pipe(Effect.provide(recordedRunner([]).layer)));
    assert.ok(Result.isFailure(missing));
  }));
});
