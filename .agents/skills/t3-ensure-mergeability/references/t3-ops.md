# T3 operations

T3's tool descriptions are the authority for parameters. This file holds the behaviour the run depends on that those descriptions leave out.

## Wakes

- A wake carries each finished child's final message, up to about 16 KB across the whole wake. A result past that budget is replaced by a pointer: read it with `task_status`.
- Children that finish close together share one wake. One that finishes while a wake is already running arrives in the next wake. Count the reports in, not the wakes.
- A cancelled child sends no wake.
- A child's question wakes you, but a child's approval request never does. While children are outstanding, a user message asking about progress is the moment to call `task_status` on each one, which shows a `pendingApproval`.

## Idempotency

A `clientRequestId` names one unit of work. Repeating the call with the same key returns the same task, so a response lost to a crash or compaction is safe to retry. Starting the work over takes a new key: `<run>-r<k>-<role>-retry<n>`.

## Child questions

Read a child's question with `t3_pending_request` (`list`, then `read`, with its `threadId`). Answer it with `respond` when the brief, run spec or ledger settles it. Otherwise it is a decision. An approval is the user's: name the child that is waiting and what it waits on.

## Follow-ups

`t3_thread_send` to a finished child starts a new task in that child's thread, with its history, and returns a new `taskId`. Its completion wakes you like any other task. Log the new `taskId`.

It serves the executor's vetting loop. A re-check of findings is always the next round's new reviewer, so every judgment comes from a fresh context.

## Cancelling

`task_cancel` stops a child and everything it started. Cancel a child you are replacing, one that hangs, and every running child when the user says to stop or ship. After cancelling the executor, check that the checkout is clean at the last round commit before going on.

## CI

`watch_pull_request` wakes you on a failed check, on passed required checks, on new comments or reviews, or on a conflict. A wake is an event, not a merge decision.
- A failed check, or a comment that shows a defect, becomes a finding. Fixing it is a ticket and a commit. The fix gets a review round when rounds remain, and is a decision otherwise.
- A conflict sends the run back to step 6's rebase.
- Passed required checks end the wait.

The watch stays armed across wakes. `unwatch_pull_request` it before the report.
