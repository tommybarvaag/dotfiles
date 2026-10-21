/**
 * GitHub adapter: GraphQL through `gh api graphql`, following every connection's cursor (checks,
 * review threads, each thread's comments, reviews, conversation comments), parsed with Effect
 * Schema into the forge-neutral {@link Observation}. Reruns go through `gh run rerun --failed`.
 */
import { Effect, Layer, Schema } from "effect";
import { CommandRunner } from "./command-runner.ts";
import { casesHandled } from "./defects.ts";
import { decodeJson, nullable, ShapeMismatch, withDefault } from "./decode.ts";
import { ForgeClient, ThreadNotFound, type ForgeError } from "./forge-client.ts";
import {
  identityKey,
  type AuthorRole,
  type Check,
  type CheckStatus,
  type Completeness,
  type Mergeability,
  type Observation,
  type PrState,
  type ReviewAuthor,
  type ReviewDecision,
  type ReviewItem,
  type ReviewThread,
} from "./pr-snapshot.ts";
import { parsePrUrl, type GitHubRepo, type PrNumber, type PrTarget } from "./pr-target.ts";

/** Pages followed per connection before the observation is declared incomplete. */
const MAX_PAGES = 50;
/** Review threads whose extra comment pages are fetched at the same time. */
const THREAD_CONCURRENCY = 4;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const CONTEXT_FIELDS = `__typename
  ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number)
    checkSuite { databaseId app { databaseId slug } workflowRun { databaseId event workflow { databaseId name } } } }
  ... on StatusContext { context state targetUrl description isRequired(pullRequestNumber: $number) }`;
const COMMENT_FIELDS =
  "databaseId body url createdAt authorAssociation author { __typename login } pullRequestReview { state }";
const THREAD_FIELDS = `id isResolved isOutdated path line comments(first: 100) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } }`;
const REVIEW_FIELDS = "databaseId state body url submittedAt authorAssociation author { __typename login }";
const ISSUE_COMMENT_FIELDS = "databaseId body url createdAt authorAssociation author { __typename login }";
const ROLLUP = (contexts: string) =>
  `commits(last: 1) { nodes { commit { oid statusCheckRollup { ${contexts} { ${PAGE_INFO} nodes { ${CONTEXT_FIELDS} } } } } } }`;

const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    number url title state isDraft mergeable mergeStateStatus reviewDecision headRefName headRefOid baseRefName
    ${ROLLUP("contexts(first: 100)")}
    reviewThreads(first: 100) { ${PAGE_INFO} nodes { ${THREAD_FIELDS} } }
    reviews(first: 100) { ${PAGE_INFO} nodes { ${REVIEW_FIELDS} } }
    comments(first: 100) { ${PAGE_INFO} nodes { ${ISSUE_COMMENT_FIELDS} } }
  } } }`;

const pageQuery = (connection: string) => `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${connection} } } }`;
const CONTEXTS_PAGE = pageQuery(ROLLUP("contexts(first: 100, after: $cursor)"));
const THREADS_PAGE = pageQuery(`reviewThreads(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${THREAD_FIELDS} } }`);
const REVIEWS_PAGE = pageQuery(`reviews(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${REVIEW_FIELDS} } }`);
const COMMENTS_PAGE = pageQuery(`comments(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${ISSUE_COMMENT_FIELDS} } }`);
const THREAD_COMMENTS_PAGE = `query($id: ID!, $cursor: String!) { node(id: $id) {
  ... on PullRequestReviewThread { comments(first: 100, after: $cursor) { ${PAGE_INFO} nodes { ${COMMENT_FIELDS} } } } } }`;
const THREAD_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { ${THREAD_FIELDS}
    pullRequest { number repository { owner { login } name } } } } }`;

const Association = Schema.Literals([
  "MEMBER",
  "OWNER",
  "MANNEQUIN",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
]);
const ReviewState = Schema.Literals(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

function page<N extends Schema.Top>(node: N) {
  return Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: nullable(Schema.String) }),
    nodes: Schema.Array(node),
  });
}

