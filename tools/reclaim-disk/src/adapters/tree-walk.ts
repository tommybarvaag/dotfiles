/**
 * The in-process directory walk every finder is built on.
 *
 * One bounded traversal, driven by a `Search`: its roots, a depth limit, and a
 * rule deciding whether a directory is a result. Roots are resolved to their
 * physical paths and deduplicated here and nowhere else, a listing that fails
 * is classified rather than swallowed, and matches are reported to the
 * progress port the instant they are found. Nothing here spawns a process.
 */
import { Effect, Option, Semaphore } from "effect";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorCodeOf, messageOf, ScanFailed } from "../errors.ts";
import type { ScanProgress, SearchResult } from "../ports.ts";

/** A dependency tree, which holds no build cache this tool owns. */
const NODE_MODULES = "node_modules";

/** A repository's git database. */
const GIT_DIRECTORY = ".git";

/**
 * Directory names the scans never descend into.
 *
 * A dependency tree holds hundreds of thousands of directories and no build
 * cache this tool owns, so walking it dominated the scan while contributing
 * nothing. A repository's git database holds neither a cache nor a worktree.
 * Exported so the exclusion is reviewable rather than buried.
 *
 * The trade-off: a vendored package shipping a populated `.turbo/cache` would
 * now be missed. That has not been observed, and the cost of looking is the
 * whole latency problem.
 */
export const PRUNED_DIRECTORIES: ReadonlySet<string> = new Set([NODE_MODULES, GIT_DIRECTORY]);

/** Depth limit meaning "no limit". */
export const UNBOUNDED_DEPTH = Number.MAX_SAFE_INTEGER;

/**
 * How many directories the walk lists at once, across the whole traversal.
 *
 * One number, not one per level: the bound is a semaphore held around each
 * `readdir`, and the per-level `forEach` is unbounded. Bounding each level
 * instead would bound nothing, because every level descends into another
 * bounded `forEach` and the limits compound - 16 siblings at a time, five
 * levels deep, is a million listings in flight rather than sixteen.
 */
const WALK_CONCURRENCY = 16;

/** A search that established nothing: no matches, nothing skipped. */
const NOTHING_FOUND: SearchResult = { matches: [], skipped: [] };

/** A directory the walk reached, offered to a search's match rule. */
export type Candidate = {
  /** The directory's own name. */
  readonly name: string;
  /** Absolute path of the directory holding it. */
  readonly parent: string;
  /** Its depth beneath the search root, counting the root's children as 1. */
  readonly depth: number;
};

/**
 * One directory search.
 *
 * Both finders are the same traversal — collect the directories a rule picks
 * out, never descend into one that was picked, and stop at a depth — so what
 * differs between them is data rather than two functions.
 */
type Search = {
  /**
   * The directories to search, as the caller spelled them.
   *
   * Each is resolved to its physical path, and roots that resolve to the same
   * one are walked once, so every match is named physically however its root
   * was spelled - which is what lets two spellings of one cache, or a cache
   * and the worktree holding it, be recognised as the same path.
   */
  readonly roots: ReadonlyArray<string>;
  /** What is being looked for, in human terms, for progress and failures. */
  readonly lookingFor: string;
  /** Deepest level a match may be found at, counting the root's children as 1. Never below 1. */
  readonly maxDepth: number;
  /** Whether a directory is a result. A match is collected and never descended into. */
  readonly matches: (candidate: Candidate) => boolean;
};

/**
 * Why a directory could not be listed, classified by what the walk should do.
 *
 * - `Absent` - there is no directory there. At a root that means the category
 *   is simply empty on this machine; deeper it means something moved while the
 *   walk was running.
 * - `Denied` - it is there and this process may not read it. An unprivileged
 *   sweep of a home directory always hits some.
 * - `Unusable` - the machine could not answer at all: out of descriptors, out
 *   of memory, an I/O error. Nothing about such a scan is trustworthy, so it is
 *   the one classification that ends the search rather than annotating it.
 */
type ListingFailure = {
  /** Which of the three kinds of failure this is. */
  readonly _tag: "Absent" | "Denied" | "Unusable";
  /** The underlying failure message. */
  readonly reason: string;
};

