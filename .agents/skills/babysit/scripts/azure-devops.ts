/**
 * Azure DevOps adapter: `az repos pr show`, `az repos pr policy list`, PR threads and build
 * timelines through `az devops invoke`, parsed with Effect Schema into the forge-neutral
 * {@link Observation}. Reruns requeue policy evaluations.
 */
import { Effect, Layer, Schema } from "effect";
import { CommandRunner } from "./command-runner.ts";
import { casesHandled } from "./defects.ts";
import { decodeJson, nullable, ShapeMismatch, withDefault } from "./decode.ts";
import { ForgeClient, NoOpenPullRequest, ThreadNotFound, type ForgeError } from "./forge-client.ts";
import type {
  Check,
  CheckStatus,
  Completeness,
  FailedJob,
  Mergeability,
  Observation,
  PrState,
  ReviewAuthor,
  ReviewDecision,
  ReviewItem,
  ReviewThread,
} from "./pr-snapshot.ts";
import { parsePrNumber, type AzureRepo, type PrNumber, type PrTarget } from "./pr-target.ts";

const REVIEWER_POLICIES: ReadonlyArray<string> = ["Minimum number of reviewers", "Required reviewers"];
/**
 * Policies evaluated against the completion options chosen when the PR is completed, not the
 * PR's content. They report `rejected` on most open PRs, so they are not merge blockers here.
 */
const COMPLETION_POLICIES: ReadonlyArray<string> = ["Require a merge strategy"];
/**
 * Graph subject types of people: `aad` (Entra user) and `msa` (Microsoft account). Everything
 * else (`aadsp` service principal, `svc` service identity such as a build service, `s2s`, `imp`,
 * groups) is automation, as is an identity without a descriptor.
 */
const HUMAN_SUBJECT_TYPES: ReadonlyArray<string> = ["aad", "msa"];

const Identity = Schema.Struct({
  id: Schema.String,
  displayName: withDefault(Schema.String, ""),
  uniqueName: nullable(Schema.String),
  descriptor: nullable(Schema.String),
});

const PullRequestRecord = Schema.Struct({
  pullRequestId: Schema.Finite,
  title: withDefault(Schema.String, ""),
  status: Schema.Literals(["active", "abandoned", "completed"]),
  isDraft: withDefault(Schema.Boolean, false),
  mergeStatus: nullable(Schema.Literals(["notSet", "queued", "conflicts", "succeeded", "rejectedByPolicy", "failure"])),
  mergeFailureMessage: nullable(Schema.String),
  sourceRefName: Schema.String,
  targetRefName: Schema.String,
  lastMergeSourceCommit: nullable(Schema.Struct({ commitId: Schema.String })),
  reviewers: withDefault(Schema.Array(Schema.Struct({ vote: Schema.Literals([10, 5, 0, -5, -10]) })), []),
  repository: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    project: Schema.Struct({ id: Schema.String, name: Schema.String }),
  }),
});

const PolicyEvaluation = Schema.Struct({
  evaluationId: Schema.String,
  status: Schema.Literals(["queued", "running", "approved", "rejected", "notApplicable", "broken"]),
  configuration: Schema.Struct({
    isBlocking: Schema.Boolean,
    isEnabled: Schema.Boolean,
    type: Schema.Struct({ displayName: Schema.String }),
    settings: nullable(
      Schema.Struct({
        displayName: nullable(Schema.String),
        statusName: nullable(Schema.String),
        statusGenre: nullable(Schema.String),
        manualQueueOnly: withDefault(Schema.Boolean, false),
      }),
    ),
  }),
  context: nullable(
    Schema.Struct({
      buildId: nullable(Schema.Finite),
      buildDefinitionName: nullable(Schema.String),
      isExpired: withDefault(Schema.Boolean, false),
    }),
  ),
});
const PolicyEvaluations = Schema.Array(PolicyEvaluation);

