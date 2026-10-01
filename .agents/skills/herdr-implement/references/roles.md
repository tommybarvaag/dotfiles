# Roles

| Role | Writes code | Pass | Rounds per PR |
|---|---|---|---|
| `executor` (one per lane: `executor-a`, `executor-b`, …) | yes | the ticket | until its ticket is done |
| `reviewer` | no | `/thermo-nuclear-code-quality-review`, checked against the repo's agent instructions | 3 |
| `final` | no | `/thermo-nuclear-code-quality-review` on the full diff, last gate before the PR | 2 |

The reviewer and the final gate are different agents, ideally from different model families, so the final gate sees the diff with fresh eyes.

## Choosing models and effort

Build the options from the installed CLIs:

- Claude Code: the model aliases in `claude --help` under `--model`, and the levels under `--effort`.
- Codex: `codex debug models` prints the model catalog as JSON. Offer the entries whose `visibility` is `list`, judge capability by their `description`, and offer each model only its own `supported_reasoning_levels`.

Ask in two `AskUserQuestion` calls with one question per role: models first, then efforts for the chosen models. A question holds at most four options, so put the recommendation first and the nearest alternatives after it, with at least one from the other CLI. The tool adds "Other" for anything else the CLI accepts.

Recommend from the evidence below, mapped onto what the catalogs list today. When an evidence model or level is no longer listed, recommend its closest current equivalent and say so in the option's description.

| Role | Recommendation | Evidence from runs up to 2026-09 |
|---|---|---|
| `executor` | Claude Code, `opus`, medium | Opus at medium executed tickets reliably. |
| `reviewer` | Claude Code, `opus`, high | Opus at high caught structural issues across rounds. |
| `final` | Codex, the most capable listed model, xhigh | A Codex model at xhigh as the final gate found issues the Claude reviewer had missed. |

## Start commands

Pass each role's native flags after `--` on `herdr agent start`, with the kind `claude` or `codex`.

| Capability | Claude Code | Codex |
|---|---|---|
| model | `--model <model>` | `-m <model>` |
| effort | `--effort <level>` | `-c 'model_reasoning_effort="<level>"'` |
| no approval prompts | `--permission-mode auto` | `-a never` |
| executor writes the worktree | the default | `-s workspace-write` |
| reviewer reads only | `--disallowedTools "Edit,Write,NotebookEdit"` | `-s read-only` |
| run directory access | `--add-dir <run-dir>`, plus every lane worktree for the reviewer and final gate | executor only: `--add-dir <run-dir>` |

Before the first start, confirm each flag in `claude --help` or `codex --help`. When a flag is renamed or gone, use the flag the help now gives for the same capability, and log the substitution in `RUN-LOG.md`. `model_reasoning_effort` is a config key, so the Codex help shows only the generic `-c key=value`.

Why these flags:

- **No approval prompts.** An approval prompt stops the loop until someone answers it. Under Codex's `-a never`, a blocked command fails back to the model instead.
- **Read-only reviewers.** Codex's `-s read-only` is a sandbox. A Claude Code reviewer loses the edit tools but keeps Bash, so it can still write through the shell. The review prompt states the contract, and the worktree snapshot around every review is the check that holds for both.
- **Run directory access.** The run directory sits outside every worktree, and lane worktrees sit outside the gates' cwd. Claude Code agents read their prompt files and the lanes they review there, and an executor writes its report there. Codex's workspace-write sandbox allows the OS temp directory by default and blocks writes elsewhere outside the worktree; `--add-dir` keeps the run directory writable when a config turns that default off.
- **Plan mode and `--approve-for-me` stay off.** Plan mode stops for approval before acting and can hand control to an executing mode. Codex's `--approve-for-me` routes approvals through the workspace-write sandbox, so a reviewer could write.
- **A permission classifier may refuse `-a never`.** When your own permission layer blocks that start command, start a Codex reviewer without `-a never`. Decline each approval prompt it raises with `esc`, and resend the read-only instruction from [prompts.md](prompts.md#review-prompt). A Codex executor needs `-a never` to work unattended, so recommend a Claude Code executor instead.
- **A read-only reviewer cannot write its findings file.** It replies in chat, and you transcribe the reply into `PR<n>-R<k>.md` or `PR<n>-A<k>.md`. A Codex reviewer also cannot reach the network or forge CLIs, so its prompt carries any PR metadata it needs.
