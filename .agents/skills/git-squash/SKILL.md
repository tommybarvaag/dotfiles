---
name: git-squash
description: Use when collapsing a feature branch into one commit on itself. Handles pre-flight checks, self-squash prep, commit delegation, and verification without touching main or deleting branches.
---

# Git Squash

## Purpose

Collapse all commits on a feature branch since it diverged from `main` into one new commit on the same branch.

## Pre-flight Checks

Before merging, validate the environment:

1. **Determine source branch** — use the argument if provided (`/git-squash feature/my-branch`), otherwise use the current branch.
2. **Verify branch exists** — `git rev-parse --verify <branch>`.
3. **Verify not on main** — abort if source branch is `main`.
4. **Check for uncommitted changes** — `git status --porcelain`. If dirty, abort and suggest committing or stashing.
5. **Switch to source branch if needed** — `git checkout <branch>`.
6. **Resolve base ref** — if remote `origin` exists, run `git fetch origin` and use `origin/main`; otherwise use local `main`. Abort if the base ref does not exist.
7. **Verify divergence** — `git log <base-ref>..<branch> --oneline`. If empty, abort — nothing to squash.

## Self-Squash Preparation

```bash
original_head=$(git rev-parse HEAD)
original_tree=$(git rev-parse HEAD^{tree})
merge_base=$(git merge-base <base-ref> HEAD)

git reset --soft "$merge_base"
```

Do not checkout `main`. Do not use `git merge --squash`. The soft reset stages the full branch diff as one commit candidate on the same branch.

## Delegate to commit

Invoke `/git-commit` to handle the commit. Require:

- one conventional commit subject
- a concise 1-2 sentence body summarizing the branch as a whole

If commit hooks modify files and prevent the commit from completing, keep the staged squash intact and invoke `/git-commit` again from the updated state. Never auto-reset.

Do not write the commit message directly outside `/git-commit`.

## Post-merge Verification

```bash
git branch --show-current
git log --oneline -5
git rev-list --count <base-ref>..HEAD
git rev-parse HEAD^{tree}
git diff --stat "$original_head" HEAD
git status
```

Confirm:

- still on the source branch
- exactly one commit exists in `<base-ref>..HEAD`
- clean working tree
- no leftover staged changes
- if `git rev-parse HEAD^{tree}` matches `original_tree`, the squash preserved branch content exactly
- if the tree differs, do not fail automatically; inspect `git diff --stat "$original_head" HEAD` and report any hook- or generator-driven changes clearly

## Failure Handling

If any step after `git reset --soft` fails:

- stop and report the error
- do not auto-reset, auto-push, or auto-delete anything
- include `original_head` in the report so the user has a recovery point
- if commit hooks changed files, say so explicitly and leave the index and worktree untouched for the next `/git-commit` attempt
- if the user wants to abandon the squash attempt, suggest `git reset --hard "$original_head"` as a manual recovery command, but never run it automatically

## Rules

- **Proceed without confirmation** — pre-flight checks are the safety gate.
- Only squash a non-`main` branch onto itself.
- Never checkout `main` as part of this workflow.
- Never use `git merge --squash` for this workflow.
- Always delegate the commit to `/git-commit`.
- Always require a concise commit body in addition to the subject.
- Never delete local or remote branches.
- Never push automatically. If the user wants the rewritten branch pushed, that requires explicit approval and `git push --force-with-lease`.
- If any step fails, stop and report the error.

## Quick Reference

Pre-flight → switch to source branch → resolve base ref → record `original_head` and `original_tree` → `git reset --soft "$(git merge-base <base-ref> HEAD)"` → `/git-commit` → verify → stop.
