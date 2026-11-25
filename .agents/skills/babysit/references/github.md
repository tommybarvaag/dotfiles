# GitHub

How the watcher reads GitHub, and the commands for the writes the skill allows. `<owner>/<repo>` and `<n>` come from the snapshot's `pr.url`.

## What the watcher reads

GraphQL through `gh api graphql`. A merged or closed PR is reported from the first page alone. For an open PR, every connection's cursor is followed to the end (checks, review threads, reviews and conversation comments concurrently, then extra thread-comment pages four threads at a time), before any state lock is taken. Enum values are parsed strictly: a value GitHub adds later fails the snapshot with `ShapeMismatch` rather than being guessed. If the head commit moves between pages, or a connection runs past 50 pages, the snapshot says `completeness: incomplete` with the reasons. It covers:

- `state` (`OPEN`/`CLOSED`/`MERGED`), `isDraft`, `headRefOid`.
- `mergeable` (`MERGEABLE`/`CONFLICTING`/`UNKNOWN`) and `mergeStateStatus` (`CLEAN`, `UNSTABLE` = mergeable with non-passing checks, `HAS_HOOKS`, `BLOCKED`, `BEHIND` = head out of date, `DIRTY` = merge commit cannot be created, `DRAFT`, `UNKNOWN`). `DRAFT` (deprecated in the schema in favour of `isDraft`, but still listed with `includeDeprecated`) is reported as `blocked` with detail "the pull request is a draft" and watched. `UNKNOWN` is normal right after a push while GitHub computes the merge; keep watching.
- `reviewDecision` (`APPROVED`/`CHANGES_REQUESTED`/`REVIEW_REQUIRED`, or null when no review is required).
- The head commit's `statusCheckRollup`: check runs (Actions jobs and other apps) and commit statuses. A rerun or a concurrency cancellation leaves several check runs for one job on the same commit; the watcher collapses only provable re-runs: an Actions job with the same app, workflow ID, triggering event and name, or a check of another app re-requested inside the same check suite. A `push` and a `pull_request` run of one workflow, or two suites of one app, all count separately.
- `reviewThreads` (`isResolved`, `isOutdated`, comments), `reviews`, and PR conversation `comments`, each with `authorAssociation`.

Review items the watcher hides:

- reviews in state `PENDING` and inline comments attached to them: unsubmitted, visible only to their author. They surface once submitted;
- `DISMISSED` reviews, and `COMMENTED` / `APPROVED` reviews with an empty body (envelopes for inline comments, or a bare approval already reflected in `reviewDecision`);
- comments in resolved threads;
- authors that are not the `--requester`, not `OWNER`/`MEMBER`/`COLLABORATOR`, and not an allow-listed bot (`--review-bot`, by login; defaults in `--help`). These count in `review.ignoredUntrusted`. The authenticated `viewer` gets no trust of its own; it only marks the agent's `[babysit]` replies.

## Re-read before acting

```sh
gh pr view <n> -R <owner>/<repo> --json state,headRefOid,mergeable,mergeStateStatus,reviewDecision
```

## Logs

- `ci.failedJobs[].log.command` is `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<job-id>/logs`: the job's full plain-text log, served as soon as that job finishes, even while the rest of its run is still going. The endpoint redirects to a log URL that expires after a minute; `gh` follows it. Without `--allow-escape-sequences`, `gh` refuses logs that contain ANSI colour codes.
- `gh run view --job <job-id> --log-failed` and `gh run view <run-id> --log-failed` print only failed steps, but `gh` rejects them until the whole run has completed; use them after the run ends.

## Rerun

`--retry-failed-now` runs `gh run rerun <run-id> --failed -R <owner>/<repo>` once per workflow run with a failed job. GitHub reruns failed jobs and their dependents, and only for a completed run, which is why a failed job in a still-running workflow is diagnosed but not yet offered for retry. Checks from other apps and commit statuses cannot be rerun from here.

## Review threads

Commands only. Whether you may run them is decided in SKILL.md's Thread writes section, after `--check-thread` for this thread.

```sh
gh api graphql -f query='mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }' \
  -f id=<thread.id> -f body='[babysit] Added the TTL in <sha>.'

gh api graphql -f query='mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' -f id=<thread.id>
```

`thread.id` is the snapshot item's `thread.id` (a `PRRT_…` node ID). Conversation comments and review bodies have no thread; the command for answering them is `gh pr comment <n> -R <owner>/<repo> --body '[babysit] …'`.

## Sources

- `gh pr view --help`, `gh pr checks --help`, `gh run view --help`, `gh run rerun --help`, `gh api --help` (gh 2.102.0); `--log-failed` waiting for run completion: [gh v2.102.0 `pkg/cmd/run/view/view.go` L313–L320](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/run/view/view.go#L313-L320).
- GraphQL schema via introspection (`__type`): `App`, `Workflow`, `WorkflowRun` (stable `databaseId`, `event`), `MergeableState`, `MergeStateStatus`, `PullRequestReviewDecision`, `PullRequestReviewState`, `CommentAuthorAssociation`, `CheckConclusionState`, `CheckStatusState`, `StatusState`, `ResolveReviewThreadInput`, `AddPullRequestReviewThreadReplyInput`.
- REST: [Download job logs for a workflow run](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run), [Re-run failed jobs from a workflow run](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run).
