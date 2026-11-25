# CI failure classification

Read the failed job's log before you classify: run `ci.failedJobs[].log.command` from the snapshot (or open `url` when `log` is `null`). Classify each failed job on its own; one run can hold both kinds.

## Branch-related: patch it

The log points at code this PR touches:

- compile, type-check, or lint errors in changed files or their direct dependents;
- a test failing on an assertion about behaviour the PR changed, or a test the PR added;
- snapshot / golden-file diffs caused by the PR's output change;
- static analysis or quality gates (SonarQube, CodeQL) flagging new code in the diff;
- a lockfile or generated file the PR should have updated.

Confirm by reproducing locally when the repo makes that cheap (the failing test file, the linter on the changed file). A fix that passes locally and matches the log is ready to commit.

## Flaky or unrelated: retry it

The log points at the environment, not the diff:

- timeouts, runner or agent lost, `The operation was canceled`, out of disk;
- network, registry, package feed, or container pull failures (`ECONNRESET`, 429, 502/503);
- forge infrastructure errors (Actions service incidents, Azure Pipelines agent provisioning);
- a test failing in a file the PR does not touch, that passes on the base branch or on a rerun;
- a cancellation caused by a newer run (the watcher already hides superseded GitHub runs).

Retry only through `--retry-failed-now`, and only when the snapshot offers `retry_failed_checks`. Leave tests, CI config, dependency pins, and infrastructure code as they are: changing them to get a flake green is out of scope unless the log ties the failure to this branch.

## Ambiguous

Spend one manual diagnosis attempt: read the full log around the first error, compare with the base branch's latest run of the same job, and check whether the failing code is in the diff. Then classify. Still unclear → treat as flaky once (retry if offered); if it fails the same way after the retry, treat it as a blocker and ask the user.

## When the budget is spent

`ci.retries.exhausted: true` with a failure you classified as flaky is a blocker: report the job, the log evidence, and the retry cycles used, and stop.

## Signals specific to a forge

- GitHub: a job can fail while its workflow run is still going; the snapshot already lists it in `failedJobs`, so diagnose it immediately. The rerun waits for the run to finish (`retry.ready`).
- Azure DevOps: a running build's failed tasks are already in `failedJobs` while the check is still `pending`; diagnose them immediately. The requeue is offered once the build is terminal. A `conclusion` of `expired` or `not_queued` on a required build means the validation result is stale or was never queued; it needs a requeue, not a code change.
