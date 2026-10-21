# Running the watcher in each harness

The watcher prints one JSON snapshot per line and exits on its own at a `stop_*` action. What differs between harnesses is how you keep reading those lines.

- **Claude Code**: start `--watch` as a background Bash command (`run_in_background`) and follow its output with the Monitor tool; each new line is a snapshot to act on. When the process exits, read its last line: it holds the terminal action. Without Monitor, run `--once` every 60 seconds instead.
- **Codex**: run `--watch` in the foreground session and read lines as they arrive; the turn stays open while the watcher runs.
- **T3 Code**: when the `watch_pull_request` tool exists and the PR is on GitHub, register the PR with it for wakeups, and on each wakeup run `--once`. Otherwise follow the Claude Code pattern.

The watcher's runtime dependencies (`$SKILL/scripts/node_modules`) are installed once with `npm ci --omit=dev --prefix "$SKILL/scripts"`. A sandboxed harness without network access cannot run that install: ask the user to run it once on the host, then the watcher works inside the sandbox. Running the scripts' tests or typecheck needs the full install, `npm ci --prefix "$SKILL/scripts"`.
