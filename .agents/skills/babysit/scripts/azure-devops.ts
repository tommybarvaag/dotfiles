/**
 * Azure DevOps adapter: `az repos pr show`, `az repos pr policy list`, PR threads and build
 * timelines through `az devops invoke`.
 * Parsed into the forge-neutral {@link Observation}. Reruns requeue policy evaluations.
 */
import type { CommandRunner } from "./command-runner.ts";
import {
  array,
  boolean,
  decodeJson,
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
import { NoOpenPullRequest, ThreadNotFound, type ForgeClient, type ForgeError } from "./forge-client.ts";
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
import { casesHandled, err, ok, type Result } from "./result.ts";

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

const identity = object({
  id: string,
  displayName: withDefault(string, ""),
  uniqueName: nullable(string),
  descriptor: nullable(string),
});

const pullRequest = object({
  pullRequestId: number,
  title: withDefault(string, ""),
  status: literal(["active", "abandoned", "completed"]),
  isDraft: withDefault(boolean, false),
  mergeStatus: nullable(literal(["notSet", "queued", "conflicts", "succeeded", "rejectedByPolicy", "failure"])),
  mergeFailureMessage: nullable(string),
  sourceRefName: string,
  targetRefName: string,
  lastMergeSourceCommit: nullable(object({ commitId: string })),
  reviewers: withDefault(array(object({ vote: literal([10, 5, 0, -5, -10]) })), []),
  repository: object({ id: string, name: string, project: object({ id: string, name: string }) }),
});

const policyStatus = literal(["queued", "running", "approved", "rejected", "notApplicable", "broken"]);
const policyEvaluations = array(
  object({
    evaluationId: string,
    status: policyStatus,
    configuration: object({
      isBlocking: boolean,
      isEnabled: boolean,
      type: object({ displayName: string }),
      settings: nullable(
        object({
          displayName: nullable(string),
          statusName: nullable(string),
          statusGenre: nullable(string),
          manualQueueOnly: withDefault(boolean, false),
        }),
      ),
    }),
    context: nullable(
      object({
        buildId: nullable(number),
        buildDefinitionName: nullable(string),
        isExpired: withDefault(boolean, false),
      }),
    ),
  }),
);

const threadStatus = nullable(literal(["unknown", "active", "fixed", "wontFix", "closed", "byDesign", "pending"]));
const thread = object({
  id: number,
  status: threadStatus,
  isDeleted: withDefault(boolean, false),
  threadContext: nullable(
    object({
      filePath: nullable(string),
      rightFileStart: nullable(object({ line: number })),
      leftFileStart: nullable(object({ line: number })),
    }),
  ),
  comments: withDefault(
    array(
      object({
        id: number,
        content: withDefault(string, ""),
        commentType: nullable(literal(["unknown", "text", "codeChange", "system"])),
        isDeleted: withDefault(boolean, false),
        publishedDate: withDefault(string, ""),
        author: identity,
      }),
    ),
    [],
  ),
});
const threads = object({ value: array(thread), continuation_token: nullable(string) });

const timeline = nullable(
  object({
    records: withDefault(
      array(
        object({
          type: withDefault(string, ""),
          name: withDefault(string, ""),
          state: nullable(literal(["pending", "inProgress", "completed"])),
          result: nullable(literal(["succeeded", "succeededWithIssues", "failed", "canceled", "skipped", "abandoned"])),
          log: nullable(object({ id: number })),
          issues: withDefault(array(object({ type: withDefault(string, ""), message: withDefault(string, "") })), []),
        }),
      ),
      [],
    ),
  }),
);

type PullRequestRecord = Decoded<typeof pullRequest>;
type PolicyEvaluation = Decoded<typeof policyEvaluations>[number];
type ThreadRecord = Decoded<typeof thread>;
type IdentityRecord = Decoded<typeof identity>;
type TimelineRecord = NonNullable<Decoded<typeof timeline>>["records"][number];

/** Where the PR lives, as `az repos pr show` reports it. */
type PrLocation = {
  readonly projectId: string;
  readonly projectName: string;
  readonly repositoryId: string;
  readonly webUrl: string;
};

type AzRunner = <T>(args: ReadonlyArray<string>, decoder: Decoder<T>) => Promise<Result<T, ForgeError>>;

/**
 * Create a forge client for one Azure DevOps pull request.
 *
 * @param runner - Runs `az`.
 * @param repo - The repository (organization URL, project, repository).
 * @param number - The pull request ID.
 * @returns A client bound to that pull request.
 */
export function azureDevOpsClient(runner: CommandRunner, repo: AzureRepo, number: PrNumber): ForgeClient {
  const org = repo.organizationUrl;
  const az: AzRunner = async (args, decoder) => {
    const stdout = await runner(["az", ...args, "--org", org, "--only-show-errors", "-o", "json"]);
    return stdout._tag === "err" ? stdout : decodeJson(stdout.value, decoder);
  };
  const showPr = async (): Promise<Result<{ pr: PullRequestRecord; location: PrLocation }, ForgeError>> => {
    const pr = await az(["repos", "pr", "show", "--id", String(number)], pullRequest);
    if (pr._tag === "err") return pr;
    const { repository } = pr.value;
    return ok({
      pr: pr.value,
      location: {
        projectId: repository.project.id,
        projectName: repository.project.name,
        repositoryId: repository.id,
        webUrl: `${org}/${encodeURIComponent(repository.project.name)}/_git/${encodeURIComponent(
          repository.name,
        )}/pullrequest/${number}`,
      },
    });
  };
  const threadRoute = (location: PrLocation) => [
    "--route-parameters",
    `project=${location.projectId}`,
    `repositoryId=${location.repositoryId}`,
    `pullRequestId=${number}`,
  ];

  return {
    target: { repo, number },

    async observe(): Promise<Result<Observation, ForgeError>> {
      const shown = await showPr();
      if (shown._tag === "err") return shown;
      const { pr, location } = shown.value;
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
        return ok({
          forge: "azdo",
          pr: info,
          mergeability: { status: "unknown", detail: null },
          reviewDecision: "none",
          checks: [],
          reviewItems: [],
          viewer: null,
          completeness: { _tag: "incomplete", reasons: ["the pull request is closed; checks and threads were not read"] },
        });
      }

      const [policies, threadList] = await Promise.all([
        az(["repos", "pr", "policy", "list", "--id", String(number)], policyEvaluations),
        az(["devops", "invoke", "--area", "git", "--resource", "pullRequestThreads", ...threadRoute(location), "--api-version", "7.1"], threads),
      ]);
      if (policies._tag === "err") return policies;
      if (threadList._tag === "err") return threadList;

      const gaps: string[] = [];
      if (threadList.value.continuation_token !== null) gaps.push("more PR threads than one page; later threads were not read");
      const enabled = policies.value.filter((policy) => policy.configuration.isEnabled && policy.status !== "notApplicable");
      const failedJobsByBuild = await failedJobsForBuilds(
        az,
        location,
        org,
        enabled.flatMap((policy) => {
          const buildId = policy.context?.buildId ?? null;
          // A running or failed build may already show failed tasks. Approved builds have none,
          // and an expired result belongs to an older build, not this commit.
          const current = policy.status !== "approved" && policy.context?.isExpired !== true;
          return isBuildPolicy(policy) && buildId !== null && current ? [{ buildId, name: buildName(policy) }] : [];
        }),
        gaps,
      );

      return ok({
        forge: "azdo",
        pr: info,
        mergeability: mergeability(pr, enabled),
        reviewDecision: reviewDecision(pr, enabled),
        checks: enabled.flatMap((policy) => policyToChecks(policy, org, location, failedJobsByBuild)),
        reviewItems: threadList.value.value.flatMap((record) => threadItems(record, location.webUrl)),
        viewer: null,
        completeness: gaps.length === 0 ? { _tag: "complete" } : { _tag: "incomplete", reasons: gaps },
      });
    },

    async readThread(threadId) {
      const id = Number(threadId);
      if (!Number.isSafeInteger(id) || id <= 0) return err(new ThreadNotFound(threadId));
      const shown = await showPr();
      if (shown._tag === "err") return shown;
      const record = await az(
          [
            "devops",
            "invoke",
            "--area",
            "git",
            "--resource",
            "pullRequestThreads",
            ...threadRoute(shown.value.location),
            `threadId=${id}`,
            "--api-version",
            "7.1",
          ],
          thread,
        );
      if (record._tag === "err") return record;
      const ref = record.value.isDeleted ? null : threadRef(record.value);
      if (ref === null) return err(new ThreadNotFound(threadId));
      const completeness: Completeness = { _tag: "complete" };
      return ok({ thread: ref, completeness });
    },

    async rerun(target, headSha) {
      if (target._tag !== "azdo_policy") return err(new ShapeMismatch("$.target", "an Azure DevOps policy target"));
      // `policy queue` builds whatever the PR head is now, not the commit the retry was charged
      // to. Re-check both right before queueing; the remaining check-then-act window (a push in
      // the next instant) is accepted: the new build then simply validates the newer commit.
      const shown = await showPr();
      if (shown._tag === "err") return shown;
      const currentHead = shown.value.pr.lastMergeSourceCommit?.commitId ?? "unknown";
      if (currentHead !== headSha) return ok({ _tag: "stale_head", currentHead });
      const policies = await az(["repos", "pr", "policy", "list", "--id", String(number)], policyEvaluations);
      if (policies._tag === "err") return policies;
      const evaluation = policies.value.find((policy) => policy.evaluationId === target.evaluationId);
      const status = evaluation === undefined ? "missing" : buildPolicyStatus(evaluation).status;
      if (status !== "failed") return ok({ _tag: "not_terminal", status });
      const queued = await runner([
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
      return queued._tag === "err"
        ? queued
        : ok({ _tag: "triggered", detail: `az repos pr policy queue --id ${number} --evaluation-id ${target.evaluationId}` });
    },
  };
}

/**
 * Find the single active pull request whose source branch is `branch`.
 *
 * @param runner - Runs `az`.
 * @param repo - The repository from the git remote.
 * @param branch - The checked-out branch name.
 * @returns The pull request target, or `NoOpenPullRequest` for zero or several matches.
 */
export async function findAzurePrForBranch(
  runner: CommandRunner,
  repo: AzureRepo,
  branch: string,
): Promise<Result<PrTarget, ForgeError | NoOpenPullRequest>> {
  const stdout = await runner([
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
  if (stdout._tag === "err") return stdout;
  const decoded = decodeJson(stdout.value, array(object({ pullRequestId: number })));
  if (decoded._tag === "err") return decoded;
  const [only, ...rest] = decoded.value;
  const prNumber = only === undefined ? null : parsePrNumber(only.pullRequestId);
  if (prNumber === null || rest.length > 0) return err(new NoOpenPullRequest(branch, decoded.value.length));
  return ok({ repo, number: prNumber });
}

async function failedJobsForBuilds(
  az: AzRunner,
  location: PrLocation,
  org: string,
  builds: ReadonlyArray<{ readonly buildId: number; readonly name: string }>,
  gaps: string[],
): Promise<ReadonlyMap<number, ReadonlyArray<FailedJob>>> {
  const entries = await Promise.all(
    builds.map(async ({ buildId, name }) => {
      const records = await az(
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
        timeline,
      );
      if (records._tag === "err") {
        gaps.push(`could not read the timeline of build ${buildId}: ${records.error.message}`);
        return [buildId, []] as const;
      }
      return [buildId, timelineFailures(records.value?.records ?? [], buildId, name, location, org)] as const;
    }),
  );
  return new Map(entries);
}

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
