# Roles

| Role | Runs as | Pass skill | Writes code | Rounds per PR |
|---|---|---|---|---|
| `executor` | an interactive CLI in its own pane, one per PR | the skills its ticket names | yes | until its tickets are done |
| `bugs` | a one-shot pane per round | `/thermo-nuclear-review`, `~/.agents/skills/thermo-nuclear-review/SKILL.md` | no | at most 3 |
| `quality` | a one-shot pane per round | `/thermo-nuclear-code-quality-review`, `~/.agents/skills/thermo-nuclear-code-quality-review/SKILL.md` | no | at most 3 |
| `simplify` | a one-shot pane per round, Claude Code only | `/simplify`, bundled with Claude Code, findings only | no | at most 2 |

The caps are the owner's defaults from 2026-10-20, the same caps they set mid-run on #357. The setup round still asks for them, since the owner has changed caps mid-run before.

Why each role runs where it does:

- **The executor is a long-lived pane.** Each fix ticket for a PR goes to the agent that wrote the code, so it keeps that context, and `turn.lua` reports when each turn settles. Its start command sets the role's model and effort, and the user can watch it work. A native subagent ignores both: it runs at the orchestrator's effort, out of the user's sight, as the executors on PR #393 did.
- **Reviewers are one-shot.** A new process per round starts from a fresh context, so no reset step can swallow the next prompt. The process exit is the completion signal, and the CLI writes the report itself, which a read-only sandbox allows. A follow-up is a new run. The data-table-filter run used this shape for two rounds with no failure.

## Choosing models and effort

Build the options from the installed CLIs:

- Claude Code: the model aliases in `claude --help` under `--model`, and the levels under `--effort`.
- Codex: `codex debug models` prints the model catalog as JSON. Offer the entries whose `visibility` is `list`, judge capability by their `description`, and offer each model only its own `supported_reasoning_levels`.

Ask in two `AskUserQuestion` calls with one question per role, models first and then efforts for the chosen models. A question holds at most four options, so put the recommendation first and the nearest alternatives after it, with at least one from the other CLI where the role offers both. The tool adds "Other" for anything else the CLI accepts.

Recommend from the evidence below, mapped onto what the catalogs list today. When an evidence model or level is no longer listed, recommend its closest current equivalent and say so in the option's description.

| Role | Recommendation | Evidence from runs up to 2026-10-20 |
|---|---|---|
| `executor` | `opus`, high | The owner chose Opus high over the older medium default on #287, #322, the video runs and the data-table-filter run. |
| `bugs` | Codex `gpt-6.1-sol`, xhigh | The owner's pick on the data-table-filter run: about 3.5 minutes per reviewer on a 26-file diff, and both reviewers raised the same finding in round 1. Nearest alternative: `gpt-6-astra` at max, used on #287, #322, #356 and #357. It stopped twice with "Selected model is at capacity" on #357. |
| `quality` | Codex `gpt-6.1-sol`, xhigh | Same as `bugs`. |
| `simplify` | `opus`, xhigh | Used on #287, #356, #357 and the video runs. Simplify raised most findings on the second #322 run and on #356. |

## Executor start command

The executor's pane runs one of these as its command ([rex-ops.md](rex-ops.md#executor)), with the absolute CLI paths you logged at preflight:

- Claude Code: `<claude path> --model <model> --effort <level> --permission-mode auto --add-dir <run dir>`
- Codex: `<codex path> -m <model> -c 'model_reasoning_effort="<level>"' -a never -s workspace-write --add-dir <run dir> --no-alt-screen`

Why these flags:

- **No approval prompts.** `--permission-mode auto` and `-a never` keep an approval prompt from stopping the run while nobody watches. Under `-a never`, a blocked command fails back to the model. When a permission classifier refuses `-a never`, recommend a Claude Code executor, since a Codex executor without it stops at every approval.
- **Run directory access.** `--add-dir` lets the executor read its tickets and write its report in the run directory, outside the worktree.
- **Codex in the main screen.** `--no-alt-screen` keeps Codex's replies in the scrollback, where a pane read finds them.

## Reviewer commands

Each reviewer's `command` in a round's spec ([rex-ops.md](rex-ops.md#rounds)) is one of these argument lists. Use the absolute CLI paths you logged at preflight. A pane starts with the login shell's environment but not its interactive config, so a PATH entry such as `~/.local/bin` can be missing there. On 2026-10-20 that left `claude` unfound in a pane.

Codex, for `bugs` and `quality`:

```json
["<codex path>", "exec", "-m", "<model>", "-c", "model_reasoning_effort=<level>", "-s", "read-only",
 "-o", "<report path>", "$<pass skill> Read the review brief at <brief path> and follow it."]
```

Claude Code, for `simplify`, and for `bugs` or `quality` when the user picks a Claude model. Its reviewer entry sets `"tee": true`:

```json
["<claude path>", "-p", "/<pass skill> Read the review brief at <brief path> and follow it. Report findings only.",
 "--model", "<model>", "--effort", "<level>", "--permission-mode", "auto",
 "--disallowedTools", "Edit,Write,NotebookEdit", "--add-dir", "<run dir>"]
```

Before the first executor and the first round, confirm each flag in `codex --help`, `codex exec --help` and `claude --help`. When a flag is renamed or gone, use the flag the help now gives for the same capability, and log the substitution in `RUN-LOG.md`. `model_reasoning_effort` is a config key, so the Codex help shows only the generic `-c key=value`.

Why these arguments:

- **The pass skill comes first.** `$<skill>` as the first word of a `codex exec` prompt loads that skill, and `/<skill>` does the same for `claude -p`. Rex passes the `$` to the program unexpanded. The brief repeats each skill's `SKILL.md` path as a fallback.
- **The prompt follows `-p` directly.** `--add-dir` and `--disallowedTools` take lists, so a prompt after them is read as one more directory or tool, and `claude -p` then fails with "Input must be provided".
- **The CLI writes the report.** `codex exec -o` writes the final message after the sandboxed run. `claude -p` prints only its final message on stdout, and `"tee": true` copies that into the report.
- **Codex runs read-only.** `-s read-only` is a sandbox, and exec mode never stops for approval, so no `-a never` is needed. A permission classifier may refuse `-a never`, which this avoids. Codex also has no network or forge CLI there, so the brief carries any PR metadata.
- **Claude Code keeps Bash.** `--disallowedTools` removes the edit tools but leaves Bash, which can still write. The brief states the read-only contract, and the snapshot around every round is the check that holds for both CLIs. `--permission-mode auto` settles permission checks, since a `-p` run has nobody to answer a prompt, and `--add-dir` lets it read the brief in the run directory.
- **`/simplify` applies its fixes by default.** "Report findings only" in the prompt and the brief keep it to findings.
- **`--approve-for-me` stays off.** It routes Codex approvals through the workspace-write sandbox, so a reviewer could write.
