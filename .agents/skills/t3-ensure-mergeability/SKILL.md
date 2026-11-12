---
name: t3-ensure-mergeability
description: Drive a branch or PR to mergeable from a T3 Code thread. Delegated Claude and GPT children review and fix it in bounded rounds, configured in plain words.
disable-model-invocation: true
---

# T3: ensure mergeability

You **conduct**. Children judge, fix and prove. You keep the ledger, rule on findings, commit, push and report. Every line of code in the target comes from the executor child.

**Mergeable** means all four hold, each checked by a command you ran:
- the branch is rebased on `origin/<base>` with no conflicts;
- the verify block is green on the final SHA;
- no blocking or should-fix finding is open;
- the checkout is clean and the branch is pushed.

References:
- [run-spec.md](references/run-spec.md): reading the argument into the run spec, with defaults, model resolution and a worked example.
- [briefs.md](references/briefs.md): the reviewer, executor and prover briefs, and the proof page.
- [t3-ops.md](references/t3-ops.md): wakes, child questions, follow-ups, cancelling, PR watching.

## The model

Three facts about T3 shape this run:

- **A wake is a turn.** A child you start with `delegate_task` runs in its own thread. Its completion wakes you in a new turn, carrying its final message, and several completions can share one wake. So you work in short turns: read the ledger, absorb the wake, do the work the phase needs, dispatch, end your turn.
- **The ledger is the run.** `<run-dir>/ledger.md` holds the run spec, target, verify block, every child, every verdict, every decision and the `NEXT:` line. Turns are short and context gets compacted, so whatever is missing from the ledger is lost. Update it before you end every turn.
- **Commits address rounds.** Every fix is committed before it is reviewed. A round reviews an exact range, `<from>..<to>`. By default, each reviewer and the prover gets its own isolated checkout of `HEAD`, built and set up by T3, so they can run code, write reproducers and edit freely there while your checkout stays exactly as committed.

