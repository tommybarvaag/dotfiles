---
name: babysit
description: Babysit a GitHub or Azure DevOps pull request until it merges or closes, fixing branch-caused CI failures, retrying flakes, and handling review feedback. Use when asked to babysit, watch, or monitor a PR.
---

# Babysit a pull request

You own the PR until a **strict stop**. A watcher script snapshots the PR, its CI, and its review feedback as JSON and tells you what to do next; you act on each snapshot and keep the watcher running.

`$SKILL` below is the directory holding this file (installed at `~/.agents/skills/babysit`). The watcher needs Node 24+, its pinned npm dependencies (Preflight step 1), and a logged-in `gh` (GitHub) or `az` with the `azure-devops` extension (Azure DevOps). It detects the forge from the PR URL or the `origin` remote.

```sh
node $SKILL/scripts/babysit.ts --pr auto --watch --requester <confirmed>   # follow the PR; one JSON snapshot per line
node $SKILL/scripts/babysit.ts --pr <number|url> --once       # one snapshot
node $SKILL/scripts/babysit.ts --pr <number|url> --retry-failed-now
node $SKILL/scripts/babysit.ts --pr <number|url> --check-thread <thread.id>   # fresh check before a thread write
```

`--pr auto` (the default) is the open PR of the current branch. Everything else is in `--help`.

References, each read only on its branch:
- [github.md](references/github.md) or [azure-devops.md](references/azure-devops.md): the PR's forge. Read it before your first write (push, rerun, reply, resolve) for the commands; what you may write is decided here, in [Thread writes](#thread-writes).
- [heuristics.md](references/heuristics.md): before classifying any CI failure.
- [harnesses.md](references/harnesses.md): how to keep reading `--watch` output in Claude Code, Codex, or T3 Code.

## Strict stops

Stop only when:

1. the PR is **merged or closed** (`stop_pr_closed`); or
2. a **blocker** needs the user: merge conflicts (`stop_merge_conflict`), a flaky failure with the retry budget spent (`ci.retries.exhausted`), an infrastructure outage, a permission or auth error, the watcher exiting after repeated errors, a `LockNeedsRecovery` error (show the user the file it names; they remove it once no babysit process is running), an unclear reviewer request, or a review reply that needs the user's confirmed wording.

Everything else is a reason to keep watching: CI pending, an `idle` snapshot, a push you just made, review approval still required, mergeability `unknown`, and the **milestone** (green, mergeable, review-clean). The milestone is progress worth reporting, not a stop: late review comments still need you while the PR is open. Mergeability `behind` or `blocked` is reported once and watched; updating the branch or satisfying a policy is the user's call.

## 1. Preflight

1. Install the watcher's runtime dependencies once: if `$SKILL/scripts/node_modules` is missing, run `npm ci --omit=dev --prefix "$SKILL/scripts"`. Without network access, see [harnesses.md](references/harnesses.md). Only to change the scripts themselves: a full `npm ci --prefix "$SKILL/scripts"` adds the dev tooling for `npm test` and `npm run typecheck`.
2. Confirm the forge CLI can read the target: `gh auth status` for GitHub; for Azure DevOps, `az devops project list --org <org-url> --top 1 -o none`, which works for `az login`, `az devops login`, and `AZURE_DEVOPS_EXT_PAT` alike.
3. Confirm the **requester**, the person you babysit for, once per session in one question. Suggest the identity the CLI reports (`gh api user --jq .login`; for Azure DevOps `az account show --query user.name -o tsv`, the sign-in name) and ask the user to confirm or correct it. Pass the answer as `--requester` on every watcher command. The CLI's account is only a suggestion: if the user declines to answer, run without `--requester`, and every human thread write goes through the user.
4. Check the working tree. Unrelated uncommitted changes are a blocker: ask the user before touching anything. Work happens on the PR's head branch only.
5. Read the forge reference for this PR.

Done when the dependencies are installed, the CLI is authenticated, the requester is confirmed (or declined), the tree is clean or the user has cleared it, and you know the forge.

## 2. Watch

Start `--watch` for the PR, following [harnesses.md](references/harnesses.md). Keep exactly one watcher per PR: a second one exits with `WatcherAlreadyRunning`, which means reuse the running one. The watcher polls every 60 seconds and prints a snapshot when something changed, plus a heartbeat every ten quiet polls. Use `--once` only for a one-off check or when your harness cannot follow a stream. While the watcher runs, babysitting is in progress: keep reading it, without asking whether to continue, instead of ending your turn.

