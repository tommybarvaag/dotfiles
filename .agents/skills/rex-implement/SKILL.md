---
name: rex-implement
description: Implement a goal, spec or markdown plan from a Rex terminal, with a subagent executor and fresh reviewer panes each round, ending in reviewed PRs.
disable-model-invocation: true
---

# Rex: implement

You are the **orchestrator**. You turn the input into logical PRs, write a **ticket** per change, and hand it to the **executor**, a Claude Code subagent. You vet every diff yourself, run each PR through review **rounds**, and commit, push and open the PRs. A round opens a fresh Rex tab with one pane per **reviewer**, and each reviewer runs once, writes its report and exits. You write only the run docs, tickets, briefs, verdicts, commits and PR text. Every line of code comes from the executor.

The input is the argument: a goal sentence, a spec, a markdown plan, a ticket or an issue link. Read all of it before planning.

References:
- [roles.md](references/roles.md): the roles and their caps, choosing models and effort, the executor call, the reviewer commands.
- [rex-ops.md](references/rex-ops.md): command shape, running a round with `scripts/review.lua`, reading, the probe, teardown.
- [prompts.md](references/prompts.md): ticket, executor contract, review brief.

## Decisions and the AFK rule

Every question for the user goes through `AskUserQuestion`, up to four per call, recommended option first and labelled "(Recommended)". Every recommendation is **grounded**. Research it first in the code, the repo's instructions, a tool's `--help`, its docs or the run evidence in [roles.md](references/roles.md#choosing-models-and-effort), and name that evidence in the option's description. Offer an option you could not ground without the label.

Ask every question **up front**, in the rounds of steps 3 and 4, before the first ticket. That includes each assumption that would rule out an option, such as the largest data size the change must handle or a hard constraint like SSR. Offer such an assumption without a recommendation, since only the user knows it.

After the up-front rounds the run is **autonomous**. Research each new decision, take the grounded option, and log it in `DECISIONS.md` with its evidence. Two kinds still go to the user: a STOP report that changes the plan, and anything only the user knows.

If a question goes unanswered for 10 minutes, the user is AFK:
- take the recommended option; a question without one waits for the user;
- log it in `DECISIONS.md` as `auto-decided (AFK)`, with the evidence;
- keep working.

When the user says they are gone for the session, take the recommended option at once. Force-pushes, merges, closing PRs and deleting branches or worktrees always wait for an explicit yes, and an up-front answer counts only for the case it names.

## 1. Preflight

1. Before the first other `rex` command, read the guide for the installed Rex: `rex skill show`. This skill is not that guide, and the guide comes from the binary, so it matches the installed commands.
2. Confirm you run inside a Rex terminal: `rex whoami --json` reports the session and block that `$REX_SESSION` and `$REX_BLOCK` name. Log both IDs, and pass them as literals from then on ([rex-ops.md](references/rex-ops.md#command-shape)).
3. Confirm your dependencies: the Claude Code tools `AskUserQuestion`, `Agent`, `SendMessage` and `ListAgents`, `/git-commit`, `/git-pr-summary`, `~/.agents/skills/show-me/SKILL.md`, `jq`, and the pass skills' `SKILL.md` paths in [roles.md](references/roles.md). Log the absolute paths `command -v codex` and `command -v claude` print. Ask the user about anything missing.
4. Create the run directory in the OS temp directory, outside the repo: `mktemp -d "${TMPDIR:-/tmp}/rex-implement.XXXXXX"`. It holds `RUN-LOG.md` with the PR plan, lanes, agents, rounds and verdicts, `DECISIONS.md` with every decision and its evidence, and every ticket, brief, spec and report, each addressed by absolute path.

Done when the Rex guide is read, your IDs and CLI paths are logged, every dependency is confirmed, and the run directory holds `RUN-LOG.md` and `DECISIONS.md`.

## 2. Understand

1. Read the input, the repo's agent instructions, such as `AGENTS.md` or `CLAUDE.md`, and every file the input names.
2. Research the code the input touches until you can name, for each change, the files it lands in and the tests that prove it. Count the sites that actually carry the risk before planning any change that touches all of them.
3. Detect the forge from `git remote get-url origin`:
   - `github.com`: GitHub, PRs through `gh`, stacked PRs through `gh stack` when the extension is installed;
   - `dev.azure.com` or `visualstudio.com`: Azure DevOps, PRs through `az repos pr create`;
   - anything else: no PR automation; branches are pushed and reported.

   Confirm the CLI is logged in with `gh auth status` or `az account show`.
4. Settle the **base**: the branch the input names, else the remote's default branch. Log it in `RUN-LOG.md`.
5. When the checkout holds uncommitted work, ask the user to commit or move it, so it stays out of every executor's diff.
6. Establish the **verify block**: the repo's documented format, lint, type-check, test and build commands. Run it once on the clean base under the throttle in [prompts.md](references/prompts.md#executor-contract), and log each red check as a **known red**.

Done when you can list every change the input asks for, with its files, its proof, the base, the verify block and its known reds, and the checkout is clean.

## 3. Plan

1. Group the changes into logical PRs. A logical PR is one concern a reviewer can approve or reject on its own. Order them by dependency, so a PR that needs another stacks on it.
2. Size each PR to its risk. Prefer the narrowest change that fixes the concern over a new abstraction across many sites, and write one before/after snippet of a typical call site for any PR that introduces a shared helper.
3. Choose the **workspace mode**, and recommend the one the plan supports:
   - **incremental**: one branch per PR, worked in order in the current checkout. It fits a single dependency chain.
   - **worktrees**: one git worktree per **lane**, where a lane is a stack of PRs whose files don't overlap another lane's. It fits independent lanes that can run in parallel, with one executor each.
4. Settle every open decision the input leaves: scope, behaviour changes, naming, changesets, and the assumptions that would rule out an option. Ask in rounds, each round holding every question whose answer doesn't depend on another open one. When the input leaves an interface genuinely open, sketch two or three alternatives before asking.
5. Show the user the plan the way `~/.agents/skills/show-me/SKILL.md` says: PRs, lanes, order, workspace mode, and the before/after snippets. Wait for approval.

Write the PR plan and lanes into `RUN-LOG.md`.

Done when the user has approved the plan and every decision is logged.

## 4. Setup

Ask these before the first ticket, in the same rounds as the plan's questions when they don't depend on its answers:

1. Each role's model and effort, per [roles.md](references/roles.md#choosing-models-and-effort).
2. The round caps: recommend bugs and quality at most 3 rounds and simplify at most 2, the owner's defaults from 2026-10-20.
3. The skills each ticket names for the executor, such as `/coding-standards` for TypeScript or `/make-interfaces-feel-better` for UI work. Recommend from the files the plan touches and the installed skills.
4. Where deferred findings go: an issue, the open-work file the repo's agent instructions name, or the final report.
5. Whether to open the PRs automatically once every PR clears its rounds. Recommend yes when the forge CLI is logged in. With no, the run ends at pushed branches, and a PR opens only after the user agrees the work is finished.

Then:

6. For worktrees mode, create each lane's worktree from a fresh `origin/<base>`.
7. Run the probe in [rex-ops.md](references/rex-ops.md#probe) with the chosen reviewer CLIs.

Done when every answer is in `DECISIONS.md`, each role's model and effort is in `RUN-LOG.md`, and the probe passed.

## 5. Loop, once per PR

In worktrees mode, each lane runs this loop with its own executor, and rounds for different lanes may run at once, each in its own tab.

1. **Branch.** Cut the branch from a fresh `origin/<base>`, or from the committed PR it stacks on.
2. **Ticket.** Write `PR<n>-T1.md` from [prompts.md](references/prompts.md#ticket). Keep the next PR's ticket written ahead while the executor works.
3. **Execute.** Start a new executor for the PR per [roles.md](references/roles.md#executor-call) with `Implement <absolute ticket path>.`, and log its agent ID. Send each later ticket for the same PR to that ID with `SendMessage`, so the executor keeps the context of the code it wrote. Its hand-back notification ends a turn, and its report file ends the task. A hand-back without the report file gets `Continue where you left off, then write the report.` Before you tell the user the executor is still working, check `ListAgents`.
4. **Vet.** Read the report and the full diff, untracked files included, and re-run the verify block yourself under the throttle. A red check other than a known red, drift or scope creep goes back as the next ticket before any round. A STOP report goes to the user as a question about the plan. Answer the report's open questions under the autonomous rule, in the next ticket.
5. **Round k.** Bugs and quality review while k is within their cap, and simplify while k is within its cap.
   - Write the brief `PR<n>-R<k>-brief.md` from [prompts.md](references/prompts.md#review-brief) and the spec `PR<n>-R<k>-review.json` from [rex-ops.md](references/rex-ops.md#rounds).
   - Run the round in the background per [rex-ops.md](references/rex-ops.md#rounds). The script takes a **snapshot** of the worktree before the panes start and after the last reviewer ends.
   - When it exits, read every complete report, and rerun any incomplete reviewer per the same section.
   - A changed snapshot means a reviewer edited the worktree. Log both hashes, show the user `git diff --stat <before> <after>`, and ask whether to revert the edit (recommended) or keep it for the next round. `git diff --binary <after> <before> | git apply` reverts it.
   - Close the round's tab ([rex-ops.md](references/rex-ops.md#teardown)).
6. **Verdicts.** Synthesize the reports into `PR<n>-R<k>.md`:
   - one root cause is one finding, listing every role that raised it. Two roles raising it is strong evidence;
   - settle disagreements between roles by reading the code, and note why;
   - set severity yourself. A simplify finding is should-fix only when it removes duplication or complexity the diff introduced.

   Check every finding against the live code and give it one verdict, with a one-line reason in `PR<n>-R<k>.md` and `RUN-LOG.md`:
   - *accept*: a real issue. A blocking or should-fix finding becomes an **open finding**; a cheap in-scope nit joins the next ticket.
   - *reject*: wrong, out of scope, or against a logged decision.
   - *defer*: real but outside this PR. It goes where step 4.4 says.
7. **Exit check.** With no open findings and your verify green, go to step 8. With open findings and k below the bugs and quality cap, write the fix ticket `PR<n>-T<k+1>.md` and go to step 3. When the cap is spent with open findings or a red verify, ask the user: another round, carry the findings into the PR description, or stop the PR.
8. **Commit.** Stage exactly the PR's files and commit with `/git-commit`. When the worktree holds more than one PR's changes, stage by `layers.json`, and stage one hunk of a shared file with `git apply --cached <patch>`, since `git add -p` is interactive. Push nothing yet. A late fix to a lower PR then lands on its branch, and a local rebase carries it into the PRs above with no force-push.

Done, per PR, when it is committed locally and `RUN-LOG.md` holds every round and verdict.

## 6. Ship

Start once every PR is committed.

1. `git fetch`. When `origin/<base>` moved, rebase the PRs onto it, bottom first, and re-run the verify block. A red result goes to the user.
2. Push every branch.
3. With automatic PRs agreed, draft each title and body with `/git-pr-summary` and create the PR with the forge CLI, based on the branch below for a stacked PR. List each finding carried over in an "Open review findings" section.
4. For a stack with `gh stack`, follow the `gh-stack` skill and check that every layer links to its PR. `gh stack sync` rebases and force-pushes every layer when the trunk moved since your last fetch, so fetch and compare first, and ask before a sync that would rewrite branches.
5. Log each PR URL, or each pushed branch.

Done when every branch is pushed, and every PR is open or its branch reported.

## 7. Finish

Report, per PR: URL or branch, what it stacks on, rounds used per role, findings fixed with the roles that raised them, findings rejected and deferred with their reasons, and findings carried over. Then list every autonomous and `auto-decided (AFK)` decision, the merge order, the run directory and the executors' agent IDs.

Show the result of the work the way `~/.agents/skills/show-me/SKILL.md` says, then end with what still needs the user.
