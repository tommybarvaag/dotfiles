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

Both are safe to delete _in general_ and dangerous to delete _blindly_, because
an abandoned worktree occasionally holds the only copy of something. The tool
is built around that distinction.

## Safety

A worktree is classified from `git status --porcelain -z --ignored=matching`
into one of four states, and the action follows from the state:

| State           | Meaning                        | Action                                             |
| --------------- | ------------------------------ | -------------------------------------------------- |
| `Clean`         | Git recorded everything in it  | Delete                                             |
| `IgnoredOnly`   | Holds only ignored paths       | Archive the irreplaceable ones, then delete        |
| `UntrackedOnly` | Holds files git never recorded | Archive to `~/.reclaim-disk-archives`, then delete |
| `TrackedDirty`  | Holds edits to committed files | **Keep** — reported, never touched                 |

The archive is read back and every planned path accounted for before the
worktree is removed, so a failed `tar` leaves the worktree intact rather than
destroying the only copy. Contents, not size: a clean exit code does not mean
`tar` archived anything, and a byte count cannot tell a partial archive from a
complete one — a gzipped empty tar is 29 bytes, not zero.

The file list reaches `tar` on stdin, NUL-delimited, rather than in argv. `tar`
reads an argv operand beginning with `@` as _read entries from this archive and
add them to the output_, and `--` does not turn that off; it stops option
parsing only. An untracked file called `@backup.tar` was therefore never
archived, and when the name beside it happened to be a readable archive, `tar`
exited 0 having quietly skipped it — a non-empty archive, a passing size check,
and a worktree deleted with the only copy of that file inside it. Feeding the
names on stdin removes the interpretation entirely, and removes the argv-length
ceiling on how many untracked files a worktree may hold. Both halves are tested
against a real `tar` and a real worktree — see [Tests](#tests).

### Ignored paths are the fourth state, not the absence of one

`git status --porcelain` does not list ignored files. Without `--ignored` a
worktree holding nothing but a gitignored `.env` produces no records at all,
classifies as `Clean`, and is deleted with no archive and no mention in the
report — which is precisely the loss this tool exists to prevent, on precisely
the files agents write: `.env`, `.env.local`, `.claude/settings.local.json`,
local dev databases. The union was total over what it was shown; it was the
_input_ that dropped a whole category before the classifier ever ran.

So the status is read with `--ignored=matching`, and ignored paths are carried
into the state. They cannot be archived wholesale — a worktree's
`node_modules` is gigabytes of it — so the split is by name, in `plan.ts`,
where every other policy lives: a path with a segment in `REGENERABLE`
(`node_modules`, `dist`, `build`, `target`, `.next`, `.turbo`) is something a
rebuild puts back and is dropped; everything else joins the untracked files in
the archive. A worktree whose only content is regenerable is still deleted
outright, and one holding an ignored `.env` is not.

### A refusal is about one entry, not the run

Everything `apply` can be stopped by is a fact about a single entry: the
worktree was written into since the survey, `tar` could not write the archive,
`rm` was denied. None of them says anything about the entries behind it — all
of which were confirmed in the same breath — so none of them ends the run. Each
becomes a line naming the path and the reason, the rest of the plan is carried
out, and the run comes back with an `Outcome` either way. The process still
exits non-zero when anything was refused.

One of those three is not like the others, and the report says so. `rm -r`
unlinks depth-first, so a removal denied partway through — a cache whose
`.turbo` parent is read-only, say — leaves everything it had already unlinked
gone. Calling that `refused:` would tell the user the target is intact when it
is not, so the outcome carries what survived (`Untouched` or
`PartiallyRemoved`) alongside the reason, and the line reads `partially
removed:` instead. Every impediment states which it is, case by case, so a new
one cannot inherit the reassuring wording by default.

That matters most for the archives. An `ArchiveThenDelete` entry moves the only
copy of a worktree's files into a tarball and then deletes the worktree, so the
archive's path — printed from the outcome — is the user's only pointer to them.
A run that abandoned the outcome to propagate one entry's failure would destroy
files and then throw away the receipt.

The status is read with `-z`. Without it git applies C-style quoting to any
path holding a space, a quote, a backslash or a non-ASCII byte, so `notes æ.md`
arrives as `"notes \303\246.md"` — a name `tar` cannot stat. `-z` turns quoting
off and terminates each record with a NUL, so the bytes git printed are the
bytes the archive is built from.

### A worktree is parsed, not assumed

The worktree scan finds candidates by position — two levels under the worktree
root — and position is a bound on the search, not evidence about anything. A
standalone clone, a main checkout, or a stray directory inside whatever
repository the worktree root happens to sit in all answer `git status` and
`git rev-parse` perfectly well, because `git -C` searches upward; a clone even
answers "clean", while holding the only copy of its own object database.

So being a linked worktree of a named repository is established rather than
assumed, by one `git rev-parse --path-format=absolute --git-dir
--git-common-dir --show-toplevel`: the work tree's root must be the candidate
itself (not some ancestor's), and the candidate's own git directory must differ
from the shared one (a linked worktree keeps its own under the repository's).
Anything else is reported under _Left alone_ as `not a linked worktree`. That
one check is also what keeps `git worktree prune` from being aimed at a
repository the user never pointed the tool at.

The state is re-read immediately before the irreversible delete, and the
worktree is left alone if it no longer matches what the plan was built from.
The survey reads `git status` before the confirmation prompt, and the prompt
waits as long as you do — while the agent this worktree belongs to may still be
writing into it. The re-check can only refuse an entry; it never adds one, never
re-decides anything, and never stops the entries behind it.

After deleting worktrees, `git worktree prune` runs so the parent does not
accumulate registrations pointing at directories that no longer exist. The
repositories are derived from the worktrees being removed — a worktree names
its own repository, via `git rev-parse --git-common-dir` — so the set is exactly
the repositories losing a registration, and the report lists them by name
before you are asked to confirm. A repository that owns nothing in the plan is
never touched, and one whose worktree was refused is not pruned: the same
function derives the reported set from the planned entries and the pruned set
from the entries that actually went, so the second is a subset of the first by
construction.

## The plan is authoritative

Everything `apply` does is a disposition in the plan that was printed: it takes
the plan and nothing else, and switches on the disposition alone. That matters
most for `--age`. The day count is resolved into a cutoff _instant_ once, at
the command line, and that one instant is what selects the entries to measure,
what the report prints, and what `find` is given when they are deleted. A run
left sitting at the confirmation prompt across midnight therefore deletes
exactly the entries it showed, rather than re-deriving a fresh cutoff on the
way out.

The cutoff is rendered once, as `YYYY-MM-DD HH:MM:SS +0000`, and that rendering
is both what the report prints and what `-newermt` is handed. The time and the
offset are load-bearing: `find` accepts a bare date but reads it as _local_
midnight, so a cutoff truncated to its day is enforced hours from the instant
that was resolved — earlier east of UTC, and later west of it, where the run
would delete entries the report said it would keep.

`--age` must be a whole number of days of at least 1, rejected at the flag
otherwise. A negative age would resolve to a cutoff in the future, which every
entry predates — the run would empty the whole cache under a report promising
stale entries only.

## Structure

The layout follows the repo coding standards: a pure functional core, an
application service that sequences effects through narrow ports, and a single
adapter holding every subprocess call.

```
src/
  domain/               pure, no I/O
    kilobytes.ts        branded size type, parsing, formatting
    cutoff.ts           --age parsed to a positive whole number of days, resolved to an instant
    worktree.ts         WorktreeState - what a working tree holds, ignored paths included
    plan.ts             targets, dispositions, what is regenerable, plan construction, totals
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
the absence of a capability, not a flag checked at each deletion site. Its
requirements are written out rather than inferred, so reaching for
`DiskMutator` anywhere inside it stops compiling.

The safety rules sit either side of that line: `worktree.ts` says what a
working tree holds — untracked and ignored paths carried as facts, with no
judgement about either — and `plan.ts` decides what may be done about it. A
worktree is deleted outright only when nothing it holds would be lost,
`UntrackedOnly` is archived first, and `TrackedDirty` is never touched.

`ScanProgress` sits beside the inventory rather than inside the application
service, because the waiting happens in the adapter. Its methods return
`Effect<void>` with no error channel and no capability, so reporting can never
fail a scan or widen an error union — and `reclaim.ts` needed no change at all
to gain progress output.

Subprocesses are invoked with an argv array and never through a shell, so a
directory containing a space or a quote cannot change what runs. Argv arrays
only protect the way _in_, though: a path also has to survive the way _out_,
which is why the status is read with `-z` rather than unquoted afterwards.

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

Both finders are that one walk, driven by a `Search`: a root, a depth limit,
and a rule deciding whether a directory is a result. Pruning is consulted only
after that rule, so a search can never be defeated by a name it is itself
looking for. Matches are reported as they are found, and a match is exactly
what the finder returns: the cache scan matches `cache` inside `.turbo` rather
than reporting every `.turbo` and filtering afterwards. A search returns the
directories it could not read alongside the ones it matched, so a skipped
directory has the same reporting channel as everything else that cannot be
established.

Concurrency is one number for the whole traversal, not one per level. The bound
is a semaphore held around each `readdir` while the per-level walk is unbounded,
because bounding each level instead bounds nothing: every level descends into
another bounded level and the limits compound. Sixteen siblings at a time, five
levels deep, is a million listings in flight rather than sixteen.

There is no third finder any more. Pruning worktree registrations used to walk
`~/src` again looking for `.git` directories, which found a _superset_ of the
repositories involved; a worktree names its own repository, so the walk was
deleted along with the port method behind it.

## A failed command is never an empty result

Subprocesses return a tagged outcome — stdout on success, or a single `reason`
folding together stderr and the exit code — so there is no stdout to read
without having handled failure first. `du` failing on a directory it cannot
read is reported as `SizeUnavailable` naming that directory, rather than
summing to 0 KB and quietly dropping out of the report. The one case where
empty output is a real answer is a _successful_ `find` that matched no stale
entry, which totals zero.

That failure is per directory, not per run. A target that cannot be measured or
classified becomes an entry in the plan — shown under _Left alone_ with the
reason, and excluded from `reclaiming` by its type rather than by a check — so
one stray directory under the worktree root, which is what a crashed agent
leaves behind, no longer takes the whole report down with it.

The walk answers the same way. A `readdir` that fails is classified rather than
swallowed: `EACCES`/`EPERM` and a directory that vanished mid-walk come back
alongside the matches and are reported as _Left alone_ rows, while anything the
machine could not answer at all — out of descriptors, out of memory, an I/O
error — ends the scan, because nothing about such a scan is trustworthy. The
tool used to have three answers to "could not read this" and one of them was
silence: an unreadable directory between the root and a cache hid that cache
with no row, no reason, and exit 0.

A scan root that does not exist is the one exception, and it is not a failure at
all. Both roots are _defaulted_, so on a machine where the agent tooling has
never run, `~/.grok/worktrees` is simply absent — a fact about the machine, not
a broken request. That category reports nothing and the other category's report
still prints. A root that exists and cannot be read is still a `ScanFailed`.

## Every expected failure is one line and an exit code

Nothing escapes to the runtime as a cause dump. `ScanFailed` and
`SizeUnavailable` are caught at the command, rendered from the fields they were
built to carry, and printed as a single `error: …` sentence on **stderr** — so a
pipe still holds the report alone:

```
error: could not scan /Users/me/src looking for build caches: EACCES: permission denied
```

Each error class renders its own message, so the path and the operation reach
the first line instead of being buried in a nested `[cause]`. Anything that
stops the run then becomes a `CommandFailed` carrying the runtime's
already-reported marker: the process exits non-zero and the user is not shown a
second, uglier copy of what they have just read.

`--apply` with nothing to ask is one of those. Confirmation has three outcomes,
not two — confirmed, declined, and _no terminal to ask_ — and collapsing the
last two into `false` meant a scheduled `--apply` that had never passed `--yes`
reclaimed nothing and reported success. Declining is a choice and exits 0;
having nobody to ask exits non-zero, for the same reason a partly-carried-out
plan does.

## Development

```bash
cd ~/.dotfiles/tools/reclaim-disk
bun install
bun run format     # prettier --write, the whole package
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun test
bun run src/main.ts --help
```

Prettier and oxlint are scoped to this package — `.prettierrc.json` and
`.oxlintrc.json` live here, not at the root of the dotfiles repo, so nothing
else is reformatted. Prettier owns layout; oxlint runs the `correctness`,
`suspicious`, `perf` and `pedantic` categories, and on top of those bans `any`
and `!` and requires `import type` for type-only imports. The handful of rules
turned off are the ones that contradict the repo coding standards — `_tag`
discriminants, one error family per module, no arbitrary size limits — each
with its reason written next to it in `.oxlintrc.json`.

`src/main.ts` is executable and carries a `#!/usr/bin/env bun` shebang, which
is what lets `install.sh` install it as a bare symlink at
`~/.local/bin/reclaim-disk` with no wrapper script in between. Keep the mode
bit: without it the installed command fails with `permission denied`.

## Tests

Everything runs against real seams: real temporary directories, real git
repositories with real commits and real worktrees, real subprocesses. There are
no module mocks anywhere — no `vi.mock`, no `jest.mock`, no substitute mutator,
because a substitute cannot fail the way a filesystem does.

The pure core is covered through its public functions — the state classifier,
the deletion policy, age parsing and cutoff resolution, plan construction, and
the progress renderer — and `DiskInventoryLive` against a temporary tree: what
the walk finds, what it refuses to descend into, what `du` measures, that a
directory it cannot measure is reported as `SizeUnavailable` rather than summed
as zero, and that stale entries are selected on the cutoff _instant_ rather
than the calendar day it falls on.

The destructive half — `survey` and `apply` over the live inventory and the
live mutator — is covered in `test/reclaim.test.ts`, which asserts what survived
rather than what was called:

- a survey that plans two deletions leaves every file on disk untouched;
- an untracked-only worktree is removed only after an archive that really holds
  its files — including one named `notes æ.md` and one named `a b.txt`, which
  is the shape that breaks if the status is ever read without `-z`;
- a worktree written into between the survey and the delete is refused, with
  the new file still there afterwards — and the entries behind the refusal are
  still carried out, their archive paths still reported, and the repository
  that lost a worktree still pruned;
- a worktree holding only a gitignored `.env` is archived before it is removed,
  while one holding only a gitignored `node_modules` is deleted without one;
- a standalone clone sitting at worktree depth, and a stray directory inside an
  enclosing repository, are each reported as `not a linked worktree` and
  survive an `--apply` that deletes the real worktree beside them;
- a directory that cannot be measured, and a stray non-git directory under the
  worktree root, are each reported while the rest of the plan still comes back;
- only the repository that owned the removed worktree is pruned: a bystander
  repository holding a prunable registration keeps it;
- an archive that fails for a reason the filesystem produced — a destination
  that cannot be written — leaves the worktree and its only copy intact, and is
  reported as a refusal rather than ending the run;
- an archive that does not hold what was planned — `tar` writing into
  `/dev/null`, so it exits 0 with nothing in it — is refused by name, and again
  the worktree survives;
- an untracked file called `@backup.tar`, beside a real `backup.tar`, is really
  in the archive afterwards: the shape that used to be dropped in silence while
  `tar` exited 0 and the worktree was deleted;
- a removal denied partway through — a cache whose `.turbo` parent is read-only
  — is reported as `partially removed`, and the entries really are gone;
- a worktree holding modified tracked files is kept while its clean sibling is
  deleted in the same run;
- `--only turbo` removes the cache and leaves worktrees and their registrations
  alone;
- a pruned cache loses exactly the entries the survey measured.

The command line is covered in `test/cli.test.ts` by spawning the real
entrypoint with stdin closed, which is the only way to assert what a user and a
shell actually get:

- a scan root that was never created reports the other category and exits 0;
- a scan root that exists and cannot be read prints one `error:` line on stderr
  — one line, not a cause block — and exits 1;
- `--apply` with nobody to ask refuses and exits non-zero;
- a target left half-removed prints `partially removed:`, never `refused:`.

`DiskInventoryLive` additionally covers the walk's answers to an unreadable
directory: one it cannot descend into comes back as a reported skip beside the
matches, a root that does not exist yields nothing, and a root that exists and
cannot be read is a `ScanFailed` naming it.

Two seams make that possible without a mock. The mutator is built with the
directory it archives into (`makeDiskMutator`), so a test run writes into its
own tree instead of `~/.reclaim-disk-archives`; and the archive's name is
stamped from the runtime's clock, the same clock the command line resolves
`--age` against, so stopping it tells a test which file a run is about to write
before it writes it.