Done when the watcher is running and you are reading its snapshots.

## 3. Act on each snapshot

Handle `actions` in the order listed; the watcher already puts review feedback before CI and retries. Before any write, re-read the live PR state with the forge CLI rather than trusting an older snapshot. A snapshot with `completeness._tag: "incomplete"` never celebrates or reaches the milestone; if its `reasons` persist across polls, tell the user.

| Action | Do |
| --- | --- |
| `stop_pr_closed` | Report the final summary and stop the watcher. |
| `stop_merge_conflict` | Blocker: report the conflict and stop. |
| `process_review_comment` | Handle each item in `review.newItems` (below). |
| `diagnose_ci_failure` | Read each `ci.failedJobs[].log.command` output, classify per [heuristics.md](references/heuristics.md), and patch only failures this branch caused. Diagnose a failed job immediately even while the rest of the run is pending. |
| `retry_failed_checks` | For failures you classified as flaky: `--retry-failed-now`. Skip it when you are about to push a fix, since the new commit reruns CI anyway. It spends one retry cycle before rerunning and lists each rerun as `triggered`, `failed`, or skipped (`stale_head` / `not_terminal`: the PR moved on, and the next snapshot decides again); a failed rerun is reported, not retried. |
| `celebrate_ci_green` | Post once: `🚀 CI is all green! <passed>/<total> passed. Still on watch for <what remains>.` |
| `ready_to_merge` | Report the milestone once per head SHA and keep watching. Merging is the user's call. |
| `idle` | Nothing to do; keep watching. |

After a push or a rerun, keep the watcher going on the new SHA. If you stopped it to work, restart `--watch` in the same turn, right after the push.

Done when every action in the snapshot is handled and the watcher is running again, or a strict stop is reached.

### Review feedback

`review.newItems` holds only published, unresolved feedback from trusted authors: the requester, repository collaborators, and allow-listed review bots (`--review-bot`, matched against `author.key`). Each item appears once, and the first snapshot includes feedback that was already open.

- **Actionable and correct**: patch, commit, push, then resolve the thread if [Thread writes](#thread-writes) allows it.
- **Disagree, already addressed, a question, or needs a written answer**: report the item to the user with a suggested reply.
- Your own `[babysit]` replies are filtered out of later snapshots. An item in a resolved thread never reaches you; a new reply in it arrives as a new item.

### Thread writes

This section is the only policy for replying to and resolving review threads; the forge references only give the commands.

1. Each item's `threadWrite` is a first filter: `eligible` only when the observation was complete and every thread participant is either the confirmed requester or an allow-listed bot. Without `--requester`, no thread with a human in it is eligible.
2. Immediately before replying or resolving, run the fresh, complete check: `node $SKILL/scripts/babysit.ts --pr <pr> --check-thread <thread.id>`. It reads every comment of that one thread.
3. With `threadWrite._tag: "eligible"`: you may resolve the thread, with a reply prefixed `[babysit] ` naming the change and the commit.
4. With `ineligible` (another human joined, no requester confirmed, incomplete read, already resolved): write nothing yourself. Report the item and its `reason` to the user, and post only the exact text they confirm, prefixed `[babysit] `.

Beyond thread writes, you may push commits to the PR's head branch and rerun checks through `--retry-failed-now`. Everything else visible to other people waits for the user's explicit request: any other comment, approving or voting, draft/ready changes, closing, reopening, abandoning, merging, or completing. Leave no doubt about whether you or the user did something.

### Git safety

- Work on the PR's head branch; switch branches only to recover context.
- Use non-destructive git: new commits and plain `git push`. Force pushes, resets, rebases of pushed history, and branch deletion wait for the user's explicit yes.
- Commit through the `git-commit` skill when the harness has it; otherwise write a Conventional Commit: `fix(ci): <what> (#<n>)` for CI fixes, `fix: address review feedback (#<n>)` for review fixes.

## 4. Report

While watching, report changes only: pushes, reruns, new review items, CI turning green or red, the milestone, and a short heartbeat during long quiet stretches. These are progress updates, not the end.

At a strict stop, give the final summary:

- final PR head SHA;
- CI status summary;
- mergeability and conflict status;
- fixes pushed;
- flaky retry cycles used;
- remaining unresolved failures and review comments, and for a blocker, what you need from the user.
