# Briefs

A child sees only its `task`, so each brief is complete in itself. Paste content, such as the PR description, review comments and findings, instead of pointing at your context. Write every path as an absolute path.

## Reviewer

```
You are the <role> reviewer in round <k> of a merge review. Your checkout is your own copy of commit <H<k>>. Build, run, write tests and edit there as you need. Your checkout is your whole workspace: the shared branch, the remote and the PR stay as they are.

Lens: <the role's lens, below>
Range: git diff <from>..<H<k>>, on base origin/<base>.
Intent: <PR description or plan, pasted>
PR review comments: <pasted, or none>
Re-check: <round 1: none | each earlier open finding, with its id and the commit that fixed it>
Settled: <rejected and deferred findings and owner decisions, with one-line reasons; leave these out of your findings>

Make every blocking or should-fix finding fail where you can: a test or command that is red at <H<k>>. A finding you cannot reproduce keeps the trace that shows it.

Reply with only this:

### R<id> resolved | not resolved | regressed: <why>     (one per re-check item)

### F<n> <short title>
- file: <path>:<line>
- severity: blocking | should-fix | nit
- evidence: <the concrete scenario>
- repro: <command and its observed output, or "none: <why>">
- fix: <the concrete change, or a unified diff against <H<k>>>

Most severe first. With nothing found, write "No findings.". End with END-OF-FINDINGS.
```

Lenses:
- `bugs`: read and follow `<home>/.claude/skills/thermo-nuclear-review/SKILL.md`. It covers bugs, breakages, security and regressions.
- `quality`: read and follow `<home>/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md`. It covers maintainability, structure and abstractions.
- `simplify`: run the `simplify` skill on the range in your checkout. It covers reuse, simplification and efficiency. Report each change it makes as a finding, with its diff as the fix.

With `reviewer checkouts: shared`, replace the brief's opening with: `Your checkout is the shared checkout <path> at <H<k>>, read-only: read, build and run tests there, and leave every file as it is.` The simplify lens then reports its changes as diffs without applying them.

A path reaches every provider; both a Claude and a Codex child read these files in testing. A Codex child has no Skill tool, and `thermo-nuclear-review` sets `disable-model-invocation: true`, which hides it from a Claude child's Skill tool. `simplify` ships inside Claude Code and has no file on disk, so the role runs on Claude only.

## Ticket

```
You are the executor for round <k> of a merge review, in the checkout <path> on branch <branch> at <H<k>>.

Read the repo's agent instructions (AGENTS.md, CLAUDE.md or equivalent) first, and hold every changed line to them.

Fix exactly these findings:
<each accepted finding: id, severity, the roles that raised it, file:line, evidence, repro, fix, and "out of scope" where its verdict says so>

Deferred, leave as they are: <items, or none>
Verify block: <commands>

Check each finding's file:line against the code, and report every mismatch as drift. A reviewer's diff may be applied when it still fits. Run the verify block until every command is green. Leave your changes uncommitted on this branch; the conductor commits them.

After every command has finished, reply with only this:
CHANGED: <files>
VERIFY: <each command: pass | fail>
DRIFT: <mismatches, or none>
QUESTIONS: <open questions, or none>
END-OF-REPORT
```

## Proof

The claims are the behaviours the PR intends, plus every fixed finding with a reproducer. Name a command for each one: a reviewer's repro, a test the executor added, or a way to run the app.

```
You are the prover. Your checkout is your own copy of <final SHA>. For each claim below, run its command at <final SHA>, then at <H0> with `git checkout --detach <H0>`, and then return to <final SHA>. Re-run the repo's install step when the lockfile differs between the two. Save each full output to .proof/<n>-final.log and .proof/<n>-base.log in your checkout.

Claims:
<C1: claim, command>
...
Verify block, at <final SHA> only: <commands>

Reply with only this:

### C<n> <claim>
- kind: red-then-green | observed | regression-guard
- base <H0 short>: exit <code>, <excerpt>
- final <SHA short>: exit <code>, <excerpt>
- logs: <absolute paths>

### Verify
<each command: pass | fail>

END-OF-PROOF
```

A claim proves its behaviour when it is red at `H0` and green at the final SHA (**red-then-green**), or when the final run shows the behaviour directly (**observed**). A command that is green in both runs only guards against regression, so pair it with one of the other two.

## Proof page

Copy the prover's logs into the run directory, then build one page:
- one row per claim: the claim, its kind, the command, both excerpts side by side, and the log paths;
- the final SHA, and the verify block with each command's result;
- each finding fixed, with its reproducer's before and after;
- what remains unproven, and why.