const ThreadRecord = Schema.Struct({
  id: Schema.Finite,
  status: nullable(Schema.Literals(["unknown", "active", "fixed", "wontFix", "closed", "byDesign", "pending"])),
  isDeleted: withDefault(Schema.Boolean, false),
  threadContext: nullable(
    Schema.Struct({
      filePath: nullable(Schema.String),
      rightFileStart: nullable(Schema.Struct({ line: Schema.Finite })),
      leftFileStart: nullable(Schema.Struct({ line: Schema.Finite })),
    }),
  ),
  comments: withDefault(
    Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        content: withDefault(Schema.String, ""),
        commentType: nullable(Schema.Literals(["unknown", "text", "codeChange", "system"])),
        isDeleted: withDefault(Schema.Boolean, false),
        publishedDate: withDefault(Schema.String, ""),
        author: Identity,
      }),
    ),
    [],
  ),
});
const ThreadList = Schema.Struct({ value: Schema.Array(ThreadRecord), continuation_token: nullable(Schema.String) });

const TimelineRecord = Schema.Struct({
  type: withDefault(Schema.String, ""),
  name: withDefault(Schema.String, ""),
  state: nullable(Schema.Literals(["pending", "inProgress", "completed"])),
  result: nullable(Schema.Literals(["succeeded", "succeededWithIssues", "failed", "canceled", "skipped", "abandoned"])),
  log: nullable(Schema.Struct({ id: Schema.Finite })),
  issues: withDefault(
    Schema.Array(Schema.Struct({ type: withDefault(Schema.String, ""), message: withDefault(Schema.String, "") })),
    [],
  ),
});
const Timeline = Schema.NullOr(Schema.Struct({ records: withDefault(Schema.Array(TimelineRecord), []) }));

const PrListResponse = Schema.Array(Schema.Struct({ pullRequestId: Schema.Finite }));

type PullRequestRecord = typeof PullRequestRecord.Type;
type PolicyEvaluation = typeof PolicyEvaluation.Type;
type ThreadRecord = typeof ThreadRecord.Type;
type IdentityRecord = typeof Identity.Type;
type TimelineRecord = typeof TimelineRecord.Type;

/** Where the PR lives, as `az repos pr show` reports it. */
type PrLocation = {
  readonly projectId: string;
  readonly projectName: string;
  readonly repositoryId: string;
  readonly webUrl: string;
};

type Az = <S extends Schema.Decoder<unknown>>(args: ReadonlyArray<string>, schema: S) => Effect.Effect<S["Type"], ForgeError>;

/**
 * Create the forge client for one Azure DevOps pull request.
 *
 * @param repo - The repository (organization URL, project, repository).
 * @param number - The pull request ID.
 * @returns A client bound to that pull request, using the ambient `az` runner.
 */
