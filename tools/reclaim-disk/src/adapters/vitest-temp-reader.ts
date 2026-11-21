/**
 * Reads a Vitest temp candidate from the disk, for `VitestTemp` to judge.
 *
 * The answer decides whether `rm -rf` runs on the path, so every read is
 * `lstat`-first and never follows a symlink, and the reading stops as soon as
 * the domain has seen enough to rule the candidate out. Nothing here spawns a
 * process.
 */
import { Option } from "effect";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import * as VitestTemp from "../domain/vitest-temp.ts";
import { errorCodeOf } from "../errors.ts";

/**
 * Name the kind of a directory entry, without following a symlink.
 *
 * @param entry - The entry `readdir` returned with its file type.
 * @returns What it is.
 */
function kindOf(entry: Dirent): VitestTemp.EntryKind {
  if (entry.isDirectory()) {
    return "Directory";
  }

  return entry.isFile() ? "File" : "Other";
}

/**
 * List a directory's entries with their kinds.
 *
 * @param directory - The directory to list.
 * @returns Every entry and what it is.
 */
async function listKinds(directory: string): Promise<ReadonlyArray<VitestTemp.DirectoryEntry>> {
  const entries = await readdir(directory, { withFileTypes: true });

  return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
}

/**
 * Read one environment directory of a Vitest temp candidate.
 *
 * `lstat` comes first and decides what the entry is, so a symlink - to a
 * directory or anywhere else - is never listed through: it is `Other`, which
 * disqualifies the candidate. Something replaced by a non-directory between
 * the `lstat` and the listing is `Other` for the same reason.
 *
 * @param environment - The environment directory's absolute path.
 * @param name - Its name inside the candidate.
 * @returns What it is and, when it is a directory, what it holds.
 */
async function readEnvironment(
  environment: string,
  name: string,
): Promise<VitestTemp.ProjectEntry> {
  const info = await lstat(environment);

  if (!info.isDirectory()) {
    return { kind: "Other", name };
  }

  try {
    return { kind: "Directory", name, modified: info.mtime, entries: await listKinds(environment) };
  } catch (cause) {
    if (errorCodeOf(cause) === "ENOTDIR") {
      return { kind: "Other", name };
    }

    throw cause;
  }
}

/**
 * Read what is at a path without following a symlink, or learn that nothing is.
 *
 * Only `ENOENT` means nothing is there. Anything else - a denied parent, an
 * I/O error - is not an answer about the path, and rejects.
 *
 * @param path - The path to look at.
 * @returns What is there, or `None` when nothing is.
 */
async function lstatIfPresent(path: string): Promise<Option.Option<Stats>> {
  try {
    return Option.some(await lstat(path));
  } catch (cause) {
    if (errorCodeOf(cause) === "ENOENT") {
      return Option.none();
    }

    throw cause;
  }
}

/**
 * Decide what a read that found nothing at a path means, by looking again.
 *
 * `ENOENT` from a listing is not proof the candidate is gone: a dangling
 * symlink swapped in after the `lstat` fails the same way. Only `lstat` finding
 * nothing means absent; a non-directory there now is something else; and a
 * directory there now means the failure was about something beneath it.
 *
 * @param path - The candidate.
 * @param cause - The `ENOENT` the read rejected with.
 * @returns That it is gone, or that what replaced it is not Vitest's.
 */
async function lookAgain(path: string, cause: unknown): Promise<VitestTemp.Inspection> {
  const now = await lstatIfPresent(path);

  if (Option.isNone(now)) {
    return { _tag: "Absent" };
  }

  if (!now.value.isDirectory()) {
    return { _tag: "Unrecognised", reason: "not a directory" };
  }

  throw cause;
}

/**
 * Read a Vitest temp candidate and recognise it.
 *
 * Strictly in order, because the answer decides whether `rm -rf` runs on the
 * path: `lstat` says what is there, and only a directory is listed. Absent
 * means one thing only - `lstat` found nothing - since that is a run finishing
 * and removing its own directory, which is what this tool was going to do. A
 * regular file, a symlink, or a dangling one at the path is not absent: it is
 * something else, and is unrecognised. So is a candidate whose own listing
 * already holds a non-directory, before any of its subdirectories is read.
 *
 * Environments are read one at a time, and the first readable one the domain
 * rules out ends the read: evidence that it is not Vitest's is an answer, so an
 * unreadable sibling - read before or after - does not turn it into a failure.
 * A read failure rejects only when no environment disqualified the candidate,
 * and a subdirectory vanishing partway through counts as absent only if the
 * candidate itself is gone too.
 *
 * @param path - The candidate.
 * @returns When it was last written to, why it is not Vitest's, or that it is gone.
 */
export async function readCandidate(path: string): Promise<VitestTemp.Inspection> {
  const name = basename(path);
  const present = await lstatIfPresent(path);

  if (Option.isNone(present)) {
    return { _tag: "Absent" };
  }

  const info = present.value;

  // Seen only when something replaced the directory after the walk found it,
  // since the walk never yields anything but a directory.
  if (!info.isDirectory()) {
    return { _tag: "Unrecognised", reason: "not a directory" };
  }

  let children: ReadonlyArray<VitestTemp.DirectoryEntry>;

  try {
    children = await listKinds(path);
  } catch (cause) {
    switch (errorCodeOf(cause)) {
      case "ENOENT":
        return lookAgain(path, cause);

      case "ENOTDIR":
        return { _tag: "Unrecognised", reason: "not a directory" };

      default:
        throw cause;
    }
  }

  const screened = VitestTemp.screen(name, children);

  if (screened._tag === "Unrecognised") {
    return screened;
  }

  const environments: Array<VitestTemp.ProjectEntry> = [];
  let failure: Option.Option<unknown> = Option.none();

  for (const environment of screened.environments) {
    let entry: VitestTemp.ProjectEntry;

    try {
      // oxlint-disable-next-line no-await-in-loop -- One at a time on purpose: an environment that disqualifies the candidate has to be seen even when a sibling cannot be read.
      entry = await readEnvironment(join(path, environment), environment);
    } catch (cause) {
      failure = Option.orElse(failure, () => Option.some(cause));
      continue;
    }

    const evidence = VitestTemp.screenEnvironment(entry);

    if (evidence._tag === "Unrecognised") {
      return evidence;
    }

    environments.push(entry);
  }

  if (Option.isSome(failure)) {
    const cause = failure.value;

    if (errorCodeOf(cause) === "ENOENT" && Option.isNone(await lstatIfPresent(path))) {
      return { _tag: "Absent" };
    }

    throw cause;
  }

  return VitestTemp.recognise({ name, modified: info.mtime, entries: environments });
}
