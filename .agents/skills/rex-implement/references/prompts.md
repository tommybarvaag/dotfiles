# Prompts

## Ticket

`PR<n>-T<t>.md` in the run directory, numbered per [SKILL.md](../SKILL.md) step 5.7, holds, in this order:

- the worktree path, the branch and what it stacks on;
- the absolute report path `<run-dir>/PR<n>-T<t>-report.md`;
- the skills to load before writing code, with the `SKILL.md` path of each user-invoked one, since the executor can load only model-invoked skills by name;
- **why**: the concern, in two or three sentences, and the logged decisions that apply;
- **steps**, each ending on a checkable completion condition. Where behaviour changes, the first step writes the test that proves it and records it failing for the stated reason;
- **scope**: the files and concerns in, and those out;
- a **size check**: the expected diff, and a request to explain any overrun;
- **STOP conditions**: the observations that mean the plan is wrong, such as a public API change nobody decided on, or an inventory much larger than planned;
- the verify block, with its known reds;
- the executor contract below, copied verbatim.

A fix ticket, `T2` or later, keeps the worktree and branch, the report path pattern, the skills, the verify block and the contract. Its steps are the accepted findings, each with its id, severity, the roles that raised it, file:line, evidence, fix and a pointer to its `PR<n>-R<k>.md`, or the vet's red checks and drift. A deferral the repo records gets its own step, which writes it to the place the user chose.

## Executor contract

- Read the repo's agent instructions, such as `AGENTS.md` or `CLAUDE.md`, first, and hold every changed line to them. Load each skill the ticket names before you write code.
- Work in the worktree the ticket names, with absolute paths, and run git as `git -C <worktree>`.
- Follow the ticket's steps in order and meet each step's completion condition. Where a step names a test to write first, watch it fail for the stated reason before implementing.
- Check each factual claim in the ticket against the live code, and report every mismatch as drift.
- When a STOP condition fires, stop and write the report with the reason and what you observed.
- Run heavy commands under the **throttle**: a full test suite, a build, a gate or a benchmark runs one at a time across every agent on the machine, starts only while the 1-minute load average in `uptime` is under 8, and runs under `nice -n 15`, with Vitest at `--maxWorkers=4` and turbo at `--concurrency=2`.
- Write every `.md` file you touch with `/writing-for-agents`, and apply the rules in `~/.claude/skills/unslop/SKILL.md` to it and to every code comment you write.
- When the worktree holds changes for more than one PR, keep `<run-dir>/layers.json` current: it maps each changed file to its PR, and a file two PRs share gets a note saying which hunk belongs to which.
- Leave branches and commits to the orchestrator. Your only writes outside the worktree are the report and `layers.json`.
- Put each question the code can't settle in the report as an open question. The orchestrator answers it in the next ticket.
- Review your own diff against the repo's instructions and the ticket's scope, and fix what you find.
- Leave every change uncommitted. Write the report last, after every command has finished, with no placeholders: changed files, each command with pass or fail, deliberate decisions a reviewer might question, drift, deviations or STOPs with reasons, and open questions. Reply with the report path only.

## Review brief

Every reviewer of a round reads the same brief, `<run-dir>/PR<n>-R<k>-brief.md`:

```
# Review brief, PR<n> round <k>

Run your pass skill. If it did not load from your prompt, read and follow its SKILL.md:
- bugs: <absolute thermo-nuclear-review SKILL.md path>, for bugs, breakage, security and regressions.
- quality: <absolute thermo-nuclear-code-quality-review SKILL.md path>, for maintainability, structure and abstractions.
- simplify: /simplify, for reuse, simplification and efficiency. Report findings only.

## Where
- Worktree: <path>
- Branch <branch>, stacked on <branch below, or origin/<base>> at <sha>.
- Review target: every uncommitted change, which is `git diff HEAD` plus the untracked files that `git status --short` lists. <Paths to ignore, if any.>
- PR metadata: <none yet, or pasted here>.

## What the change is
<The change in a few lines per PR. When the worktree holds more than one PR, <run-dir>/layers.json maps each file to its PR.>

## Decisions made on purpose
Challenge these only with evidence:
- <the executor's deliberate decisions from its report, and the logged decisions that shape the change>
Already decided, not to re-raise: <rejected findings with their reasons, deferred items>.

## Known red
<Checks that fail the same way on the base, with how that was confirmed, or none.>

## References
- Repo rules: <AGENTS.md, CONTRIBUTING.md and the rules that matter most here>
- <Dependency sources, docs or specs the change relies on, with paths>

## Rules
- Read-only. Leave every file as it is, and run no builds or test suites, because other agents share the machine. Reading files and git diff, log, show and status are fine.
- Trace each issue end to end before you report it. Report only issues in added or modified code.

## Output
Your final message is the report. Number each finding, most severe first, and give for each:
- severity: blocking, should-fix or nit
- PR: <n>, when this brief covers more than one
- file:line
- the problem
- a concrete failure scenario
- the fix you suggest

With no findings, write NO FINDINGS. End with a line that reads exactly END-OF-FINDINGS.
```

Round k+1's brief is round k's with its own title and this section after "Known red":

```
## Round <k> result and fix
<Each accepted finding with the roles that raised it and how the fix resolved it, and each rejected finding with its reason.>
Check each fix, then review the whole change again with fresh eyes. Raise an earlier finding again only if its fix is wrong.
```
