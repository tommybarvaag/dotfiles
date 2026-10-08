# Azure DevOps

How the watcher reads Azure DevOps, and the commands for the writes the skill allows. `<org-url>` is the organization URL (`https://dev.azure.com/<org>`); `<n>` is the PR ID. Project and repository IDs for `az devops invoke` come from `az repos pr show --id <n> --org <org-url> --query "{project: repository.project.id, repo: repository.id}"`.

## What the watcher reads

Per poll. Enum values (PR status, merge status, votes, policy status, thread status, comment type, timeline state and result) are parsed strictly: an unknown value fails the snapshot with `ShapeMismatch` instead of being guessed.

- `az repos pr show --id <n>` → `status` (`active`; `completed` = merged; `abandoned` = closed), `isDraft`, `lastMergeSourceCommit.commitId` (the head SHA), `mergeStatus` (`succeeded`, `conflicts`, `rejectedByPolicy`, `failure`, `queued`/`notSet` while the merge preview is computed), and `reviewers[].vote`: 10 approved, 5 approved with suggestions, 0 no vote, -5 waiting for author, -10 rejected. A `completed` or `abandoned` PR stops here: the snapshot is `stop_pr_closed` without any further call.
- `az repos pr policy list --id <n>` → one evaluation per policy with `status` `queued` (waiting to run or waiting for an event), `running`, `approved`, `rejected`, `broken`, `notApplicable`, and `configuration.isBlocking`:
  - `Build` policies are the CI checks. `context.buildId` is the validation build; `context.isExpired` means its result expired and needs a requeue. An expired or never-queued build on an optional policy is reported as skipped.
  - `Status` policies (external services posting PR statuses) are checks that cannot be requeued from here.
  - `Minimum number of reviewers` and `Required reviewers` drive `reviewDecision: review_required`.
  - `Require a merge strategy` reports `rejected` until completion options are set, so it is not treated as a blocker.
  - Any other blocking policy that is `rejected` (`Comment requirements`, `Work item linking`, …) shows up as `mergeability.status: blocked` with its name.
- PR threads: `az devops invoke --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repo-id> pullRequestId=<n> --api-version 7.1`. Only `commentType: text` comments count; `system` comments (votes, pushes, merge attempts) are skipped. Thread `status` `active`/`pending` is unresolved; `fixed`, `wontFix`, `closed`, `byDesign` are resolved. A text comment in a thread without a status has no resolvable thread. A non-null `continuation_token` marks the snapshot incomplete.
- For each build that is running or failed (not approved, not expired): its timeline, `--area build --resource timeline --route-parameters project=<project-id> buildId=<build-id>`. Failed `Task` records (else failed `Job` records) become `failedJobs`, with their `issues` of type `error` and their `log.id`. A running build's failed tasks appear at once while the check stays `pending`; its requeue is offered only once the build is terminal. A timeline that cannot be read marks the snapshot incomplete.

Trust is decided by the author's subject descriptor, not the display name. `aad.` (Entra user) and `msa.` (Microsoft account) are people; only people with access to the project can comment, so each is a collaborator, with `author.key` = their sign-in name (the form `--requester` takes). Everything else (`aadsp.` service principals such as AI review apps, `svc.` build services, `s2s.`, `imp.`, groups, or no descriptor) is a bot with `author.key` = its immutable identity ID, and is surfaced only when that ID is passed with `--review-bot`. Display names are not unique, so they are never matched, and there are no default Azure DevOps bots. To find a bot's ID, run the PR threads command above and read `comments[].author.id` (with `author.descriptor` showing it is not `aad.`/`msa.`) on one of its comments; until allow-listed, its feedback only counts in `review.ignoredUntrusted`.

## Re-read before acting

```sh
az repos pr show --id <n> --org <org-url> --query "{status: status, head: lastMergeSourceCommit.commitId, merge: mergeStatus, draft: isDraft}"
az repos pr policy list --id <n> --org <org-url> --query "[].{policy: configuration.type.displayName, status: status, blocking: configuration.isBlocking}" -o table
```

## Logs

`ci.failedJobs[].log.command` prints one task's log, line by line:

```sh
az devops invoke --org <org-url> --area build --resource logs \
  --route-parameters project=<project-id> buildId=<build-id> logId=<log-id> \
  --api-version 7.1 -o tsv --query value
```

The build page is `ci.failedJobs[].url` (`<org-url>/<project>/_build/results?buildId=<build-id>`).

## Rerun

`--retry-failed-now` requeues each failed or expired build policy: `az repos pr policy queue --id <n> --evaluation-id <evaluation-id> --org <org-url>`. That queues a new validation build of the current merge commit (the whole pipeline, not only failed jobs). Because it always builds the current head, the watcher first re-reads the PR head and the evaluation: if the head is no longer the SHA the retry cycle was charged to, or the build is no longer failed, it skips the requeue and reports `stale_head` / `not_terminal`.

## Review threads

Commands only. Whether you may run them is decided in SKILL.md's Thread writes section, after `--check-thread` for this thread. Write the body to a temp file and pass it with `--in-file`:

```sh
# reply.json: {"content": "[babysit] Added the null check in <sha>.", "parentCommentId": 1, "commentType": 1}
az devops invoke --org <org-url> --area git --resource pullRequestThreadComments \
  --route-parameters project=<project-id> repositoryId=<repo-id> pullRequestId=<n> threadId=<thread.id> \
  --http-method POST --in-file reply.json --api-version 7.1

# status.json: {"status": "fixed"}
az devops invoke --org <org-url> --area git --resource pullRequestThreads \
  --route-parameters project=<project-id> repositoryId=<repo-id> pullRequestId=<n> threadId=<thread.id> \
  --http-method PATCH --in-file status.json --api-version 7.1
```

`thread.id` is the snapshot item's `thread.id`. `parentCommentId` is the comment you answer (the thread's first comment is `1`).

## Sources

- `az devops project list --help`, `az repos pr show --help`, `az repos pr list --help`, `az repos pr policy list --help`, `az repos pr policy queue --help`, `az repos pr reviewer list --help`, `az pipelines runs show --help`, `az devops invoke --help` (azure-cli 2.90.0, azure-devops extension 1.0.3).
- REST 7.1: [Pull Requests – Get Pull Request By Id](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request-by-id?view=azure-devops-rest-7.1) (`PullRequestStatus`, `PullRequestAsyncStatus`, reviewer `vote`), [Policy Evaluations – List](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1) (`PolicyEvaluationStatus`), [Pull Request Threads – List](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list?view=azure-devops-rest-7.1) (`CommentThreadStatus`, `CommentType`), [Pull Request Threads – Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/update?view=azure-devops-rest-7.1), [Pull Request Thread Comments – Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1), [Timeline – Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/timeline/get?view=azure-devops-rest-7.1) (`TaskResult`, `TimelineRecordState`, `TimelineRecord.log`, `issues`), [Graph Users – List](https://learn.microsoft.com/en-us/rest/api/azure/devops/graph/users/list?view=azure-devops-rest-7.1) (subject types `aad`, `msa`, `svc`, `imp`; `svc.` descriptor of a build service).