/** Error codes meaning there is no directory at that path to list. */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** Error codes meaning the directory is there and unreadable by this process. */
const DENIED_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/**
 * Classify a failed directory listing.
 *
 * @param cause - The value `readdir` rejected with.
 * @returns What kind of failure it was, and its message.
 */
function classifyListingFailure(cause: unknown): ListingFailure {
  const reason = messageOf(cause);
  const code = errorCodeOf(cause);

  if (ABSENT_CODES.has(code)) {
    return { _tag: "Absent", reason };
  }

  if (DENIED_CODES.has(code)) {
    return { _tag: "Denied", reason };
  }

  return { _tag: "Unusable", reason };
}

/** A search root, by the caller's spelling and by its physical path. */
type Root = {
  /** As the caller gave it, which is what a failure names. */
  readonly spelled: string;
  /** With every symlink taken out, which is what is walked. */
  readonly physical: string;
};

/**
 * Decide what a search root that could not be read means for the search.
 *
 * A root that does not exist holds nothing, because every root is defaulted
 * and a machine may simply never have made one. Any other failure means the
 * search could not be answered, and fails it.
 *
 * @template A - What the search produces when the root holds nothing.
 * @param root - The root as the caller spelled it.
 * @param lookingFor - What was being looked for beneath it.
 * @param failure - Why the root could not be read.
 * @param nothing - The answer for a root that does not exist.
 * @returns That answer, or the failed scan.
 */
function rootFailure<A>(
  root: string,
  lookingFor: string,
  failure: ListingFailure,
  nothing: A,
): Effect.Effect<A, ScanFailed> {
  return failure._tag === "Absent"
    ? Effect.succeed(nothing)
    : Effect.fail(new ScanFailed({ root, lookingFor, cause: failure.reason }));
}

/**
 * Resolve every root of a search to its physical path, once each.
 *
 * The one place a search root is canonicalised, so no finder can skip it:
 * `/tmp` and `/private/tmp`, or a symlink and its target, are one root and are
 * walked once. The first spelling of each is kept for failures to name.
 *
 * @param roots - The roots as the caller spelled them.
 * @param lookingFor - What the search is looking for, for a failure to name.
 * @returns Each distinct physical root that exists, with how it was spelled.
 */
function resolveRoots(
  roots: ReadonlyArray<string>,
  lookingFor: string,
): Effect.Effect<ReadonlyArray<Root>, ScanFailed> {
  return Effect.map(
    Effect.forEach(roots, (spelled) =>
      Effect.matchEffect(
        Effect.tryPromise({ try: () => realpath(spelled), catch: classifyListingFailure }),
        {
          onFailure: (failure) => rootFailure(spelled, lookingFor, failure, Option.none<Root>()),
          onSuccess: (physical) => Effect.succeed(Option.some<Root>({ spelled, physical })),
        },
      ),
    ),
    (resolved) => {
      const distinct = new Map<string, Root>();

      for (const root of resolved) {
        if (Option.isSome(root) && !distinct.has(root.value.physical)) {
          distinct.set(root.value.physical, root.value);
        }
      }

      return [...distinct.values()];
    },
  );
}

/**
 * Combine the results of searching several subtrees.
 *
 * @param results - One result per subtree.
 * @returns Every match and every skipped directory, in encounter order.
 */
function mergeResults(results: ReadonlyArray<SearchResult>): SearchResult {
  return {
    matches: results.flatMap((result) => result.matches),
    skipped: results.flatMap((result) => result.skipped),
  };
}

/**
 * Walk a tree in process, reporting each match the instant it is found.
 *
 * Replaces a spawned `find`. The subprocess was not merely slower: its output
 * was read with a single await on the whole stream, so matches it had already
 * printed could not be shown until it exited. Walking in process removes the
 * pipe, which is what makes incremental reporting possible at all.
 *
 * Semantics deliberately match `find(1)` as it was invoked before:
 * - a matched directory is not descended into, as `-prune` did;
 * - symlinks are not followed, as the absence of `-L` did, so no cycle guard
 *   is needed.
 *
 * An unreadable subdirectory does not end the scan, but it does not disappear
 * either: it comes back under `skipped`, which the survey turns into a reported
 * row like any other directory it could not establish anything about.
 *
 * A root that does not exist yields nothing rather than failing. Every root is
 * defaulted, so "the caller was asked to scan somewhere that does not exist" is
 * usually "this machine has never run an agent" - and that must not take the
 * other category's report down with it. A root that exists and cannot be read
 * is still a `ScanFailed` naming the root as the caller spelled it, as is any
 * listing the machine could not answer.
 *
 * Several roots are one search: they are resolved and deduplicated first, the
 * progress line is told once, so its counts run across all of them, and one
 * concurrency bound covers the lot. Roots may still nest - `~/.t3` holds
 * `~/.t3/worktrees` - so a directory reached from a second root is neither
 * reported nor returned again.
 *
 * @param progress - Where each match is reported as it is discovered.
 * @param search - What to look for, where, and how deep.
 * @returns Every matching path, and every directory that could not be read.
 */
