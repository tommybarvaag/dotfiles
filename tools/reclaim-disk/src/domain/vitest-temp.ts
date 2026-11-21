/**
 * What a directory in a temp root has to look like to count as one Vitest
 * leaked.
 *
 * Vitest gives every project of every run a directory `<tmpdir>/<nanoid>/`,
 * writes each transformed module into `<environment>/<sha1 of its id>` beneath
 * it, and removes the directory only when the run closes cleanly. A run that is
 * killed instead - an agent's timeout, a Ctrl+C, a crashed worker - leaves it
 * behind, and with dozens of agents running tests that is a hundred gigabytes a
 * day.
 *
 * The name alone proves nothing. A temp root is shared by everything on the
 * machine, and 21 characters from the nanoid alphabet is also what
 * `cursor-agent-logs-501` and `toast-review-ha6vdvqk` are - the second one a
 * whole repository checkout. So a directory is recognised by positive evidence
 * about everything it holds, and anything the rule does not explain disqualifies
 * it: the error is always toward leaving a directory alone.
 *
 * The environment directory names are not checked. Vitest joins
 * `environment.name`, which is `ssr` for the default pool but whatever a
 * project's environment is called otherwise.
 */
/** Length of the nanoid Vitest names a project's temp directory with. */
const PROJECT_NAME_LENGTH = 21;

/** Exactly the nanoid default alphabet, at exactly its default length. */
const PROJECT_NAME = new RegExp(`^[A-Za-z0-9_-]{${PROJECT_NAME_LENGTH}}$`, "u");

/** A module file is named by the SHA-1 of the module's id, in lowercase hex. */
const MODULE_FILE_NAME = /^[0-9a-f]{40}$/u;

/**
 * What kind of filesystem entry a listing found, symlinks not followed.
 *
 * `Other` covers symlinks, sockets, and everything else: none of them is
 * anything Vitest writes, so each one disqualifies the directory holding it.
 */
export type EntryKind = "Directory" | "File" | "Other";

/** One entry a directory listing found, at any level of a candidate. */
export type DirectoryEntry = {
  /** The entry's name. */
  readonly name: string;
  /** What it is. */
  readonly kind: EntryKind;
};

/**
 * One entry directly inside a candidate directory.
 *
 * Only a directory is listed further, because a candidate holding anything
 * else is already disqualified and there is nothing more to learn by reading it.
 */
export type ProjectEntry =
  | {
      readonly kind: "Directory";
      /** The environment's name, such as `ssr`. */
      readonly name: string;
      /** When the directory last gained or lost an entry, which is when Vitest last wrote a module. */
      readonly modified: Date;
      /** What it holds. */
      readonly entries: ReadonlyArray<DirectoryEntry>;
    }
  | {
      readonly kind: "File" | "Other";
      /** The entry's name. */
      readonly name: string;
    };

/** Everything recognising a candidate needs to know about it, read in one pass. */
export type ProjectListing = {
  /** The candidate's own name. */
  readonly name: string;
  /** When the candidate itself last gained or lost an entry. */
  readonly modified: Date;
  /** What it holds. */
  readonly entries: ReadonlyArray<ProjectEntry>;
};

/** What recognising a candidate established. */
export type Recognition =
  | {
      readonly _tag: "Recognised";
      /**
       * The latest instant anything was written into it.
       *
       * Taken from the environment directories as well as the candidate: a
       * new module lands in `<id>/ssr/`, which moves the mtime of `ssr` and
       * leaves the candidate's own at the moment `ssr` was created.
       */
      readonly lastWritten: Date;
    }
  | {
      readonly _tag: "Unrecognised";
      /** The first thing about it that Vitest would not have produced. */
      readonly reason: string;
    };

/**
 * What reading one candidate from the disk established.
 *
 * Not being Vitest's is an answer rather than a failure: a survey drops such a
 * directory without a word, and only a deletion that meets one refuses it.
 */
export type Inspection =
  | Recognition
  | {
      /**
       * Nothing is there. Between a survey and the deletion that is the usual
       * fate of a directory Vitest was still using: the run finished and
       * cleaned up after itself, which is the outcome this tool wanted anyway.
       */
      readonly _tag: "Absent";
    };

/**
 * Whether a name is worth reading the directory for.
 *
 * A cheap filter on the walk, never evidence: `recognise` decides.
 *
 * @param name - A directory name directly inside a temp root.
 * @returns `true` when the name is shaped like the nanoid Vitest uses.
 */
