/**
 * GitHub adapter: GraphQL through `gh api graphql`, following every connection's cursor (checks,
 * review threads, each thread's comments, reviews, conversation comments), parsed into the
 * forge-neutral {@link Observation}. Reruns go through `gh run rerun --failed`.
 */
import type { CommandRunner } from "./command-runner.ts";
import {
  array,
  boolean,
  constant,
  decodeJson,
  either,
  literal,
  nullable,
  number,
  object,
  ShapeMismatch,
  string,
  withDefault,
  type Decoded,
  type Decoder,
} from "./decode.ts";
import { ThreadNotFound, type ForgeClient, type ForgeError } from "./forge-client.ts";
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
import { all, casesHandled, err, ok, type Result } from "./result.ts";

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

const ASSOCIATIONS = [
  "MEMBER",
  "OWNER",
  "MANNEQUIN",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "NONE",
] as const;

function page<N>(node: Decoder<N>) {
  return object({ pageInfo: object({ hasNextPage: boolean, endCursor: nullable(string) }), nodes: array(node) });
}

const author = nullable(object({ __typename: string, login: string }));

const checkRun = object({
  __typename: constant("CheckRun"),
  databaseId: number,
  name: string,
  status: literal(["REQUESTED", "QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "PENDING"]),
  conclusion: nullable(
    literal([
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
  detailsUrl: nullable(string),
  isRequired: withDefault(boolean, false),
  checkSuite: nullable(
    object({
      databaseId: number,
      app: nullable(object({ databaseId: number, slug: string })),
      workflowRun: nullable(
        object({
          databaseId: number,
          event: string,
          workflow: nullable(object({ databaseId: number, name: string })),
        }),
      ),
    }),
  ),
});

const statusContext = object({
  __typename: constant("StatusContext"),
  context: string,
  state: literal(["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"]),
  targetUrl: nullable(string),
  description: nullable(string),
  isRequired: withDefault(boolean, false),
});

const contextNode = either(checkRun, statusContext);

const threadComment = object({
  databaseId: number,
  body: string,
  url: string,
  createdAt: string,
  authorAssociation: literal(ASSOCIATIONS),
  author,
  pullRequestReview: nullable(object({ state: literal(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]) })),
});

const thread = object({
  id: string,
  isResolved: boolean,
  isOutdated: boolean,
  path: nullable(string),
  line: nullable(number),
  comments: page(threadComment),
});

const review = object({
  databaseId: number,
  state: literal(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]),
  body: string,
  url: string,
  submittedAt: nullable(string),
  authorAssociation: literal(ASSOCIATIONS),
  author,
});

const issueComment = object({
  databaseId: number,
  body: string,
  url: string,
  createdAt: string,
  authorAssociation: literal(ASSOCIATIONS),
  author,
});

const rollup = object({
  nodes: array(
    object({
      commit: object({ oid: string, statusCheckRollup: nullable(object({ contexts: page(contextNode) })) }),
    }),
  ),
});

const prResponse = object({
  data: object({
    viewer: object({ login: string }),
    repository: object({
      pullRequest: object({
        number: number,
        url: string,
        title: string,
        state: literal(["OPEN", "CLOSED", "MERGED"]),
        isDraft: boolean,
        mergeable: literal(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        mergeStateStatus: literal(["DIRTY", "UNKNOWN", "BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS", "CLEAN", "DRAFT"]),
        reviewDecision: nullable(literal(["CHANGES_REQUESTED", "APPROVED", "REVIEW_REQUIRED"])),
        headRefName: string,
        headRefOid: string,
        baseRefName: string,
        commits: rollup,
        reviewThreads: page(thread),
        reviews: page(review),
        comments: page(issueComment),
      }),
    }),
  }),
});

const pullRequestPage = <S extends Record<string, Decoder<unknown>>>(shape: S) =>
  object({ data: object({ repository: object({ pullRequest: object(shape) }) }) });

const threadCommentsPage = object({ data: object({ node: nullable(object({ comments: page(threadComment) })) }) });

const threadResponse = object({
  data: object({
    node: nullable(
      object({
        id: string,
        isResolved: boolean,
        isOutdated: boolean,
        path: nullable(string),
        line: nullable(number),
        comments: page(threadComment),
        pullRequest: object({ number: number, repository: object({ owner: object({ login: string }), name: string }) }),
      }),
    ),
  }),
});

type Page<N> = { readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null }; readonly nodes: ReadonlyArray<N> };
type PullRequestNode = Decoded<typeof prResponse>["data"]["repository"]["pullRequest"];
type CheckRunNode = Decoded<typeof checkRun>;
type StatusContextNode = Decoded<typeof statusContext>;
type ContextNode = Decoded<typeof contextNode>;
type ThreadNode = Decoded<typeof thread>;
type ThreadCommentNode = Decoded<typeof threadComment>;
type ReviewNode = Decoded<typeof review>;
type IssueCommentNode = Decoded<typeof issueComment>;
type AuthorNode = Decoded<typeof author>;
type Association = (typeof ASSOCIATIONS)[number];

/** Review threads with every comment page followed. */
type FullThread = Omit<ThreadNode, "comments"> & { readonly comments: ReadonlyArray<ThreadCommentNode> };

const TRUSTED_ASSOCIATIONS: ReadonlyArray<Association> = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * Create a forge client for one GitHub pull request.
 *
 * @param runner - Runs `gh`.
 * @param repo - The repository.
 * @param number - The pull request number.
 * @returns A client bound to that pull request.
 */
export function gitHubClient(runner: CommandRunner, repo: GitHubRepo, number: PrNumber): ForgeClient {
  const slug = `${repo.owner}/${repo.name}`;
  const graphql = async <T>(query: string, variables: Readonly<Record<string, string | number>>, decoder: Decoder<T>) => {
    const args = Object.entries(variables).flatMap(([key, value]) =>
      typeof value === "number" ? ["-F", `${key}=${value}`] : ["-f", `${key}=${value}`],
    );
    const stdout = await runner(["gh", "api", "graphql", ...args, "-f", `query=${query}`]);
    return stdout._tag === "err" ? stdout : decodeJson(stdout.value, decoder);
  };
  const prVariables = { owner: repo.owner, repo: repo.name, number };

  /** Follow every remaining page of a thread's comments. */
  const fullThread = async (node: ThreadNode): Promise<Result<Drained<FullThread>, ForgeError>> => {
    const comments = await drain(node.comments, `comments of review thread ${node.id}`, async (cursor) => {
      const next = await graphql(THREAD_COMMENTS_PAGE, { id: node.id, cursor }, threadCommentsPage);
      return next._tag === "err" ? next : ok(next.value.data.node?.comments ?? null);
    });
    if (comments._tag === "err") return comments;
    return ok({ nodes: [{ ...node, comments: comments.value.nodes }], gaps: comments.value.gaps });
  };
  return {
    target: { repo, number },

    async observe(): Promise<Result<Observation, ForgeError>> {
      const first = await graphql(PR_QUERY, prVariables, prResponse);
      if (first._tag === "err") return first;
      const pr = first.value.data.repository.pullRequest;
      const viewer = first.value.data.viewer.login;
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
        viewer,
      } as const;
      if (info.state !== "open") {
        // Terminal: the stop must not depend on any further (possibly failing) page.
        const reasons = ["the pull request is closed; later pages were not read"];
        return ok({ ...base, checks: [], reviewItems: [], completeness: { _tag: "incomplete", reasons } });
      }

      const headCommit = pr.commits.nodes[0]?.commit ?? null;
      // Independent connections are drained concurrently, outside any state lock.
      const [contexts, threadNodes, reviews, comments] = await Promise.all([
        drain(headCommit?.statusCheckRollup?.contexts ?? emptyPage<ContextNode>(), "checks", async (cursor) => {
          const next = await graphql(CONTEXTS_PAGE, { ...prVariables, cursor }, pullRequestPage({ commits: rollup }));
          if (next._tag === "err") return next;
          const commit = next.value.data.repository.pullRequest.commits.nodes[0]?.commit ?? null;
          // A push between pages would mix two commits' checks; report the gap instead.
          return ok(commit === null || commit.oid !== headCommit?.oid ? null : (commit.statusCheckRollup?.contexts ?? null));
        }),
        drain(pr.reviewThreads, "review threads", async (cursor) => {
          const next = await graphql(THREADS_PAGE, { ...prVariables, cursor }, pullRequestPage({ reviewThreads: page(thread) }));
          return next._tag === "err" ? next : ok(next.value.data.repository.pullRequest.reviewThreads);
        }),
        drain(pr.reviews, "reviews", async (cursor) => {
          const next = await graphql(REVIEWS_PAGE, { ...prVariables, cursor }, pullRequestPage({ reviews: page(review) }));
          return next._tag === "err" ? next : ok(next.value.data.repository.pullRequest.reviews);
        }),
        drain(pr.comments, "conversation comments", async (cursor) => {
          const next = await graphql(COMMENTS_PAGE, { ...prVariables, cursor }, pullRequestPage({ comments: page(issueComment) }));
          return next._tag === "err" ? next : ok(next.value.data.repository.pullRequest.comments);
        }),
      ]);
      if (contexts._tag === "err") return contexts;
      if (threadNodes._tag === "err") return threadNodes;
      if (reviews._tag === "err") return reviews;
      if (comments._tag === "err") return comments;
      const threads = all(await mapBounded(threadNodes.value.nodes, THREAD_CONCURRENCY, fullThread));
      if (threads._tag === "err") return threads;

      const gaps = [contexts, threadNodes, reviews, comments, ...threads.value.map((drained) => ok(drained))].flatMap(
        (drained) => drained.value.gaps,
      );
      if (headCommit !== null && headCommit.oid !== pr.headRefOid) gaps.push("the head commit moved while reading checks");

      return ok({
        ...base,
        checks: checks(contexts.value.nodes, slug),
        reviewItems: reviewItems(
          threads.value.flatMap((drained) => drained.nodes),
          reviews.value.nodes,
          comments.value.nodes,
        ),
        completeness: completenessOf(gaps),
      });
    },

    async readThread(threadId) {
      const response = await graphql(THREAD_QUERY, { id: threadId }, threadResponse);
      if (response._tag === "err") return response;
      const node = response.value.data.node;
      const owner = node?.pullRequest.repository;
      if (
        node === null ||
        node.pullRequest.number !== number ||
        owner?.owner.login.toLowerCase() !== repo.owner.toLowerCase() ||
        owner.name.toLowerCase() !== repo.name.toLowerCase()
      ) {
        return err(new ThreadNotFound(threadId));
      }
      const full = await fullThread(node);
      if (full._tag === "err") return full;
      const [thread] = full.value.nodes;
      if (thread === undefined) return err(new ThreadNotFound(threadId));
      return ok({ thread: threadRef(thread), completeness: completenessOf(full.value.gaps) });
    },

    async rerun(target) {
      if (target._tag !== "github_run") return err(new ShapeMismatch("$.target", "a GitHub workflow run target"));
      // Already SHA-bound: `gh run rerun <run-id>` re-executes that workflow run, whose head SHA is
      // fixed when the run is created. A rerun from a delayed observation reruns the old commit's
      // run (the SHA its budget was charged to) and never touches the current head's runs.
      const rerun = await runner(["gh", "run", "rerun", String(target.runId), "--failed", "-R", slug]);
      return rerun._tag === "err" ? rerun : ok({ _tag: "triggered", detail: `gh run rerun ${target.runId} --failed -R ${slug}` });
    },
  };
}

/**
 * Find the open pull request for the checked-out branch, the way `gh pr view` does.
 *
 * @param runner - Runs `gh`.
 * @param cwd - The working tree.
 * @returns The pull request target.
 */
export async function findGitHubPrForCurrentBranch(
  runner: CommandRunner,
  cwd: string,
): Promise<Result<PrTarget, ForgeError>> {
  const stdout = await runner(["gh", "pr", "view", "--json", "url"], { cwd });
  if (stdout._tag === "err") return stdout;
  const decoded = decodeJson(stdout.value, object({ url: string }));
  if (decoded._tag === "err") return decoded;
  const target = parsePrUrl(decoded.value.url);
  return target === null ? err(new ShapeMismatch("$.url", "a GitHub pull request URL")) : ok(target);
}

/** Every node of a connection read, and why the read stopped early (empty when complete). */
type Drained<N> = { readonly nodes: ReadonlyArray<N>; readonly gaps: ReadonlyArray<string> };

/**
 * Collect every node of a cursor-paginated connection.
 *
 * @param first - The page already fetched.
 * @param label - What is being paged, for gap reports.
 * @param next - Fetches the page after a cursor; `null` means the data became inconsistent.
 * @returns All nodes read with this connection's gaps, or the forge failure.
 */
async function drain<N>(
  first: Page<N>,
  label: string,
  next: (cursor: string) => Promise<Result<Page<N> | null, ForgeError>>,
): Promise<Result<Drained<N>, ForgeError>> {
  const nodes: N[] = [...first.nodes];
  let pageInfo = first.pageInfo;
  for (let pages = 1; pageInfo.hasNextPage; pages += 1) {
    if (pageInfo.endCursor === null || pages >= MAX_PAGES) return ok({ nodes, gaps: [`${label}: stopped after ${pages} pages`] });
    const fetched = await next(pageInfo.endCursor);
    if (fetched._tag === "err") return fetched;
    if (fetched.value === null) return ok({ nodes, gaps: [`${label}: the pull request changed while paging`] });
    nodes.push(...fetched.value.nodes);
    pageInfo = fetched.value.pageInfo;
  }
  return ok({ nodes, gaps: [] });
}

/** Map with at most `limit` calls in flight, keeping input order. */
async function mapBounded<T, U>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    for (let mine = index++; mine < items.length; mine = index++) {
      const item = items[mine];
      if (item !== undefined) results[mine] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