export function walk(
  progress: ScanProgress["Service"],
  search: Search,
): Effect.Effect<SearchResult, ScanFailed> {
  return Effect.gen(function* () {
    const roots = yield* resolveRoots(search.roots, search.lookingFor);

    yield* progress.scanning(
      search.lookingFor,
      roots.map((root) => root.physical),
    );

    // The single bound on the whole traversal. Acquired around the listing
    // only, never held across the recursion beneath it, so it cannot deadlock.
    const listings = yield* Semaphore.make(WALK_CONCURRENCY);

    // Every match and skip already reported, so a nested root cannot report
    // one twice. Checked and recorded in one synchronous step.
    const matched = new Set<string>();
    const skipped = new Set<string>();

    const list = (directory: string): Effect.Effect<ReadonlyArray<string>, ListingFailure> =>
      Semaphore.withPermit(listings)(
        Effect.tryPromise({
          try: () => childDirectories(directory),
          catch: classifyListingFailure,
        }),
      );

    function walkRoot(root: Root): Effect.Effect<SearchResult, ScanFailed> {
      const scanFailed = (cause: string): ScanFailed =>
        new ScanFailed({ root: root.spelled, lookingFor: search.lookingFor, cause });

      function descend(path: string, depth: number): Effect.Effect<SearchResult, ScanFailed> {
        return Effect.matchEffect(list(path), {
          onFailure: (failure): Effect.Effect<SearchResult, ScanFailed> => {
            if (failure._tag === "Unusable") {
              return Effect.fail(scanFailed(`${path}: ${failure.reason}`));
            }

            if (skipped.has(path)) {
              return Effect.succeed(NOTHING_FOUND);
            }

            skipped.add(path);

            return Effect.succeed({
              matches: [],
              skipped: [{ path, reason: `could not be listed: ${failure.reason}` }],
            });
          },
          onSuccess: (children) => visit(path, depth, children),
        });
      }

      function visit(
        directory: string,
        depth: number,
        children: ReadonlyArray<string>,
      ): Effect.Effect<SearchResult, ScanFailed> {
        return Effect.map(
          Effect.forEach(
            children,
            (name): Effect.Effect<SearchResult, ScanFailed> => {
              const childDepth = depth + 1;
              const path = join(directory, name);

              if (search.matches({ name, parent: directory, depth: childDepth })) {
                if (matched.has(path)) {
                  return Effect.succeed(NOTHING_FOUND);
                }

                matched.add(path);

                return Effect.as(progress.found(path), { matches: [path], skipped: [] });
              }

              // Pruning is consulted only after `matches`, so a search can never
              // be defeated by a name it is itself looking for.
              if (childDepth >= search.maxDepth || PRUNED_DIRECTORIES.has(name)) {
                return Effect.succeed(NOTHING_FOUND);
              }

              return descend(path, childDepth);
            },
            { concurrency: "unbounded" },
          ),
          mergeResults,
        );
      }

      return Effect.matchEffect(list(root.physical), {
        onFailure: (failure) =>
          rootFailure(root.spelled, search.lookingFor, failure, NOTHING_FOUND),
        onSuccess: (children) => visit(root.physical, 0, children),
      });
    }

    // One root after another, so a nested root meets what the root holding it
    // already reported, rather than racing it.
    return mergeResults(yield* Effect.forEach(roots, walkRoot));
  });
}

/**
 * List a directory's immediate subdirectories, rejecting when it cannot be read.
 *
 * `readdir` with file types reports a symlink as a link rather than a
 * directory, so filtering on `isDirectory` also excludes symlinks.
 *
 * @param directory - The directory to list.
 * @returns The subdirectory names.
 */
async function childDirectories(directory: string): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