| Role | Brief | Checkout | Returns |
|---|---|---|---|
| `bugs` | [reviewer](references/briefs.md#reviewer): `thermo-nuclear-review` | its own (`isolation: "worktree"`) | findings with reproducers |
| `quality` | [reviewer](references/briefs.md#reviewer): `thermo-nuclear-code-quality-review` | its own | findings |
| `simplify` | [reviewer](references/briefs.md#reviewer): `simplify` | its own | findings with patches |
| `executor` | [ticket](references/briefs.md#ticket) | yours (`isolation: "shared"`) | an uncommitted fix and a report |
| `prover` | [proof](references/briefs.md#proof) | its own | red-then-green evidence |

Each isolated child leaves a worktree and a branch behind, cleared by T3's worktree cleanup settings. With `reviewer checkouts: shared` in the run spec, reviewers work read-only in your checkout. The reviewer brief then opens with that contract, and the clean-at-`H<k>` check in step 4 is the guard.

Start every role with `delegate_task`, with the run spec's target and effort in `target.options`. That includes Claude roles on your own model, since each sets its own effort. Research for a decision is yours, or a native `Agent` helper's within the turn.

## Decisions, grants, stops

A **decision** is any question the run raises. Give it options with one recommended, grounded in named evidence: the code, the repo's instructions, a tool's `--help`, T3's tool descriptions, or the evidence in [run-spec.md](references/run-spec.md#recommendations). The run spec's decision mode says who picks:
- **ask** (default): `AskUserQuestion`, recommended option first and labelled "(Recommended)". After 10 minutes without an answer, take it and log `auto-decided (AFK)`.
- **autonomous**: research until the recommendation is grounded, take it, and log `auto-decided` with the evidence.

A **grant** is the user's yes, given in advance. Each **guarded** action needs its own grant:

| Grant | Phrases | Unlocks |
|---|---|---|
| `force-push` | "force push with lease", "allowed to force push" | `git push --force-with-lease` |
| `open-pr` | "push the PR", "open a PR", "create the PR" | opening a PR when none exists |
| `fix-obvious-bugs` | "fix obvious bugs even out of scope" | the **accept (out of scope)** verdict |

Merging, closing PRs and deleting branches have no grant phrase. They need the user's yes in the moment.

A **stop** waits for the user in both modes:
- a guarded action without its grant;
- a missing dependency;
- uncommitted work that belongs elsewhere;
- a rejected provider or model;
- a thread whose runtime mode makes children ask for approvals, since an approval never wakes you.

A message from the user mid-run amends the run spec from the next dispatch on. Log it in the ledger.

## 1. Open

1. Read the argument into the run spec ([run-spec.md](references/run-spec.md)). Call `orchestrator_capabilities` once, resolve every target against it, and check the thread's runtime mode against the stops.
2. Confirm `/git-commit`, `/git-pr-summary`, `jq`, and a logged-in forge CLI (`gh auth status`, `az account show`).
3. Create the run directory, `mktemp -d "${TMPDIR:-/tmp}/t3-merge.XXXXXX"`, and write `ledger.md` with the resolved run spec as a table. Pick a short run id for `clientRequestId`s.
4. In ask mode, confirm the run spec with one `AskUserQuestion`.

Done when the ledger holds the resolved run spec, the run id, and a confirmed dependency list.

## 2. Target

1. The run spec may name a branch, a worktree or a PR. Without one: this thread's branch (`t3_worktree_status`), its open PR through the forge CLI, and the PR's base or else the remote's default branch.
2. A named branch checked out in another worktree (`t3_worktree_list`) is a decision. The recommendation is to run there, in a new thread the user starts. Children share this thread's checkout, so a run here can only target this branch.
3. Any of these is a decision, with your inference recommended and the other candidates listed: the branch is the base, the branch has no commits over `origin/<base>`, or several candidates fit.
4. Commit uncommitted work that belongs to the target with `/git-commit`. Work that belongs elsewhere is a stop.
5. Establish the verify block: the repo's documented format, lint, type-check, test and build commands (`AGENTS.md`, `CLAUDE.md`, `package.json` or equivalent). Choosing it is a decision.

Done when the ledger holds branch, base, PR or "none", and a verify block covering every check the repo documents, with the checkout clean.

## 3. Baseline

1. `git fetch` and rebase on `origin/<base>`. Conflicts are a decision, with resolution by the executor from a ticket recommended. The resolution is committed, so round 1 reviews it.
2. Run the verify block. A red result becomes a blocking finding in round 1's audit.
3. Record `H0`, the merge base with `origin/<base>`, and `H1`, the current `HEAD`.

Done when the rebase is complete and the ledger holds `H0`, `H1` and the baseline verify output.

## 4. Rounds

Round `k` reviews `H<k-1>..H<k>`, or `H0..H1` for round 1. The run spec caps the rounds. `simplify` joins the first rounds up to its own cap, so later rounds review its fixes.

1. **Dispatch.** Resolve round `k`'s targets, applying any switch that starts here. With the checkout clean at `H<k>`, start one reviewer per role ([briefs.md](references/briefs.md#reviewer)) with `isolation` from the run spec, `role: "review"`, `mode: "async"` and `clientRequestId: <run>-r<k>-<role>`. Log each `taskId` and thread link, set `NEXT: await reviews r<k>`, and end your turn.
2. **Absorb.** On each wake, record what the wake carries. When a result was cut from the wake, read it with `task_status`. Once every reviewer of the round has reported, confirm the checkout still sits clean at `H<k>`. Anything else means a child touched your checkout: recover with `git reset --hard H<k>` (recommended) or keep it, as a decision.
3. **Audit** `A<k>` in the ledger. One root cause is one finding, listing every role that raised it. Settle disagreements by reading the code. Set severity yourself: a simplify finding is should-fix only when it removes complexity the range introduced.
4. **Verdicts.** Check each finding against the code at `H<k>`, and any "this range introduced it" claim against `H0`. A reproducer that fails at `H<k>` settles a dispute. Give each finding one verdict with a one-line reason:
   - **accept**: blocking or should-fix becomes an open finding, and a cheap nit inside the range joins the ticket;
   - **accept (out of scope)**: under `fix-obvious-bugs`, a defect outside the range with an obvious, local fix that no owner decision covers;
   - **reject**: wrong, or against an owner decision in the plan or PR;
   - **defer**: real but outside the target. Where it gets recorded is a decision. A pre-existing security or data-exposure defect is a decision too, with fixing it here recommended.
5. **Exit.** With no open finding and the verify block green at `H<k>`, go to step 5. After the last allowed round, open findings or a red verify block make a decision, with the round commits kept local.
6. **Fix.** Start the executor with the ticket in `task` ([briefs.md](references/briefs.md#ticket)): `isolation: "shared"`, `role: "implementation"`, `clientRequestId: <run>-t<k>`. Set `NEXT: await fix t<k>` and end your turn.
7. **Vet.** On the wake, read the executor's report, the full diff including untracked files, and the verify block's output from your own run. Red checks or drift go back to the same executor through `t3_thread_send`, at most twice ([t3-ops.md](references/t3-ops.md#follow-ups)). Commit the result with `/git-commit` as `H<k+1>`, then start round `k+1`. Checks still red after two follow-ups are committed too, and enter round `k+1`'s audit as a blocking finding.

Done when the exit holds, or its decision is in the ledger.

## 5. Prove

Run this step when the run spec asks for proof.

1. Start the prover ([briefs.md](references/briefs.md#proof)) with `isolation: "worktree"`, `role: "test"` and the executor's target, unless the run spec names another. It runs every claim at `H0` and at the final SHA in its own checkout.
2. Build one self-contained HTML page in the run directory from its results ([briefs.md](references/briefs.md#proof-page)), following `/show-me` for its shape and `html_render`'s theme and layout rules for its styling. Check it with `html_preview`, then show it in this thread with `html_render`, passing its `path` to both.
3. A claim that fails at the final SHA becomes a blocking finding for one more round when rounds remain, and a decision otherwise.

Done when every claimed behaviour has a red-then-green or observed piece of evidence on a rendered page.

## 6. Ship

1. `git fetch`. If the base moved, rebase and re-run the verify block. A red result makes one more round when rounds remain, and a decision otherwise.
2. Push. A rebased branch takes `git push --force-with-lease`, which is guarded.
3. With a PR, merge `/git-pr-summary` into its description. Without one, open it with `gh pr create` and the `/git-pr-summary` text, which is guarded. Call `link_pull_request` right after you create or push to a PR.
4. With the CI wait on, call `watch_pull_request` and end your turn ([t3-ops.md](references/t3-ops.md#ci)).

Done when the checkout is clean, `git status -sb` shows nothing ahead of the remote, and the PR is linked with a current description.

## 7. Report

Before handing back, `unwatch_pull_request` any PR you watch, and `task_cancel` every child still running. Then report:
- the target, the final SHA, and each mergeable condition with the command that showed it;
- the PR link, its checks and reviews;
- the resolved run spec, every switch with the round it took effect, and every amendment;
- the rounds used, and the commit each round produced;
- the findings fixed, with the roles that raised them; those fixed out of scope; rejected and deferred, with reasons; and any left open;
- every `auto-decided` and `auto-decided (AFK)` decision, with its evidence;
- every child, by its thread link, and the worktrees and branches the isolated ones left;
- the run directory.

End with what still needs the user.
