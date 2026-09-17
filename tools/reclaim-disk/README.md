# reclaim-disk

Reclaims disk space from two things that grow without bound and are never
collected: Turbo's local build cache, and abandoned agent worktrees.

Dry run by default. Nothing is deleted without `--apply`.

```bash
reclaim-disk                      # report only
reclaim-disk --apply              # act on the report, after confirming
reclaim-disk --apply --yes        # skip the confirmation (required in scripts)
reclaim-disk --age 30 --apply     # keep the last 30 days of turbo cache
reclaim-disk --only turbo         # caches only
reclaim-disk --help
```

On a terminal the scan repaints a single status line as directories are found
and measured, and `--apply` asks for confirmation before deleting. Piped or in
CI it emits neither — output is the report alone, with no escape sequences —
and `--apply` without `--yes` refuses rather than deleting unattended.

## Why it is shaped this way

Turbo never evicts its local cache. A monorepo built daily for a year will
carry hundreds of gigabytes of `.tar.zst` artifacts, each one reproducible by
rebuilding. Agent worktrees are worse: each is a full checkout with its own
`node_modules`, abandoned the moment its subagent exits.

Both are safe to delete *in general* and dangerous to delete *blindly*, because
an abandoned worktree occasionally holds the only copy of something. The tool
is built around that distinction.

## Safety

A worktree is classified from `git status --porcelain` into one of three
states, and the action follows from the state:

| State | Meaning | Action |
| --- | --- | --- |
| `Clean` | Nothing to lose | Delete |
| `UntrackedOnly` | Holds files git never recorded | Archive to `~/.reclaim-disk-archives`, then delete |
| `TrackedDirty` | Holds edits to committed files | **Keep** — reported, never touched |

The archive is verified non-empty before the worktree is removed, so a failed
`tar` leaves the worktree intact rather than destroying the only copy.

After deleting worktrees, `git worktree prune` runs in each repository so the
parent does not accumulate registrations pointing at directories that no longer
exist.

## Structure

The layout follows the repo coding standards: a pure functional core, an
application service that sequences effects through narrow ports, and a single
adapter holding every subprocess call.

```
src/
  domain/               pure, no I/O
    kilobytes.ts        branded size type, parsing, formatting
    worktree.ts         WorktreeState + Disposition - the safety rules
    plan.ts             targets, plan construction, totals
  ports.ts              DiskInventory (read), DiskMutator (write), ScanProgress (report)
  reclaim.ts            the application service: survey / apply
  adapters/
    bun-disk.ts         the tree walk, du, df, git, tar
    terminal-progress.ts  the status line, and the silent implementations
  cli.ts                flags, confirmation, report rendering
  main.ts               composition root
```

The port split is load-bearing rather than decorative. `survey` requires only
`DiskInventory`, so its type proves it cannot delete anything — a dry run is
the absence of a capability, not a flag checked at each deletion site.

`ScanProgress` sits beside the inventory rather than inside the application
service, because the waiting happens in the adapter. Its methods return
`Effect<void>` with no error channel and no capability, so reporting can never
fail a scan or widen an error union — and `reclaim.ts` needed no change at all
to gain progress output.

Subprocesses are invoked with an argv array and never through a shell, so a
directory containing a space or a quote cannot change what runs.

## Why the tree walk is in process

Scanning used to spawn `find`. It was replaced with a `readdir` walk for two
reasons, the second mattering more than the first:

1. It is much faster here — a full run went from **122 s to 6.9 s**, because
   the walk parallelises where one `find` process serialised.
2. `find` prints matches as it goes, but the output was read with a single
   await on the whole stream, so nothing could be displayed until the process
   exited. Removing the pipe is what makes incremental reporting possible.

The walk skips `node_modules` and `.git` (see `PRUNED_DIRECTORIES`). That is a
real behaviour change: a vendored package shipping a populated `.turbo/cache`
would now be missed. It was verified against this machine's tree that pruning
returns an identical cache list.

## Development

```bash
cd ~/.dotfiles/tools/reclaim-disk
bun install
bun run typecheck
bun test
bun run src/main.ts --help
```

Tests cover the pure core — the state classifier, the deletion policy, and
plan construction — through their real public functions, with no module mocks.
