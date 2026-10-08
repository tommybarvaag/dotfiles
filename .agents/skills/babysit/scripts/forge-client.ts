import type { CommandFailed } from "./command-runner.ts";
import type { ShapeMismatch } from "./decode.ts";
import type { Observation, RetryTarget, ThreadObservation } from "./pr-snapshot.ts";
import type { PrTarget } from "./pr-target.ts";
import type { Result } from "./result.ts";

/** A forge call failed, or returned JSON the adapter could not parse. */
export type ForgeError = CommandFailed | ShapeMismatch;

/** Raised by `--pr auto` when the current branch has no single open pull request. */
export class NoOpenPullRequest extends Error {
  readonly _tag = "NoOpenPullRequest" as const;
  /** The branch that was looked up. */
  readonly branch: string;
  /** How many open pull requests were found (0, or more than 1). */
  readonly found: number;

  /**
   * @param branch - The branch that was looked up.
   * @param found - How many open pull requests were found.
   */
  constructor(branch: string, found: number) {
    super(
      found === 0
        ? `No open pull request has source branch "${branch}"; pass --pr <number|url>`
        : `${found} open pull requests have source branch "${branch}"; pass --pr <number|url>`,
    );
    this.branch = branch;
    this.found = found;
  }
}

/** Raised when `--check-thread` names a thread the pull request does not have. */
export class ThreadNotFound extends Error {
  readonly _tag = "ThreadNotFound" as const;
  /** The requested thread ID. */
  readonly threadId: string;

  /** @param threadId - The requested thread ID. */
  constructor(threadId: string) {
    super(`Thread ${threadId} was not found on this pull request`);
    this.threadId = threadId;
  }
}

/**
 * Port the watcher needs from a forge. One implementation per forge (github.ts, azure-devops.ts),
 * each bound to a single pull request.
 */
export type ForgeClient = {
  /** The pull request this client reads and reruns. */
  readonly target: PrTarget;

  /**
   * Read the pull request, its checks, and its review feedback, following every page. Read-only.
   *
   * @returns A forge-neutral observation; gaps are reported in its `completeness`.
   */
  observe(): Promise<Result<Observation, ForgeError>>;

  /**
   * Read one review thread in full (every comment page) plus the operator identity. Read-only.
   *
   * @param threadId - The thread ID from a snapshot item.
   * @returns The thread, `ThreadNotFound`, or a forge failure.
   */
  readThread(threadId: string): Promise<Result<ThreadObservation, ForgeError | ThreadNotFound>>;

  /**
   * Rerun one failed check target for the head SHA its retry cycle was reserved on. The only CI
   * mutation the watcher performs. A forge whose rerun would act on a different commit must
   * check first and skip instead.
   *
   * @param target - A target chosen by the decision.
   * @param headSha - The head SHA the retry cycle was charged to.
   * @returns What happened, or a forge failure.
   */
  rerun(target: RetryTarget, headSha: string): Promise<Result<RerunResult, ForgeError>>;
};

/**
 * The result of one rerun request. `stale_head` and `not_terminal` mean nothing was rerun;
 * the next snapshot decides again against the current head.
 */
export type RerunResult =
  | { readonly _tag: "triggered"; readonly detail: string }
  | { readonly _tag: "stale_head"; readonly currentHead: string }
  | { readonly _tag: "not_terminal"; readonly status: string };