const Author = nullable(Schema.Struct({ __typename: Schema.String, login: Schema.String }));

const CheckRunNode = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  databaseId: Schema.Finite,
  name: Schema.String,
  status: Schema.Literals(["REQUESTED", "QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "PENDING"]),
  conclusion: nullable(
    Schema.Literals([
      "ACTION_REQUIRED",
      "TIMED_OUT",
      "CANCELLED",
      "FAILURE",
      "SUCCESS",
      "NEUTRAL",
      "SKIPPED",
      "STARTUP_FAILURE",
      "STALE",
    ]),
  ),
  detailsUrl: nullable(Schema.String),
  isRequired: withDefault(Schema.Boolean, false),
  checkSuite: nullable(
    Schema.Struct({
      databaseId: Schema.Finite,
      app: nullable(Schema.Struct({ databaseId: Schema.Finite, slug: Schema.String })),
      workflowRun: nullable(
        Schema.Struct({
          databaseId: Schema.Finite,
          event: Schema.String,
          workflow: nullable(Schema.Struct({ databaseId: Schema.Finite, name: Schema.String })),
        }),
      ),
    }),
  ),
});

const StatusContextNode = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  context: Schema.String,
  state: Schema.Literals(["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"]),
  targetUrl: nullable(Schema.String),
  description: nullable(Schema.String),
  isRequired: withDefault(Schema.Boolean, false),
});

const ContextNode = Schema.Union([CheckRunNode, StatusContextNode]);

const ThreadCommentNode = Schema.Struct({
  databaseId: Schema.Finite,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  authorAssociation: Association,
  author: Author,
  pullRequestReview: nullable(Schema.Struct({ state: ReviewState })),
});

const ThreadFields = {
  id: Schema.String,
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  path: nullable(Schema.String),
  line: nullable(Schema.Finite),
  comments: page(ThreadCommentNode),
};
const ThreadNode = Schema.Struct(ThreadFields);

const ReviewNode = Schema.Struct({
  databaseId: Schema.Finite,
  state: ReviewState,
  body: Schema.String,
  url: Schema.String,
  submittedAt: nullable(Schema.String),
  authorAssociation: Association,
  author: Author,
});

const IssueCommentNode = Schema.Struct({
  databaseId: Schema.Finite,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  authorAssociation: Association,
  author: Author,
});

const Rollup = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      commit: Schema.Struct({
        oid: Schema.String,
        statusCheckRollup: nullable(Schema.Struct({ contexts: page(ContextNode) })),
      }),
    }),
  ),
});

const PullRequestNode = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
  title: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  mergeStateStatus: Schema.Literals(["DIRTY", "UNKNOWN", "BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS", "CLEAN", "DRAFT"]),
  reviewDecision: nullable(Schema.Literals(["CHANGES_REQUESTED", "APPROVED", "REVIEW_REQUIRED"])),
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  commits: Rollup,
  reviewThreads: page(ThreadNode),
  reviews: page(ReviewNode),
  comments: page(IssueCommentNode),
});

const PrResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    repository: Schema.Struct({ pullRequest: PullRequestNode }),
  }),
});

function pullRequestPage<const F extends Schema.Struct.Fields>(fields: F) {
  return Schema.Struct({
    data: Schema.Struct({ repository: Schema.Struct({ pullRequest: Schema.Struct(fields) }) }),
  });
}

const ThreadCommentsPage = Schema.Struct({
  data: Schema.Struct({ node: nullable(Schema.Struct({ comments: page(ThreadCommentNode) })) }),
});

const ThreadResponse = Schema.Struct({
  data: Schema.Struct({
    node: nullable(
      Schema.Struct({
        ...ThreadFields,
        pullRequest: Schema.Struct({
          number: Schema.Finite,
          repository: Schema.Struct({ owner: Schema.Struct({ login: Schema.String }), name: Schema.String }),
        }),
      }),
    ),
  }),
});

