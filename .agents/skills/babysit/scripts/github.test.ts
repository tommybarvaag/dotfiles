import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Argv } from "./command-runner.ts";
import { findGitHubPrForCurrentBranch, gitHubClient } from "./github.ts";
import { parsePrNumber, type GitHubRepo } from "./pr-target.ts";
import { argvHas, editedFixture, fixtureText, recordedRunner, type FixtureEdit, type Route } from "./recorded-runner.ts";

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
  return { client: gitHubClient(recorded.runner, repo, pr42), calls: recorded.calls };
}

async function observe(routes: ReadonlyArray<Route>) {
  const observed = await client(routes).client.observe();
  assert.equal(observed._tag, "ok", observed._tag === "err" ? observed.error.message : "");
  return observed._tag === "ok" ? observed.value : assert.fail("unreachable");
}

const onePage = (graphql: string): ReadonlyArray<Route> => [{ when: isMainQuery, reply: { stdout: graphql } }];

/** A copy of the fixture's first check run, as another job. */
function extraCheckRun(databaseId: number, name: string, conclusion: string): unknown {
  const json = JSON.parse(fixtureText("github-pr-open.json"));
  const run = json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[2];
  return { ...run, databaseId, name, conclusion };
}

const pagedMain = editedFixture("github-pr-open.json", (json) => {
  const pr = json.data.repository.pullRequest;
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo = { hasNextPage: true, endCursor: "contexts-2" };
  pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "threads-2" };
  pr.reviewThreads.nodes[2].comments.pageInfo = { hasNextPage: true, endCursor: "t3-comments-2" };
  pr.reviews.pageInfo = { hasNextPage: true, endCursor: "reviews-2" };
  pr.comments.pageInfo = { hasNextPage: true, endCursor: "comments-2" };
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
  it("queries the PR by owner, repo and number through gh api graphql", async () => {
    const { client: github, calls } = client(onePage(fixtureText("github-pr-open.json")));
    await github.observe();
    const [argv] = calls;
    assert.ok(argv !== undefined);
    assert.deepEqual(argv.slice(0, 3), ["gh", "api", "graphql"]);
    assert.ok(argv.includes("owner=acme") && argv.includes("repo=widgets") && argv.includes("number=42"));
    assert.equal(calls.length, 1, "no follow-up page when every connection fits one page");
  });

  it("normalizes PR state, mergeability, review decision and the advisory viewer", async () => {
    const observation = await observe(onePage(fixtureText("github-pr-open.json")));
    assert.equal(observation.pr.state, "open");
    assert.equal(observation.pr.headSha, HEAD);
    assert.equal(observation.mergeability.status, "clean", "UNSTABLE is mergeable; failing checks are reported as CI");
    assert.equal(observation.reviewDecision, "changes_requested");
    assert.equal(observation.viewer, "octo-operator");
    assert.deepEqual(observation.completeness, { _tag: "complete" });
  });

  it("follows every page of checks, threads, thread comments, reviews and comments", async () => {
    const { client: github, calls } = client([{ when: isMainQuery, reply: { stdout: pagedMain } }, ...laterPages]);
    const observed = await github.observe();
    assert.equal(observed._tag, "ok");
    if (observed._tag !== "ok") return;
    const observation = observed.value;
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
  });

  it("reports an incomplete observation when the head moves between check pages", async () => {
    const routes: ReadonlyArray<Route> = [
      { when: isMainQuery, reply: { stdout: pagedMain } },
      { when: isContextsPage, reply: { stdout: contextsPage("2222222222222222222222222222222222222222") } },
      ...laterPages,
    ];
    const observation = await observe(routes);
    assert.equal(observation.completeness._tag, "incomplete");
    assert.ok(!observation.checks.some((check) => check.name === "typecheck"), "the other commit's checks are not mixed in");
  });

  it("reports an incomplete observation when a page has no cursor to follow", async () => {
    const observation = await observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.data.repository.pullRequest.reviewThreads.pageInfo = { hasNextPage: true, endCursor: null };
        }),
      ),
    );
    assert.deepEqual(observation.completeness, { _tag: "incomplete", reasons: ["review threads: stopped after 1 pages"] });
  });

  it("collapses only true re-runs of the same job", async () => {
    const observation = await observe(onePage(fixtureText("github-pr-open.json")));
    const builds = observation.checks.filter((check) => check.name === "build");
    assert.equal(builds.length, 1, "the cancelled run of the same workflow, event and job is superseded");
    assert.equal(builds[0]?.status, "passed");

    const twoEvents = await observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].checkSuite.workflowRun.event = "push";
        }),
      ),
    );
    assert.equal(twoEvents.checks.filter((check) => check.name === "build").length, 2, "push and pull_request runs both count");
  });

  it("keeps checks from different suites of the same app separate when no workflow ties them", async () => {
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
        json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = nodes;
      });
    const separate = await observe(onePage(withVercel([vercel(1, 10, "FAILURE"), vercel(2, 11, "SUCCESS")])));
    assert.deepEqual(separate.checks.map((check) => check.status), ["failed", "passed"], "a passing suite never hides a failing one");
    const rerequested = await observe(onePage(withVercel([vercel(1, 10, "FAILURE"), vercel(2, 10, "SUCCESS")])));
    assert.deepEqual(rerequested.checks.map((check) => check.status), ["passed"], "a re-run inside one suite supersedes");
  });

  it("treats the DRAFT merge state as a draft to keep watching", async () => {
    const observation = await observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.data.repository.pullRequest.isDraft = true;
          json.data.repository.pullRequest.mergeStateStatus = "DRAFT";
        }),
      ),
    );
    assert.deepEqual(observation.mergeability, { status: "blocked", detail: "the pull request is a draft" });
  });

  it("returns a merged or closed PR from the first page, without following any other page", async () => {
    const terminal = editedFixture("github-pr-open.json", (json) => {
      const pr = json.data.repository.pullRequest;
      pr.state = "MERGED";
      pr.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "threads-2" };
      pr.comments.pageInfo = { hasNextPage: true, endCursor: "comments-2" };
    });
    const { client: github, calls } = client([{ when: isMainQuery, reply: { stdout: terminal } }]);
    const observed = await github.observe();
    assert.equal(observed._tag === "ok" ? observed.value.pr.state : null, "merged");
    assert.equal(calls.length, 1);
  });

  it("classifies checks and offers a rerun only for completed workflow runs", async () => {
    const observation = await observe(onePage(fixtureText("github-pr-open.json")));
    const byStatus = (status: string) => observation.checks.filter((check) => check.status === status).map((c) => c.name);
    assert.deepEqual(byStatus("failed"), ["test", "e2e", "deploy/preview"]);
    assert.deepEqual(byStatus("pending"), ["lint", "e2e-shard-2"]);
    assert.deepEqual(byStatus("skipped"), ["docs"]);
    const test = observation.checks.find((check) => check.name === "test");
    assert.equal(test?.retry?.ready, true);
    assert.equal(observation.checks.find((check) => check.name === "e2e")?.retry?.ready, false, "run 504 is still going");
    assert.equal(observation.checks.find((check) => check.name === "deploy/preview")?.retry, null);
  });

  it("points at the job-logs API, which serves a failed job before its run finishes", async () => {
    const observation = await observe(onePage(fixtureText("github-pr-open.json")));
    const log = observation.checks.find((check) => check.name === "e2e")?.failedJobs[0]?.log;
    assert.deepEqual(log, {
      kind: "github_job",
      runId: 504,
      jobId: 1005,
      endpoint: "repos/acme/widgets/actions/jobs/1005/logs",
      command: ["gh", "api", "--allow-escape-sequences", "repos/acme/widgets/actions/jobs/1005/logs"],
    });
  });

  it("surfaces published feedback only, classifying authors by association", async () => {
    const observation = await observe(onePage(fixtureText("github-pr-open.json")));
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
  });

  it("rejects protocol values it does not know instead of defaulting them", async () => {
    const cases: ReadonlyArray<FixtureEdit> = [
      (json) => (json.data.repository.pullRequest.state = "LOCKED"),
      (json) => (json.data.repository.pullRequest.mergeStateStatus = "SOMETHING_NEW"),
      (json) => (json.data.repository.pullRequest.reviewDecision = "MAYBE"),
      (json) => (json.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[2].conclusion = "EXPLODED"),
    ];
    for (const edit of cases) {
      const observed = await client(onePage(editedFixture("github-pr-open.json", edit))).client.observe();
      assert.equal(observed._tag === "err" ? observed.error._tag : null, "ShapeMismatch");
    }
  });

  it("reports a merged PR and conflicting merges", async () => {
    const merged = await observe(onePage(editedFixture("github-pr-open.json", (json) => (json.data.repository.pullRequest.state = "MERGED"))));
    assert.equal(merged.pr.state, "merged");
    const conflicting = await observe(
      onePage(
        editedFixture("github-pr-open.json", (json) => {
          json.data.repository.pullRequest.mergeable = "CONFLICTING";
          json.data.repository.pullRequest.mergeStateStatus = "DIRTY";
        }),
      ),
    );
    assert.equal(conflicting.mergeability.status, "conflicting");
  });

  it("reads one thread in full for the fresh participant check, and only from this PR", async () => {
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
    const read = await client(routes(42)).client.readThread("PRRT_t3");
    assert.equal(read._tag, "ok");
    assert.deepEqual(
      read._tag === "ok" ? read.value.thread.participants.map((author) => author.login) : [],
      ["chatgpt-codex-connector", "carol"],
    );
    const elsewhere = await client(routes(7)).client.readThread("PRRT_t3");
    assert.equal(elsewhere._tag === "err" ? elsewhere.error._tag : null, "ThreadNotFound");
  });

  it("reruns failed jobs of one workflow run", async () => {
    const { client: github, calls } = client(onePage(fixtureText("github-pr-open.json")));
    const rerun = await github.rerun({ _tag: "github_run", runId: 502 }, HEAD);
    assert.equal(rerun._tag === "ok" ? rerun.value._tag : null, "triggered");
    assert.deepEqual(calls.at(-1), ["gh", "run", "rerun", "502", "--failed", "-R", "acme/widgets"]);
  });

  it("finds the PR for the current branch through gh pr view", async () => {
    const recorded = recordedRunner([
      { when: argvHas("pr", "view"), reply: { stdout: '{"url":"https://github.com/acme/widgets/pull/9"}' } },
    ]);
    const target = await findGitHubPrForCurrentBranch(recorded.runner, "/work");
    assert.deepEqual(target, { _tag: "ok", value: { repo, number: 9 } });
    const missing = await findGitHubPrForCurrentBranch(recordedRunner([]).runner, "/work");
    assert.equal(missing._tag, "err");
  });
});