export const makeAzureDevOpsClient = Effect.fnUntraced(function* (repo: AzureRepo, number: PrNumber) {
  const runner = yield* CommandRunner;
  const org = repo.organizationUrl;
  const az: Az = (args, schema) =>
    runner.run(["az", ...args, "--org", org, "--only-show-errors", "-o", "json"]).pipe(Effect.flatMap(decodeJson(schema)));

  const showPr = Effect.gen(function* () {
    const pr = yield* az(["repos", "pr", "show", "--id", String(number)], PullRequestRecord);
    const { repository } = pr;
    const location: PrLocation = {
      projectId: repository.project.id,
      projectName: repository.project.name,
      repositoryId: repository.id,
      webUrl: `${org}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(
        repository.name,
      )}/pullrequest/${number}`,
    };
    return { pr, location };
  });
  const listPolicies = az(["repos", "pr", "policy", "list", "--id", String(number)], PolicyEvaluations);
  const threadRoute = (location: PrLocation) => [
    "--route-parameters",
    `project=${location.projectId}`,
    `repositoryId=${location.repositoryId}`,
    `pullRequestId=${number}`,
  ];

  const observe: Effect.Effect<Observation, ForgeError> = Effect.gen(function* () {
    const { pr, location } = yield* showPr;
    const info = {
      number: pr.pullRequestId,
      url: location.webUrl,
      title: pr.title,
      state: prState(pr.status),
      isDraft: pr.isDraft,
      headSha: pr.lastMergeSourceCommit?.commitId ?? "unknown",
      headBranch: stripRefsHeads(pr.sourceRefName),
      baseBranch: stripRefsHeads(pr.targetRefName),
    };
    if (info.state !== "open") {
      // Terminal: the stop must not depend on any further (possibly failing) call.
      return {
        forge: "azdo",
        pr: info,
        mergeability: { status: "unknown", detail: null },
        reviewDecision: "none",
        checks: [],
        reviewItems: [],
        viewer: null,
        completeness: { _tag: "incomplete", reasons: ["the pull request is closed; checks and threads were not read"] },
      } as const;
    }

    const [policies, threadList] = yield* Effect.all(
      [
        listPolicies,
        az(
          ["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads", ...threadRoute(location), "--api-version", "7.1"],
          ThreadList,
        ),
      ],
      { concurrency: "unbounded" },
    );

    const gaps: string[] = [];
    if (threadList.continuation_token !== null) gaps.push("more PR threads than one page; later threads were not read");
    const enabled = policies.filter((policy) => policy.configuration.isEnabled && policy.status !== "notApplicable");
    const builds = enabled.flatMap((policy) => {
      const buildId = policy.context?.buildId ?? null;
      // A running or failed build may already show failed tasks. Approved builds have none,
      // and an expired result belongs to an older build, not this commit.
      const current = policy.status !== "approved" && policy.context?.isExpired !== true;
      return isBuildPolicy(policy) && buildId !== null && current ? [{ buildId, name: buildName(policy) }] : [];
    });
    const timelines = yield* Effect.forEach(
      builds,
      ({ buildId, name }) =>
        az(
          [
            "devops",
            "invoke",
            "--area",
            "build",
            "--resource",
            "timeline",
            "--route-parameters",
            `project=${location.projectId}`,
            `buildId=${buildId}`,
            "--api-version",
            "7.1",
          ],
          Timeline,
        ).pipe(
          Effect.map((records) => ({
            buildId,
            jobs: timelineFailures(records?.records ?? [], buildId, name, location, org),
            gap: null,
          })),
          // A missing timeline only hides diagnosis detail; report it as a gap, not a failed poll.
          Effect.catch((error) =>
            Effect.succeed({ buildId, jobs: [], gap: `could not read the timeline of build ${buildId}: ${error.message}` }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    gaps.push(...timelines.flatMap((timeline) => (timeline.gap === null ? [] : [timeline.gap])));
    const failedJobsByBuild = new Map(timelines.map((timeline) => [timeline.buildId, timeline.jobs]));

    return {
      forge: "azdo",
      pr: info,
      mergeability: mergeability(pr, enabled),
      reviewDecision: reviewDecision(pr, enabled),
      checks: enabled.flatMap((policy) => policyToChecks(policy, org, location, failedJobsByBuild)),
      reviewItems: threadList.value.flatMap((record) => threadItems(record, location.webUrl)),
      viewer: null,
      completeness: gaps.length === 0 ? { _tag: "complete" } : { _tag: "incomplete", reasons: gaps },
    };
  });

  return ForgeClient.of({
    target: { repo, number },
    observe,

    readThread: (threadId) =>
      Effect.gen(function* () {
        const id = Number(threadId);
        if (!Number.isSafeInteger(id) || id <= 0) return yield* new ThreadNotFound({ threadId });
        const { location } = yield* showPr;
        const record = yield* az(
          [
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            ...threadRoute(location),
            `threadId=${id}`,
            "--api-version",
            "7.1",
          ],
          ThreadRecord,
        );
        const ref = record.isDeleted ? null : threadRef(record);
        if (ref === null) return yield* new ThreadNotFound({ threadId });
        const completeness: Completeness = { _tag: "complete" };
        return { thread: ref, completeness };
      }),

    rerun: (target, headSha) =>
      Effect.gen(function* () {
        if (target._tag !== "azdo_policy") {
          return yield* new ShapeMismatch({ path: "$.target", expected: "an Azure DevOps policy target" });
        }
        // `policy queue` builds whatever the PR head is now, not the commit the retry was charged
        // to. Re-check both right before queueing; the remaining check-then-act window (a push in
        // the next instant) is accepted: the new build then simply validates the newer commit.
        const { pr } = yield* showPr;
        const currentHead = pr.lastMergeSourceCommit?.commitId ?? "unknown";
        if (currentHead !== headSha) return { _tag: "stale_head", currentHead } as const;
        const policies = yield* listPolicies;
        const evaluation = policies.find((policy) => policy.evaluationId === target.evaluationId);
        const status = evaluation === undefined ? "missing" : buildPolicyStatus(evaluation).status;
        if (status !== "failed") return { _tag: "not_terminal", status } as const;
        yield* runner.run([
          "az",
          "repos",
          "pr",
          "policy",
          "queue",
          "--id",
          String(number),
          "--evaluation-id",
          target.evaluationId,
          "--org",
          org,
          "--only-show-errors",
          "-o",
          "none",
        ]);
        return {
          _tag: "triggered",
          detail: `az repos pr policy queue --id ${number} --evaluation-id ${target.evaluationId}`,
        } as const;
      }),
  });
});

/**
 * Live layer: the forge client for one Azure DevOps pull request.
 *
 * @param repo - The repository.
 * @param number - The pull request ID.
 * @returns A layer providing `ForgeClient`; it needs a `CommandRunner` for `az`.
 */
export function azureDevOpsForgeLayer(repo: AzureRepo, number: PrNumber): Layer.Layer<ForgeClient, never, CommandRunner> {
  return Layer.effect(ForgeClient, makeAzureDevOpsClient(repo, number));
}

/**
 * Find the single active pull request whose source branch is `branch`.
 *
 * @param repo - The repository from the git remote.
 * @param branch - The checked-out branch name.
 * @returns The pull request target, or `NoOpenPullRequest` for zero or several matches.
 */
export const findAzurePrForBranch = Effect.fnUntraced(function* (repo: AzureRepo, branch: string) {
  const runner = yield* CommandRunner;
  const stdout = yield* runner.run([
    "az",
    "repos",
    "pr",
    "list",
    "--org",
    repo.organizationUrl,
    "--project",
    repo.project,
    "--repository",
    repo.name,
    "--source-branch",
    branch,
    "--status",
    "active",
    "--only-show-errors",
    "-o",
    "json",
  ]);
  const found = yield* decodeJson(PrListResponse)(stdout);
  const [only, ...rest] = found;
  const prNumber = only === undefined ? null : parsePrNumber(only.pullRequestId);
  if (prNumber === null || rest.length > 0) return yield* new NoOpenPullRequest({ branch, found: found.length });
  const target: PrTarget = { repo, number: prNumber };
  return target;
});

function timelineFailures(
  records: ReadonlyArray<TimelineRecord>,
  buildId: number,
  checkName: string,
  location: PrLocation,
  org: string,
): ReadonlyArray<FailedJob> {
  const failed = records.filter((record) => record.result === "failed");
  // Tasks carry the precise log; fall back to jobs when a job failed without a failed task
  // (agent lost, timeout, cancelled dependency).
  const tasks = failed.filter((record) => record.type === "Task");
  const chosen = tasks.length > 0 ? tasks : failed.filter((record) => record.type === "Job");
  return chosen.map((record) => ({
    name: record.name,
    check: checkName,
    url: buildUrl(org, location.projectName, buildId),
    errors: record.issues
      .filter((issue) => issue.type === "error")
      .map((issue) => issue.message)
      .slice(0, 5),
    log:
      record.log === null
        ? null
        : {
            kind: "azdo_build_log",
            buildId,
            logId: record.log.id,
            command: [
              "az",
              "devops",
              "invoke",
              "--org",
              org,
              "--area",
              "build",
              "--resource",
              "logs",
              "--route-parameters",
              `project=${location.projectId}`,
              `buildId=${buildId}`,
              `logId=${record.log.id}`,
              "--api-version",
              "7.1",
              "--only-show-errors",
              "-o",
              "tsv",
              "--query",
              "value",
            ],
          },
  }));
}

function prState(status: PullRequestRecord["status"]): PrState {
  switch (status) {
    case "active":
      return "open";
    case "completed":
      return "merged";
    case "abandoned":
      return "closed";
    default:
      return casesHandled(status);
  }
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function buildUrl(org: string, project: string, buildId: number): string {
  return `${org}/${encodeURIComponent(project)}/_build/results?buildId=${buildId}`;
}

function isBuildPolicy(policy: PolicyEvaluation): boolean {
  return policy.configuration.type.displayName === "Build";
}

function isStatusPolicy(policy: PolicyEvaluation): boolean {
  return policy.configuration.type.displayName === "Status";
}

function isFailedStatus(status: PolicyEvaluation["status"]): boolean {
  return status === "rejected" || status === "broken";
}

function buildName(policy: PolicyEvaluation): string {
  return policy.context?.buildDefinitionName ?? policy.configuration.settings?.displayName ?? "Build validation";
}

function policyToChecks(
  policy: PolicyEvaluation,
  org: string,
  location: PrLocation,
  failedJobsByBuild: ReadonlyMap<number, ReadonlyArray<FailedJob>>,
): ReadonlyArray<Check> {
  if (isBuildPolicy(policy)) return [buildPolicyCheck(policy, org, location, failedJobsByBuild)];
  if (!isStatusPolicy(policy)) return [];
  const settings = policy.configuration.settings;
  const name = [settings?.statusGenre, settings?.statusName].filter((part) => part != null && part !== "").join("/");
  const status: CheckStatus = policy.status === "approved" ? "passed" : isFailedStatus(policy.status) ? "failed" : "pending";
  const label = name === "" ? "Status check" : name;
  return [
    {
      name: label,
      group: "status policy",
      status,
      conclusion: policy.status,
      required: policy.configuration.isBlocking,
      url: null,
      retry: null,
      failedJobs: status === "failed" ? [{ name: label, check: label, url: null, errors: [], log: null }] : [],
    },
  ];
}

function buildPolicyCheck(
  policy: PolicyEvaluation,
  org: string,
  location: PrLocation,
  failedJobsByBuild: ReadonlyMap<number, ReadonlyArray<FailedJob>>,
): Check {
  const buildId = policy.context?.buildId ?? null;
  const blocking = policy.configuration.isBlocking;
  const { status, conclusion } = buildPolicyStatus(policy);
  // An optional build that expired or was never queued says nothing about this branch.
  const awaitingQueue = conclusion === "expired" || conclusion === "not_queued";
  const effective: CheckStatus = awaitingQueue && !blocking ? "skipped" : status;
  return {
    name: buildName(policy),
    group: "build validation",
    status: effective,
    conclusion,
    required: blocking,
    url: buildId === null ? null : buildUrl(org, location.projectName, buildId),
    // Requeueing restarts the whole build, so it is offered only once the build is terminal.
    retry:
      effective === "failed"
        ? {
            key: `azdo_policy:${policy.evaluationId}`,
            ready: true,
            target: { _tag: "azdo_policy", evaluationId: policy.evaluationId },
          }
        : null,
    // Failed tasks are exposed even while the build still runs, for immediate diagnosis.
    failedJobs: effective !== "skipped" && buildId !== null ? (failedJobsByBuild.get(buildId) ?? []) : [],
  };
}

function buildPolicyStatus(policy: PolicyEvaluation): { readonly status: CheckStatus; readonly conclusion: string } {
  switch (policy.status) {
    case "approved":
      return { status: "passed", conclusion: "approved" };
    case "rejected":
    case "broken":
      return { status: "failed", conclusion: policy.status };
    case "running":
      return { status: "pending", conclusion: "running" };
    case "notApplicable":
      return { status: "skipped", conclusion: "notApplicable" };
    case "queued": {
      // `queued` covers both "build is waiting to run" and "build result expired / manual queue
      // only, waiting for someone to queue it". Only the latter needs a requeue.
      if (policy.context?.isExpired === true) return { status: "failed", conclusion: "expired" };
      const manual = policy.configuration.settings?.manualQueueOnly === true;
      if (manual && (policy.context?.buildId ?? null) === null) return { status: "failed", conclusion: "not_queued" };
      return { status: "pending", conclusion: "queued" };
    }
    default:
      return casesHandled(policy.status);
  }
}

function reviewDecision(pr: PullRequestRecord, policies: ReadonlyArray<PolicyEvaluation>): ReviewDecision {
  // Votes: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected.
  if (pr.reviewers.some((reviewer) => reviewer.vote < 0)) return "changes_requested";
  const reviewGates = policies.filter(
    (policy) => policy.configuration.isBlocking && REVIEWER_POLICIES.includes(policy.configuration.type.displayName),
  );
  if (reviewGates.some((policy) => policy.status !== "approved")) return "review_required";
  return pr.reviewers.some((reviewer) => reviewer.vote > 0) ? "approved" : "none";
}

function mergeability(pr: PullRequestRecord, policies: ReadonlyArray<PolicyEvaluation>): Mergeability {
  switch (pr.mergeStatus) {
    case "conflicts":
      return { status: "conflicting", detail: "merge conflicts with the target branch" };
    case "rejectedByPolicy":
      return { status: "blocked", detail: "merge rejected by policy" };
    case "failure":
      return { status: "blocked", detail: pr.mergeFailureMessage ?? "merge failed" };
    case "succeeded": {
      const gates = policies.filter(
        (policy) =>
          policy.configuration.isBlocking &&
          isFailedStatus(policy.status) &&
          !isBuildPolicy(policy) &&
          !isStatusPolicy(policy) &&
          !REVIEWER_POLICIES.includes(policy.configuration.type.displayName) &&
          !COMPLETION_POLICIES.includes(policy.configuration.type.displayName),
      );
      return gates.length === 0
        ? { status: "clean", detail: null }
        : {
            status: "blocked",
            detail: `blocking policies: ${gates.map((gate) => gate.configuration.type.displayName).join(", ")}`,
          };
    }
    case "notSet":
    case "queued":
    case null:
      // The merge preview is still being computed.
      return { status: "unknown", detail: null };
    default:
      return casesHandled(pr.mergeStatus);
  }
}

function threadRef(record: ThreadRecord): ReviewThread | null {
  const status = record.status;
  if (status === null || status === "unknown") return null;
  const participants = new Map<string, ReviewAuthor>();
  for (const comment of textComments(record)) participants.set(comment.author.id, authorOf(comment.author));
  return {
    id: String(record.id),
    resolved: status === "fixed" || status === "wontFix" || status === "closed" || status === "byDesign",
    outdated: false,
    path: record.threadContext?.filePath ?? null,
    line: record.threadContext?.rightFileStart?.line ?? record.threadContext?.leftFileStart?.line ?? null,
    participants: [...participants.values()],
  };
}

function textComments(record: ThreadRecord): ThreadRecord["comments"] {
  return record.comments.filter((comment) => comment.commentType === "text" && !comment.isDeleted);
}

function threadItems(record: ThreadRecord, prUrl: string): ReadonlyArray<ReviewItem> {
  if (record.isDeleted) return [];
  const comments = textComments(record);
  if (comments.length === 0) return [];
  const ref = threadRef(record);
  const filePath = record.threadContext?.filePath ?? null;
  return comments.map((comment) => ({
    id: `azdo:thread:${record.id}:comment:${comment.id}`,
    kind: filePath === null ? "conversation_comment" : "inline_comment",
    author: authorOf(comment.author),
    body: comment.content,
    url: `${prUrl}?discussionId=${record.id}`,
    createdAt: comment.publishedDate,
    verdict: null,
    thread: ref,
  }));
}

function authorOf(author: IdentityRecord): ReviewAuthor {
  const subjectType = author.descriptor?.split(".")[0]?.toLowerCase() ?? "";
  // Only members with access to the project can comment on an Azure DevOps PR, so every person
  // is a collaborator, keyed by sign-in name. Service principals, build services and anything
  // unidentified are bots, keyed by their immutable identity ID (display names are not unique).
  if (!HUMAN_SUBJECT_TYPES.includes(subjectType)) {
    return { login: author.displayName, key: author.id.toLowerCase(), role: "bot" };
  }
  const uniqueName = author.uniqueName ?? "";
  const key = (uniqueName === "" ? author.id : uniqueName).toLowerCase();
  return { login: uniqueName === "" ? author.displayName : uniqueName, key, role: "collaborator" };
}
