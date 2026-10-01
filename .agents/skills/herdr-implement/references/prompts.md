# Prompts

## Ticket

`PR<n>-T<k>.md` in the run directory holds, in this order:

- the worktree path, the branch and what it stacks on;
- the absolute report path `<run-dir>/PR<n>-T<k>-report.md`;
- **why**: the concern, in two or three sentences, and the logged decisions that apply;
- **steps**, each ending on a checkable completion condition. Where behaviour changes, the first step writes the test that proves it and records it failing for the stated reason;
- **scope**: the files and concerns in, and those out;
- a **size check**: the expected diff, and a request to explain any overrun;
- **STOP conditions**: the observations that mean the plan is wrong, such as a public API change nobody decided on, or an inventory much larger than planned;
- the verify block;
- the executor contract below, copied verbatim.

A fix ticket (`T2`, `T3`, …) keeps the worktree and branch, the report path, the verify block and the contract. Its steps are the accepted findings and deferrals, each with its review id and a pointer to its `PR<n>-R<k>.md` or `PR<n>-A<k>.md`, or the vet's red checks and drift.

## Executor contract

- Read the repo's agent instructions (`AGENTS.md`, `CLAUDE.md` or equivalent) first, and hold every changed line to them.
- Follow the ticket's steps in order and meet each step's completion condition. Where a step names a test to write first, watch it fail for the stated reason before implementing.
- Check each factual claim in the ticket against the live code, and report every mismatch as drift.
- When a STOP condition fires, stop and write the report with the reason and what you observed.
- Leave branches and commits to the orchestrator. Your one write outside the worktree is the report.
- Review your own diff against the repo's instructions and the ticket's scope, and fix what you find.
- Leave every change uncommitted. Write the report last, after every command has finished, with no placeholders: changed files, each command with pass or fail, drift, deviations or STOPs with reasons, and open questions. Reply with the report path only.

## Review prompt

Write it to the round's prompt file: `PR<n>-R<k>-prompt.md` for the reviewer, `PR<n>-A<k>-prompt.md` for the final gate.

```
Use read-only commands only (git diff, git show, reading files); the orchestrator already ran the verify block.
Run /thermo-nuclear-code-quality-review on the uncommitted diff, untracked files included, in <worktree> (branch <branch> against <base sha>).
Check every changed line against the repo's agent instructions.
Scope: <round 1: the whole diff | later: the files the fix ticket touched, and whether each earlier finding is resolved>.
Context: ticket <path>, executor report <path>, earlier reviews <paths>.
Already decided, not to re-raise: <logged decisions, rejected findings>.
Leave every file as it is. Reply with a numbered list of findings, most severe first, each with file:line, a severity (blocking, should-fix or nit), the problem and a concrete fix, and state for each earlier finding whether it is resolved. End with the line END-OF-FINDINGS.
```