export function isCandidateName(name: string): boolean {
  return PROJECT_NAME.test(name);
}

/** A candidate that is not Vitest's, and the first reason why. */
export type Unrecognised = Extract<Recognition, { readonly _tag: "Unrecognised" }>;

/**
 * A candidate whose own name and listing are what Vitest writes, so its
 * environment directories are worth reading.
 */
export type Candidate = {
  readonly _tag: "Candidate";
  /** The names of its environment directories: every entry it holds. */
  readonly environments: ReadonlyArray<string>;
};

/** What one readable environment directory adds to the evidence about its candidate. */
export type EnvironmentEvidence = {
  readonly _tag: "Modules";
  /** How many transformed modules it holds. */
  readonly modules: number;
  /** When it last gained or lost a module. */
  readonly lastWritten: Date;
};

/**
 * Why an entry directly inside a candidate disqualifies it.
 *
 * @param name - The entry's name.
 * @returns The candidate's verdict.
 */
function notADirectory(name: string): Unrecognised {
  return { _tag: "Unrecognised", reason: `holds ${name}, which is not a directory` };
}

/**
 * Rule a candidate out from its own name and listing, before any of its
 * subdirectories is read.
 *
 * Everything that can be known without descending is checked here, so a
 * reader can stop at the first level: a 21-character repository checkout
 * holding a `package.json` is dropped here, rather than having every one of
 * its directories listed - and an unreadable one among them reported - only
 * to be dropped afterwards.
 *
 * @param name - The candidate's own name.
 * @param entries - What it holds directly, symlinks not followed.
 * @returns Why it is not Vitest's, or the environment directories still to be read to tell.
 */
export function screen(
  name: string,
  entries: ReadonlyArray<DirectoryEntry>,
): Candidate | Unrecognised {
  if (!isCandidateName(name)) {
    return { _tag: "Unrecognised", reason: "not named like a Vitest project directory" };
  }

  const stray = entries.find((entry) => entry.kind !== "Directory");

  return stray === undefined
    ? { _tag: "Candidate", environments: entries.map((entry) => entry.name) }
    : notADirectory(stray.name);
}

/**
 * Decide what one entry of a candidate says about it, on its own.
 *
 * The rule for an environment directory: it holds only regular files named by
 * a SHA-1. One environment breaking it disqualifies the whole candidate, so a
 * reader may stop at the first that does - whatever it could or could not
 * read of the rest.
 *
 * @param entry - One entry directly inside the candidate, listed if it is a directory.
 * @returns How many modules it holds and when it was last written to, or why the candidate is not Vitest's.
 */
export function screenEnvironment(entry: ProjectEntry): EnvironmentEvidence | Unrecognised {
  if (entry.kind !== "Directory") {
    return notADirectory(entry.name);
  }

  const stray = entry.entries.find(
    (module) => module.kind !== "File" || !MODULE_FILE_NAME.test(module.name),
  );

  return stray === undefined
    ? { _tag: "Modules", modules: entry.entries.length, lastWritten: entry.modified }
    : {
        _tag: "Unrecognised",
        reason: `${entry.name}/${stray.name} is not a transformed module`,
      };
}

/**
 * Decide whether a listed directory is a Vitest project temp directory.
 *
 * Every entry has to be accounted for: the candidate holds only directories,
 * each of those holds only regular files named by a SHA-1, and there is at
 * least one such file. A single README, symlink, nested directory, or file with
 * any other name means something other than Vitest put it there.
 *
 * @param listing - What the candidate holds, symlinks not followed.
 * @returns When it was last written to, or why it is not one.
 */
export function recognise(listing: ProjectListing): Recognition {
  const screened = screen(listing.name, listing.entries);

  if (screened._tag === "Unrecognised") {
    return screened;
  }

  let modules = 0;
  let lastWritten = listing.modified;

  for (const entry of listing.entries) {
    const evidence = screenEnvironment(entry);

    if (evidence._tag === "Unrecognised") {
      return evidence;
    }

    modules += evidence.modules;

    if (evidence.lastWritten.getTime() > lastWritten.getTime()) {
      lastWritten = evidence.lastWritten;
    }
  }

  // An empty directory is evidence of nothing, so it is left alone. It costs
  // a few kilobytes, which is not worth a guess.
  if (modules === 0) {
    return { _tag: "Unrecognised", reason: "holds no transformed modules" };
  }

  return { _tag: "Recognised", lastWritten };
}
