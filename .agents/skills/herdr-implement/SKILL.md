---
name: herdr-implement
description: Implement a goal, spec or markdown plan with a Herdr team of executors, a reviewer and a final-gate reviewer, ending in reviewed PRs.
disable-model-invocation: true
---

# Herdr: implement

You are the **orchestrator**. You turn the input into logical PRs, write a **ticket** per change, and hand it to an **executor**. You vet every diff yourself, run each PR through the **reviewer** and then the **final gate**, and commit and open the PRs. You write only the run docs, tickets, verdicts, commits and PR text. Every line of code comes from an executor.

The input is the argument: a goal sentence, a spec, a markdown plan, a ticket or an issue link. Read all of it before planning.

References:
- [roles.md](references/roles.md): the three roles, choosing models and effort, start commands.
- [herdr-ops.md](references/herdr-ops.md): addressing agents, fresh context, pass skills, dispatch, wait, read, blocked agents.
- [prompts.md](references/prompts.md): ticket, executor contract, review prompt.

## Decisions and the AFK rule

Every question for the user goes through `AskUserQuestion`, up to four questions per call. Put the recommended option first, labelled "(Recommended)".

A recommendation is **grounded**: before you mark an option recommended, research it in the code, the repo's instructions, the tool's `--help`, its docs, or the run evidence in [roles.md](references/roles.md#choosing-models-and-effort). The option's description names that evidence in one clause, for example "matches the 3 existing callers in `src/x.ts`". An option you could not ground is offered without the label.

If a question goes unanswered for 10 minutes, the user is AFK:
- take the recommended option; a question without one waits for the user;
- log it in `DECISIONS.md` as `auto-decided (AFK)`, with the evidence;
- keep working.

The rule holds in every phase: planning, execution, fixing and review. When the user says they are gone for the session, decide the recommended option at once. Force-pushes, merges, closing PRs and deleting branches or worktrees always wait for an explicit yes.

An executor may ask the user in its own pane. Before you accept a report's claim of user approval, find the answer in that agent's transcript.

## 1. Preflight

1. Before the first `herdr` command, read the guide for the installed Herdr: run the command that the note for agents in `herdr --help` gives for controlling Herdr (at the time of writing, `herdr --skill`). This skill is not that guide, and an installed copy of the guide can lag the binary.
2. Confirm your own dependencies: `AskUserQuestion` (this skill runs in Claude Code), `/show-me`, `/git-commit` and `/git-pr-summary`. Ask the user about any that is missing.
3. Create the run directory in the OS temp directory, outside the repo: `mktemp -d "${TMPDIR:-/tmp}/herdr-implement.XXXXXX"`. It holds `RUN-LOG.md` (PR plan, lanes, agents, verdicts), `DECISIONS.md` (every user decision with its evidence), and every ticket, prompt, report and review, each addressed by absolute path.

Done when the Herdr guide is read, every dependency is confirmed, and the run directory holds `RUN-LOG.md` and `DECISIONS.md`.

## 2. Understand

1. Read the input, the repo's agent instructions (`AGENTS.md`, `CLAUDE.md` or equivalent) and every file the input names.
2. Research the code the input touches until you can name, for each change, the files it lands in and the tests that prove it. Count the sites that actually carry the risk before planning any change that touches all of them.
3. Detect the forge from `git remote get-url origin`:
   - `github.com`: GitHub, PRs through `gh`, stacked PRs through `gh stack` when the extension is installed;
   - `dev.azure.com` or `visualstudio.com`: Azure DevOps, PRs through `az repos pr create`;
   - anything else: no PR automation; branches are pushed and reported.

   Confirm the CLI is logged in (`gh auth status`, `az account show`).
4. Settle the **base**: the branch the input names, else the remote's default branch. Log it in `RUN-LOG.md`.
5. When the checkout holds uncommitted work, ask the user to commit or move it, so it stays out of every executor's diff.
6. Establish the **verify block**: the repo's documented format, lint, type-check, test and build commands.

Done when you can list every change the input asks for, with its files, its proof, the base and the verify block, and the checkout is clean.

## 3. Plan

1. Group the changes into logical PRs. A logical PR is one concern a reviewer can approve or reject on its own. Order them by dependency, so a PR that needs another stacks on it.
2. Size each PR to its risk. Prefer the narrowest change that fixes the concern over a new abstraction across many sites, and write one before/after snippet of a typical call site for any PR that introduces a shared helper.
3. Choose the **workspace mode**, and recommend the one the plan supports:
   - **incremental**: one branch per PR, worked in order in the current checkout. It fits a single dependency chain.
   - **worktrees**: one git worktree per **lane**, where a lane is a stack of PRs whose files don't overlap another lane's. It fits independent lanes that can run in parallel, with one executor each.
4. Settle every open decision the input leaves: scope, behaviour changes, naming, changesets. Ask in rounds, each round holding every question whose answer doesn't depend on another open one. When the input leaves an interface genuinely open, sketch two or three alternatives before asking.
5. Show the user the plan with `/show-me`: PRs, lanes, order, workspace mode, and the before/after snippets. Wait for approval.
6. Ask whether to open PRs automatically with `/git-pr-summary` when each PR clears its gates. Base the recommendation on step 2.3: recommend yes when the forge CLI is logged in.

Write the PR plan and lanes into `RUN-LOG.md`.

Done when the user has approved the plan and every decision is logged.

## 4. Team

1. Choose each role's model and effort per [roles.md](references/roles.md#choosing-models-and-effort).
2. For worktrees, create each lane's worktree from a fresh `origin/<base>`.
3. Name your own agent `orchestrator`. Start one executor per lane with its cwd in that lane's worktree (or the current checkout, in incremental mode), then the reviewer and the final gate, each with its flags from [roles.md](references/roles.md#start-commands). Log each pane ID, and address every agent by pane ID from then on. Reuse idle shell panes, and split new ones without taking focus, so no column falls below about 60 characters.
4. Ask the reviewer and the final gate to confirm `/thermo-nuclear-code-quality-review` is available, and check a reported miss per [herdr-ops.md](references/herdr-ops.md#pass-skills). When it is truly missing, stop and tell the user.

Done when every agent is idle on an empty prompt, both gates have their skill, and each agent's pane ID, model and effort are in `RUN-LOG.md`.

## 5. Loop, once per PR

In worktrees mode, the reviewer and the final gate serve every lane. Dispatch to a gate only when it is idle and its last reply is transcribed, and note in `RUN-LOG.md` the PRs waiting for one.

1. **Branch.** Cut the branch from a fresh `origin/<base>`, or from the committed PR it stacks on.
2. **Ticket.** Write `PR<n>-T1.md` from [prompts.md](references/prompts.md#ticket). Keep the next PR's ticket written ahead while an executor works.
3. **Execute.** Give the executor a fresh context, then send `Implement <absolute ticket path>.` Wait for the report file.
4. **Vet.** Read the report and the full diff, untracked files included, and re-run the verify block yourself. A red check, drift or scope creep goes back as the next ticket before any review round. A STOP report goes to the user as a question about the plan.
5. **Review, at most 3 rounds.** Write the review prompt from [prompts.md](references/prompts.md#review-prompt) to `PR<n>-R<k>-prompt.md` and take a **snapshot** of the worktree (below). Give the reviewer a fresh context, then dispatch `Read and follow <absolute prompt path>.` ([herdr-ops.md](references/herdr-ops.md#pass-skills)). Round 1 covers the whole diff; later rounds cover the fix's files and whether each earlier finding is resolved. When the reviewer settles, transcribe its reply into `PR<n>-R<k>.md` and take the snapshot again.

   A changed snapshot means the reviewer edited the worktree. Log both hashes, show the user `git diff --stat <before> <after>`, and ask whether to revert the edit (recommended) or keep it for the next review. `git diff --binary <after> <before> | git apply` reverts it.
6. **Verdicts.** Check every finding against the live code and give it one verdict, with a one-line reason logged in `RUN-LOG.md`:
   - *accept*: a real issue. A blocking or should-fix finding becomes an **open finding**; a cheap in-scope nit joins the next ticket.
   - *reject*: wrong, out of scope, or against a logged decision.
   - *defer*: real but outside this PR. The next ticket records it in the open-work file the repo's agent instructions name; when they name none, ask the user where deferred items go. A deferral with no ticket left goes into the PR description.

   While open findings remain and rounds are left, write the next ticket (`PR<n>-T2.md`, and so on) and repeat from step 3.
7. **Final gate, at most 2 rounds.** When the reviewer's rounds close, send the review prompt to the final gate on the full diff, written to `PR<n>-A<k>-prompt.md` and transcribed into `PR<n>-A<k>.md`, with a snapshot around it. Vet, ticket and re-review its findings the same way. Open findings still left afterwards go into the PR description.
8. **Commit.** Only when your own verify run is green; a red verify with no rounds left goes to the user. Stage exactly the PR's files and commit with `/git-commit`.
9. **PR.** Push the branch. With automatic PRs agreed, draft the title and body with `/git-pr-summary` and create the PR with the forge CLI, based on the branch below for a stacked PR. With `gh stack`, follow `gh stack --help`, and check that every layer links to its PR. List any open finding in an "Open review findings" section. Log the URL or the pushed branch.

Done, per PR, when it is committed and pushed, the PR is open or its branch reported, and `RUN-LOG.md` holds every verdict.

The snapshot is the tree hash of the whole working tree, built in a throwaway index so the real one stays untouched. `git status` lists names only, so it misses a reviewer's edit to a file the executor already changed; the hash changes. Run it in the worktree:

```sh
snap() { i=$(mktemp) && GIT_INDEX_FILE=$i git read-tree HEAD && GIT_INDEX_FILE=$i git add -A && GIT_INDEX_FILE=$i git write-tree; command rm -f "$i"; }
```

## 6. Finish

Stop when the last PR is open, or its branch pushed and reported. Report, per PR: URL or branch, what it stacks on, rounds used at each gate, findings fixed, rejected and deferred (with reasons), and open findings. Then list every `auto-decided (AFK)` decision, the merge order, the run directory, and the agents' pane IDs; the agents stay running until the user says to close them. End with what still needs the user.