const PrViewResponse = Schema.Struct({ url: Schema.String });

type Page<N> = {
  readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
  readonly nodes: ReadonlyArray<N>;
};
type PullRequestNode = typeof PullRequestNode.Type;
type CheckRunNode = typeof CheckRunNode.Type;
type StatusContextNode = typeof StatusContextNode.Type;
type ContextNode = typeof ContextNode.Type;
type ThreadNode = typeof ThreadNode.Type;
type ThreadCommentNode = typeof ThreadCommentNode.Type;
type ReviewNode = typeof ReviewNode.Type;
type IssueCommentNode = typeof IssueCommentNode.Type;
type AuthorNode = typeof Author.Type;
type Association = typeof Association.Type;

/** Review threads with every comment page followed. */
type FullThread = Omit<ThreadNode, "comments"> & { readonly comments: ReadonlyArray<ThreadCommentNode> };

const TRUSTED_ASSOCIATIONS: ReadonlyArray<Association> = ["OWNER", "MEMBER", "COLLABORATOR"];

/** Every node of a connection read, and why the read stopped early (empty when complete). */
type Drained<N> = { readonly nodes: ReadonlyArray<N>; readonly gaps: ReadonlyArray<string> };

/**
 * Create the forge client for one GitHub pull request.
 *
 * @param repo - The repository.
 * @param number - The pull request number.
 * @returns A client bound to that pull request, using the ambient `gh` runner.
 */
