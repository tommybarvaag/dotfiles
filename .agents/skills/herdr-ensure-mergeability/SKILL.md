---
name: herdr-ensure-mergeability
description: Bring a branch, worktree or PR to mergeable with a Herdr team of three read-only reviewers and one executor.
disable-model-invocation: true
---

# Herdr: ensure mergeability

You are the **orchestrator**. Three **read-only** reviewers report findings to you; you merge them into one audit and give every finding a **verdict**; the executor writes every code change from your **ticket**; you verify, commit and push. You write no code, only the run docs, audits, tickets, verdicts and commits.

**Mergeable** means all four hold:
- the target is rebased on its base with no conflicts;
- your own run of the verify block is green;
- no blocking or should-fix finding is open;
- the worktree is clean and pushed.

References:
- [roles.md](references/roles.md): roles, choosing models and effort, start commands.
- [herdr-ops.md](references/herdr-ops.md): addressing agents, fresh context, pass skills, dispatch, wait, read, blocked agents.
- [prompts.md](references/prompts.md): review prompt, ticket, executor contract.

## Decisions and the AFK rule

Every question for the user goes through `AskUserQuestion`, recommended option first and labelled "(Recommended)". Ground each recommendation in the code, the repo's instructions, a tool's `--help` or the run evidence in [roles.md](references/roles.md#choosing-models-and-effort), and name that evidence in the option's description. An option you could not ground is offered without the label.

If a question goes unanswered for 10 minutes, the user is AFK:
- take the recommended option; a question without one waits for the user;
- log it in `RUN-LOG.md` as `auto-decided (AFK)`, with the evidence;
- keep working.

When the user says they are gone for the session, take the recommended option at once. Force-pushes, merges, closing PRs and deleting branches or worktrees always wait for an explicit yes.

## 1. Preflight

1. Before the first `herdr` command, read the guide for the installed Herdr: run the command that the note for agents in `herdr --help` gives for controlling Herdr (at the time of writing, `herdr --skill`). This skill is not that guide, and an installed copy of the guide can lag the binary.
2. Confirm your own dependencies: `AskUserQuestion` (this skill runs in Claude Code), `/git-commit`, `/git-pr-summary`, and a logged-in forge CLI when the remote has one (`gh auth status`, `az account show`). Ask the user about any that is missing.
3. Create the run directory in the OS temp directory, outside the repo: `mktemp -d "${TMPDIR:-/tmp}/herdr-merge.XXXXXX"`. Every run doc, prompt, ticket and report lives there, addressed by absolute path.

Done when the Herdr guide is read, every dependency is confirmed, and the run directory exists.

## 2. Target

The argument names a branch, a worktree path or a PR URL. Without one, infer in this order:
1. the branch: the current worktree's branch;
2. its open PR, via the forge CLI the remote uses (`gh` for GitHub, `az repos` for Azure DevOps);
3. the base: the PR's target branch, else the remote's default branch.

When any part is uncertain (the branch is the base or has no commits over `origin/<base>`, several candidate branches, no worktree for a named branch), ask. Your inference is the first option, and the other candidates you found follow.

When the worktree holds uncommitted work, ask whether it belongs to the target. Commit work that belongs with `/git-commit` now, so the rebase can run and the worktree can end clean. Work that doesn't belong is the user's to move before you continue.

Done when branch, worktree path, base and PR (or "none") head `RUN-LOG.md`, and the worktree has no uncommitted changes.

## 3. Team

1. Choose each role's model and effort per [roles.md](references/roles.md#choosing-models-and-effort).
2. Name your own agent `orchestrator` (a suffix if the name is taken).
3. Give each role a pane with the worktree as its cwd, keeping focus in your pane. Reuse idle shell panes in your tab.
4. Start each role with its flags from [roles.md](references/roles.md#start-commands), and log its pane ID. Address it by pane ID from then on.
5. Ask each reviewer to confirm its pass skill is available, and check any it reports missing per [herdr-ops.md](references/herdr-ops.md#pass-skills). When one is truly missing, stop and tell the user.
6. Establish the verify block: the repo's documented format, type-check, lint, test and build commands (`AGENTS.md`, `CLAUDE.md`, `package.json` or equivalent). Confirm it with the user once and log it.

Done when all four agents are idle on an empty prompt, every pass skill is confirmed, and pane IDs, models, efforts and the verify block are logged.

## 4. Baseline

1. `git fetch`, then rebase the worktree on `origin/<base>`. On conflicts, leave the rebase in progress and ask the user:
   - the executor resolves the conflict markers from a ticket, then you stage the files and continue the rebase (recommended: the review loop then covers the resolution);
   - the user resolves them, and you continue the rebase;
   - abort the rebase and stop the run.
2. Run the verify block and log it. A red result before any finding goes into the first ticket.

Done when the rebase is complete and the baseline verify result is in `RUN-LOG.md`.

## 5. Loop (at most three reviews)

An iteration is one review and, when it leaves open findings, one fix. The next iteration's review covers that fix, so every fix is reviewed.

1. **Review.**
   - Take a **snapshot** of the worktree (below).
   - Give each reviewer a fresh context, then dispatch all three in parallel with the review prompt. Iteration 1 covers `git diff origin/<base>...HEAD` plus uncommitted and untracked files; later iterations cover the last ticket's files and findings.
   - When all three settle, transcribe each reply into `A<k>-<role>.md` and take the snapshot again.
   - A changed snapshot means a reviewer edited the worktree. Log both hashes, show the user `git diff --stat <before> <after>`, and ask whether to revert the edit (recommended) or keep it for the next review. `git diff --binary <after> <before> | git apply` reverts it. Restart the reviewer whose transcript shows the edit.
2. **Synthesize** `A<k>.md`:
   - one root cause is one finding, listing every role that raised it; two roles raising it is stronger evidence;
   - resolve disagreements between roles by reading the code, and note why;
   - set severity yourself; a simplify finding is should-fix only when it removes duplication or complexity the diff introduced.
3. **Verdicts.** Check every finding against the live code, and any "the diff introduced this" premise against `origin/<base>`. Give each one verdict, with a one-line reason in `A<k>.md` and `RUN-LOG.md`:
   - **Accept**: blocking or should-fix becomes an **open finding**; a cheap in-scope nit joins the ticket.
   - **Reject**: wrong, out of scope, or contradicts an owner decision in the plan or PR.
   - **Defer**: real but outside the target. Ask the user where deferred items are recorded. You record them in a place outside the repo, such as an issue; a repo file gets them through the next ticket, or through the final report when no fix round is left. For a pre-existing security or data-exposure defect, ask whether to fix it in this target.
4. **Exit check.** With no open findings and your verify green, go to step 6. After the third review, open findings or a red verify stop the loop: ask the user how to proceed, and leave everything uncommitted.
5. **Ticket** `T<k>.md` from `A<k>.md` ([prompts.md](references/prompts.md#ticket)). Give the executor a fresh context, then send `Implement <absolute ticket path>.`
6. **Vet.** When the report file exists, read it and the full diff including untracked files, then re-run the verify block. Drift and red checks join the next ticket. Then start the next iteration.

Accepted nits left after the last iteration go into the final report.

The snapshot is the tree hash of the whole working tree, built in a throwaway index so the real one stays untouched. `git status` lists names only, so it misses a reviewer's edit to a file the executor already changed; the hash changes. Run it in the worktree:

```sh
snap() { i=$(mktemp) && GIT_INDEX_FILE=$i git read-tree HEAD && GIT_INDEX_FILE=$i git add -A && GIT_INDEX_FILE=$i git write-tree; command rm -f "$i"; }
```

## 6. Commit and push

1. Stage exactly the executor's files by path and commit with `/git-commit`.
2. `git fetch`. If the base moved, rebase (conflicts as in step 4) and re-run the verify block. A red result after the rebase goes to the user.
3. Push. A rebased branch needs `git push --force-with-lease`, which needs the user's explicit yes every time.
4. With a PR, update its description with `/git-pr-summary`, merged into the existing text.

Done when the worktree is clean, the branch is pushed, and the PR description (if any) is updated.

## 7. Finish

Report:
- target, final SHA, and each mergeable condition;
- PR policy state when there is a PR (reviews, build, blocking policies);
- iterations used;
- findings fixed (with the roles that raised them), rejected and deferred (with reasons), and any left open;
- every `auto-decided (AFK)` decision;
- the run directory, where the logs, audits and tickets stay;
- the agents' pane IDs. The agents stay running until the user says to close them.

End with what still needs the user.
