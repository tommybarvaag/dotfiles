# Prompts

## Review prompt

Write it to `<run-dir>/P<k>-review.md`. The dispatch text is `You are role <role>. Read and follow <absolute path>.`, typed after the pass skill for a Claude Code reviewer ([herdr-ops.md](herdr-ops.md#pass-skills)).

```
# Review, iteration <k>

Run your pass skill:
- bugs: /thermo-nuclear-review (bugs, breakages, security, regressions)
- quality: /thermo-nuclear-code-quality-review (maintainability, structure, abstractions)
- simplify: /simplify (reuse, simplification, efficiency), findings only

Worktree: <path>, branch <branch>, base origin/<base> at <sha>.
Scope: <iteration 1: git diff origin/<base>...HEAD plus uncommitted and untracked files | later: the files and findings of T<k-1>, and whether each earlier finding is resolved>.
Owner intent: <plan or PR description, pasted or by path>.
Existing PR review comments: <pasted, or none>.
Already decided, not to re-raise: <rejected and deferred items, owner decisions>.

Reply in chat with one findings list, then the line END-OF-FINDINGS:

### F<n> <short title>
- file: <path>:<line>
- severity: blocking | should-fix | nit
- pass: <your role>
- evidence: <why it is wrong, with the concrete scenario>
- fix: <concrete change>

Most severe first. Nothing found: "No findings.", then END-OF-FINDINGS.

You are a read-only reviewer. Read with git diff, git show and file reads, and leave every file as it is. The orchestrator runs the verify block.
```

## Ticket

`T<k>.md` in the run directory holds:

- worktree path, branch, and the audit path `A<k>.md`;
- each accepted finding: id, severity, roles that raised it, file:line, evidence, fix;
- deferred items, marked "do not act";
- red verify output, if any;
- the verify block;
- the absolute report path `<run-dir>/T<k>-report.md`;
- the executor contract below, verbatim.

## Executor contract

- Read the repo's agent instructions (`AGENTS.md`, `CLAUDE.md` or equivalent) first, and hold every changed line to them.
- The ticket is the spec. Fix exactly its findings, and run its verify block until every command is green.
- Check each finding's file:line against the live code, and report every mismatch as drift.
- Leave every change uncommitted and create no branches. Your one write outside the worktree is the report.
- Write the report last, after every command has finished, with no placeholders. It lists changed files, each command with pass or fail, drift, and open questions. Reply with the report path only.