export const makeGitHubClient = Effect.fnUntraced(function* (repo: GitHubRepo, number: PrNumber) {
  const runner = yield* CommandRunner;
  const slug = `${repo.owner}/${repo.name}`;
  const prVariables = { owner: repo.owner, repo: repo.name, number };

  const graphql = <S extends Schema.Decoder<unknown>>(
    query: string,
    variables: Readonly<Record<string, string | number>>,
    schema: S,
  ): Effect.Effect<S["Type"], ForgeError> => {
    const args = Object.entries(variables).flatMap(([key, value]) =>
      typeof value === "number" ? ["-F", `${key}=${value}`] : ["-f", `${key}=${value}`],
    );
    return runner.run(["gh", "api", "graphql", ...args, "-f", `query=${query}`]).pipe(Effect.flatMap(decodeJson(schema)));
  };

  /** Follow every remaining page of a thread's comments. */
  const fullThread = (node: ThreadNode): Effect.Effect<Drained<FullThread>, ForgeError> =>
    drain(node.comments, `comments of review thread ${node.id}`, (cursor) =>
      graphql(THREAD_COMMENTS_PAGE, { id: node.id, cursor }, ThreadCommentsPage).pipe(
        Effect.map((next) => next.data.node?.comments ?? null),
      ),
    ).pipe(Effect.map((comments) => ({ nodes: [{ ...node, comments: comments.nodes }], gaps: comments.gaps })));

  const observe: Effect.Effect<Observation, ForgeError> = Effect.gen(function* () {
    const first = yield* graphql(PR_QUERY, prVariables, PrResponse);
    const pr = first.data.repository.pullRequest;
    const info = {
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state: prState(pr.state),
      isDraft: pr.isDraft,
      headSha: pr.headRefOid,
      headBranch: pr.headRefName,
      baseBranch: pr.baseRefName,
    };
    const base = {
      forge: "github",
      pr: info,
      mergeability: mergeability(pr.mergeable, pr.mergeStateStatus),
      reviewDecision: reviewDecision(pr.reviewDecision),
      viewer: first.data.viewer.login,
    } as const;
    if (info.state !== "open") {
      // Terminal: the stop must not depend on any further (possibly failing) page.
      const reasons = ["the pull request is closed; later pages were not read"];
      return { ...base, checks: [], reviewItems: [], completeness: { _tag: "incomplete", reasons } };
    }

    const headCommit = pr.commits.nodes[0]?.commit ?? null;
    // Independent connections are drained concurrently, outside any state lock.
    const [contexts, threadNodes, reviews, comments] = yield* Effect.all(
      [
        drain(headCommit?.statusCheckRollup?.contexts ?? emptyPage<ContextNode>(), "checks", (cursor) =>
          graphql(CONTEXTS_PAGE, { ...prVariables, cursor }, pullRequestPage({ commits: Rollup })).pipe(
            Effect.map((next) => {
              const commit = next.data.repository.pullRequest.commits.nodes[0]?.commit ?? null;
              // A push between pages would mix two commits' checks; report the gap instead.
              return commit === null || commit.oid !== headCommit?.oid ? null : (commit.statusCheckRollup?.contexts ?? null);
            }),
          ),
        ),
        drain(pr.reviewThreads, "review threads", (cursor) =>
          graphql(THREADS_PAGE, { ...prVariables, cursor }, pullRequestPage({ reviewThreads: page(ThreadNode) })).pipe(
            Effect.map((next) => next.data.repository.pullRequest.reviewThreads),
          ),
        ),
        drain(pr.reviews, "reviews", (cursor) =>
          graphql(REVIEWS_PAGE, { ...prVariables, cursor }, pullRequestPage({ reviews: page(ReviewNode) })).pipe(
            Effect.map((next) => next.data.repository.pullRequest.reviews),
          ),
        ),
        drain(pr.comments, "conversation comments", (cursor) =>
          graphql(COMMENTS_PAGE, { ...prVariables, cursor }, pullRequestPage({ comments: page(IssueCommentNode) })).pipe(
            Effect.map((next) => next.data.repository.pullRequest.comments),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const threads = yield* Effect.forEach(threadNodes.nodes, fullThread, { concurrency: THREAD_CONCURRENCY });

    const gaps = [contexts, threadNodes, reviews, comments, ...threads].flatMap((drained) => drained.gaps);
    if (headCommit !== null && headCommit.oid !== pr.headRefOid) gaps.push("the head commit moved while reading checks");

    return {
      ...base,
      checks: checks(contexts.nodes, slug),
      reviewItems: reviewItems(
        threads.flatMap((drained) => drained.nodes),
        reviews.nodes,
        comments.nodes,
      ),
      completeness: completenessOf(gaps),
    };
  });

  return ForgeClient.of({
    target: { repo, number },
    observe,

    readThread: (threadId) =>
      Effect.gen(function* () {
        const response = yield* graphql(THREAD_QUERY, { id: threadId }, ThreadResponse);
        const node = response.data.node;
        const owner = node?.pullRequest.repository;
        if (
          node === null ||
          node.pullRequest.number !== number ||
          owner?.owner.login.toLowerCase() !== repo.owner.toLowerCase() ||
          owner.name.toLowerCase() !== repo.name.toLowerCase()
        ) {
          return yield* new ThreadNotFound({ threadId });
        }
        const full = yield* fullThread(node);
        const [thread] = full.nodes;
        if (thread === undefined) return yield* new ThreadNotFound({ threadId });
        return { thread: threadRef(thread), completeness: completenessOf(full.gaps) };
      }),

    rerun: (target) => {
      if (target._tag !== "github_run") {
        return Effect.fail(new ShapeMismatch({ path: "$.target", expected: "a GitHub workflow run target" }));
      }
      // Already SHA-bound: `gh run rerun <run-id>` re-executes that workflow run, whose head SHA is
      // fixed when the run is created. A rerun from a delayed observation reruns the old commit's
      // run (the SHA its budget was charged to) and never touches the current head's runs.
      return runner
        .run(["gh", "run", "rerun", String(target.runId), "--failed", "-R", slug])
        .pipe(Effect.as({ _tag: "triggered", detail: `gh run rerun ${target.runId} --failed -R ${slug}` } as const));
    },
  });
});

/**
 * Live layer: the forge client for one GitHub pull request.
 *
 * @param repo - The repository.
 * @param number - The pull request number.
 * @returns A layer providing `ForgeClient`; it needs a `CommandRunner` for `gh`.
 */
export function gitHubForgeLayer(repo: GitHubRepo, number: PrNumber): Layer.Layer<ForgeClient, never, CommandRunner> {
  return Layer.effect(ForgeClient, makeGitHubClient(repo, number));
}

/**
 * Find the open pull request for the checked-out branch, the way `gh pr view` does.
 *
 * @param cwd - The working tree.
 * @returns The pull request target.
 */
export const findGitHubPrForCurrentBranch = Effect.fnUntraced(function* (cwd: string) {
  const runner = yield* CommandRunner;
  const stdout = yield* runner.run(["gh", "pr", "view", "--json", "url"], { cwd });
  const view = yield* decodeJson(PrViewResponse)(stdout);
  const target: PrTarget | null = parsePrUrl(view.url);
  if (target === null) return yield* new ShapeMismatch({ path: "$.url", expected: "a GitHub pull request URL" });
  return target;
});

/**
 * Collect every node of a cursor-paginated connection.
 *
 * @param first - The page already fetched.
 * @param label - What is being paged, for gap reports.
 * @param next - Fetches the page after a cursor; `null` means the data became inconsistent.
 * @returns All nodes read with this connection's gaps, or the forge failure.
 */
function drain<N>(
  first: Page<N>,
  label: string,
  next: (cursor: string) => Effect.Effect<Page<N> | null, ForgeError>,
): Effect.Effect<Drained<N>, ForgeError> {
  return Effect.gen(function* () {
    const nodes: N[] = [...first.nodes];
    let pageInfo = first.pageInfo;
    for (let pages = 1; pageInfo.hasNextPage; pages += 1) {
      if (pageInfo.endCursor === null || pages >= MAX_PAGES) return { nodes, gaps: [`${label}: stopped after ${pages} pages`] };
      const fetched = yield* next(pageInfo.endCursor);
      if (fetched === null) return { nodes, gaps: [`${label}: the pull request changed while paging`] };
      nodes.push(...fetched.nodes);
      pageInfo = fetched.pageInfo;
    }
    return { nodes, gaps: [] };
  });
}

function emptyPage<N>(): Page<N> {
  return { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
}

function completenessOf(gaps: ReadonlyArray<string>): Completeness {
  return gaps.length === 0 ? { _tag: "complete" } : { _tag: "incomplete", reasons: [...gaps] };
}

function prState(state: PullRequestNode["state"]): PrState {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return casesHandled(state);
  }
}

function mergeability(mergeable: PullRequestNode["mergeable"], status: PullRequestNode["mergeStateStatus"]): Mergeability {
  if (mergeable === "CONFLICTING" || status === "DIRTY") {
    return { status: "conflicting", detail: "merge conflicts with the base branch" };
  }
  if (mergeable === "UNKNOWN") return { status: "unknown", detail: null };
  switch (status) {
    case "UNKNOWN":
      return { status: "unknown", detail: null };
    case "BEHIND":
      return { status: "behind", detail: "head branch is behind the base branch" };
    case "BLOCKED":
      return { status: "blocked", detail: "blocked by branch protection" };
    case "DRAFT":
      return { status: "blocked", detail: "the pull request is a draft" };
    case "UNSTABLE":
      return { status: "clean", detail: "mergeable; some checks are not passing" };
    case "CLEAN":
    case "HAS_HOOKS":
      return { status: "clean", detail: null };
    default:
      return casesHandled(status);
  }
}

function reviewDecision(decision: PullRequestNode["reviewDecision"]): ReviewDecision {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    case null:
      // No review requirement applies to this pull request.
      return "none";
    default:
      return casesHandled(decision);
  }
}

function checks(contexts: ReadonlyArray<ContextNode>, slug: string): ReadonlyArray<Check> {
  const runs = contexts.filter((node): node is CheckRunNode => node.__typename === "CheckRun");
  const incompleteRunIds = new Set(
    runs.flatMap((run) => {
      const runId = run.checkSuite?.workflowRun?.databaseId;
      return runId !== undefined && run.status !== "COMPLETED" ? [runId] : [];
    }),
  );

  // A rerun or a concurrency-cancelled duplicate leaves several check runs for one job on the
  // same commit. Collapse only provable re-runs: an Actions job of the same workflow, event and
  // name; or, without workflow identity, the same name re-requested inside the same check suite.
  // Anything else stays separate, so a failing suite is never hidden by a passing one.
  const latest = new Map<string, CheckRunNode>();
  for (const run of runs) {
    const suite = run.checkSuite;
    const workflow = suite?.workflowRun?.workflow ?? null;
    const identity =
      workflow !== null
        ? ["workflow", suite?.app?.databaseId ?? null, workflow.databaseId, suite?.workflowRun?.event ?? null]
        : suite !== null
          ? ["suite", suite.databaseId]
          : ["run", run.databaseId];
    const key = JSON.stringify([...identity, run.name]);
    const existing = latest.get(key);
    if (existing === undefined || existing.databaseId < run.databaseId) latest.set(key, run);
  }

  const statuses = contexts.filter((node): node is StatusContextNode => node.__typename === "StatusContext");
  return [
    ...[...latest.values()].map((run) => checkRunToCheck(run, slug, incompleteRunIds)),
    ...statuses.map(statusContextToCheck),
  ];
}

function checkRunToCheck(run: CheckRunNode, slug: string, incompleteRunIds: ReadonlySet<number>): Check {
  const status = checkRunStatus(run.status, run.conclusion);
  const workflowRun = run.checkSuite?.workflowRun ?? null;
  const isActions = run.checkSuite?.app?.slug === "github-actions" && workflowRun !== null;
  const endpoint = `repos/${slug}/actions/jobs/${run.databaseId}/logs`;
  return {
    name: run.name,
    group: workflowRun?.workflow?.name ?? run.checkSuite?.app?.slug ?? null,
    status,
    conclusion: run.conclusion ?? run.status,
    required: run.isRequired,
    url: run.detailsUrl,
    retry:
      isActions && workflowRun !== null
        ? {
            key: `github_run:${workflowRun.databaseId}`,
            ready: !incompleteRunIds.has(workflowRun.databaseId),
            target: { _tag: "github_run", runId: workflowRun.databaseId },
          }
        : null,
    failedJobs:
      status === "failed"
        ? [
            {
              name: run.name,
              check: workflowRun?.workflow?.name ?? run.name,
              url: run.detailsUrl,
              errors: [],
              log:
                isActions && workflowRun !== null
                  ? {
                      kind: "github_job",
                      runId: workflowRun.databaseId,
                      jobId: run.databaseId,
                      endpoint,
                      // The job-logs endpoint serves a finished job's log while the rest of the
                      // run is still going; `gh run view --log-failed` waits for the whole run.
                      command: ["gh", "api", "--allow-escape-sequences", endpoint],
                    }
                  : null,
            },
          ]
        : [],
  };
}

function checkRunStatus(status: CheckRunNode["status"], conclusion: CheckRunNode["conclusion"]): CheckStatus {
  if (status !== "COMPLETED" || conclusion === null) return "pending";
  switch (conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
      return "passed";
    case "SKIPPED":
      return "skipped";
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
    case "STALE":
      return "failed";
    default:
      return casesHandled(conclusion);
  }
}

function statusContextToCheck(node: StatusContextNode): Check {
  const status = statusContextStatus(node.state);
  return {
    name: node.context,
    group: null,
    status,
    conclusion: node.state,
    required: node.isRequired,
    url: node.targetUrl,
    retry: null,
    failedJobs:
      status === "failed"
        ? [
            {
              name: node.context,
              check: node.context,
              url: node.targetUrl,
              errors: node.description === null ? [] : [node.description],
              log: null,
            },
          ]
        : [],
  };
}

function statusContextStatus(state: StatusContextNode["state"]): CheckStatus {
  switch (state) {
    case "SUCCESS":
      return "passed";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case "FAILURE":
    case "ERROR":
      return "failed";
    default:
      return casesHandled(state);
  }
}

function threadRef(node: FullThread): ReviewThread {
  const participants = new Map<string, ReviewAuthor>();
  for (const comment of published(node.comments)) {
    const who = authorOf(comment.author, comment.authorAssociation);
    participants.set(who.key, who);
  }
  return {
    id: node.id,
    resolved: node.isResolved,
    outdated: node.isOutdated,
    path: node.path,
    line: node.line,
    participants: [...participants.values()],
  };
}

/** Comments attached to an unsubmitted (PENDING) review are invisible to others and may still change. */
function published(comments: ReadonlyArray<ThreadCommentNode>): ReadonlyArray<ThreadCommentNode> {
  return comments.filter((comment) => comment.pullRequestReview?.state !== "PENDING");
}

function reviewItems(
  threads: ReadonlyArray<FullThread>,
  reviews: ReadonlyArray<ReviewNode>,
  comments: ReadonlyArray<IssueCommentNode>,
): ReadonlyArray<ReviewItem> {
  const threadItems = threads.flatMap((node) => {
    const ref = threadRef(node);
    return published(node.comments).map(
      (comment): ReviewItem => ({
        id: `github:review_comment:${comment.databaseId}`,
        kind: "inline_comment",
        author: authorOf(comment.author, comment.authorAssociation),
        body: comment.body,
        url: comment.url,
        createdAt: comment.createdAt,
        verdict: null,
        thread: ref,
      }),
    );
  });

  const reviewSubmissions = reviews.flatMap((node): ReadonlyArray<ReviewItem> => {
    const verdict = reviewVerdict(node.state);
    // An empty COMMENTED/APPROVED body is just the envelope of inline comments or a bare approval,
    // both already visible elsewhere (thread items, reviewDecision).
    if (verdict === null || node.submittedAt === null) return [];
    if (node.body.trim() === "" && verdict !== "changes_requested") return [];
    return [
      {
        id: `github:review:${node.databaseId}`,
        kind: "review",
        author: authorOf(node.author, node.authorAssociation),
        body: node.body,
        url: node.url,
        createdAt: node.submittedAt,
        verdict,
        thread: null,
      },
    ];
  });

  const conversation = comments.map(
    (node): ReviewItem => ({
      id: `github:issue_comment:${node.databaseId}`,
      kind: "conversation_comment",
      author: authorOf(node.author, node.authorAssociation),
      body: node.body,
      url: node.url,
      createdAt: node.createdAt,
      verdict: null,
      thread: null,
    }),
  );

  return [...threadItems, ...reviewSubmissions, ...conversation];
}

function reviewVerdict(state: ReviewNode["state"]): ReviewItem["verdict"] {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "PENDING":
    case "DISMISSED":
      // Unsubmitted and dismissed reviews are not actionable feedback.
      return null;
    default:
      return casesHandled(state);
  }
}

function authorOf(node: AuthorNode, association: Association): ReviewAuthor {
  if (node === null) return { login: "ghost", key: "ghost", role: "outsider" };
  const role: AuthorRole =
    node.__typename === "Bot" ? "bot" : TRUSTED_ASSOCIATIONS.includes(association) ? "collaborator" : "outsider";
  return { login: node.login, key: identityKey(node.login), role };
}
