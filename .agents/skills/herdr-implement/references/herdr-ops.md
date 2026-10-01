# Herdr operations

`herdr --help`, and the guide its agent note points to, are the authority for commands, flags and agent states. This file holds only what they leave out: how Claude Code and Codex behave inside Herdr, and the patterns the loop relies on.

## Addressing agents

Address every agent by the pane ID you logged when you started it. Claude Code's `/clear` starts a new session, which drops the Herdr agent name, so a role name stops resolving after the first fresh context.

When a pane's state looks wrong, `herdr agent explain <pane> --verbose` shows the rule that matched.

## Starting

- A shell update prompt (oh-my-zsh) can swallow the first characters of `agent start`. Read the pane and rerun.
- A start that times out while the agent is running: name it with `herdr agent rename`.

## Fresh context

Every new task (a ticket or a review) starts from a fresh context. Follow-ups within a task (a nudge, a request to repeat findings, an answer, the read-only reminder) go to the live context.

- Claude Code: submit `/clear`.
- Codex: submit `/new`. It can open a picker (current checkout or new worktree) that swallows the next prompt. Read the pane, send the `enter` key to keep the current checkout, and read again until the input box shows.

`/clear` and `/new` start no turn, so submit them without `--wait`, which would return `agent_prompt_stalled`. Before dispatching, read the pane and confirm the input box is empty. Claude Code shows dim ghost-suggestion text there; a read with `--format ansi` tells it apart from typed text by its `ESC[2m` dim code.

## Pass skills

- Dispatch a review to a Claude Code reviewer with its pass skill typed first: `/<pass skill> <dispatch text>`. A typed skill runs even when its model invocation is disabled, and it starts a turn like any prompt. A Codex reviewer gets the dispatch text alone, and the prompt file names its skill.
- A skill with `disable-model-invocation: true` is missing from a Claude Code agent's own skill list. When a Claude Code agent reports a pass skill missing, look for its `SKILL.md` in the user and project skill directories: one there is available, only hidden from the agent's list.

## Dispatching

- Long prompts live in a file in the run directory. Send `Implement <absolute path>.` or `Read and follow <absolute path>.`
- After any task prompt, confirm the agent reaches `working` within about 15 seconds. When it stays idle, read the pane before resending. A stalled or timed-out prompt may still have been delivered, so resend only when the text never reached the agent.
- Several agents in parallel: submit each prompt without `--wait`, then wait on each one.

## Waiting

Run every long wait in the background so you stay responsive.

- A report file: loop every 30 seconds until the file exists or `herdr agent get` shows the agent `blocked`, and read the pane when it is blocked. Agent status alone does not mark the end: `agent prompt --wait` often returns `timeout` or `done` early.
- A reviewer that replies in chat: `herdr agent wait <pane> --until working`, then a plain `herdr agent wait <pane>`. A plain wait on an agent that has not started working returns at once.
- An agent that backgrounds a long command goes `idle` before it reports. Wait for it the same way, or nudge it.

## Reading

Output in alt-screen mode can be only partly readable through `agent read`. That is why every executor reports through a file and every reviewer ends its reply with the line `END-OF-FINDINGS`. A read without that line is incomplete. Read more lines, and when the end is still missing, ask the reviewer to repeat only its findings list.

## Blocked agents

`agent prompt` refuses a `blocked` agent. Read the visible pane, then decide:

- a question inside the task is yours to answer, in place of the guide's ask-the-user default;
- an approval or trust prompt is the user's. A reviewer asking to leave its sandbox gets `esc` and the read-only instruction again.

## Interrupting

Send one `esc`, read the pane, and send a second only while the turn is still running: on an idle prompt, a second `esc` opens Claude Code's rewind view or Codex's backtrack. Before redispatching, confirm the empty input box, check the worktree, and kill any command the agent left hanging.

## Shell

Some shells alias `rm` to interactive mode, which hangs a script. Scripts use `command rm -f`.
