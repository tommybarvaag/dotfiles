/**
 * The port the watcher needs from a forge. One live implementation per forge (github.ts,
 * azure-devops.ts), each bound to a single pull request; the composition root picks one.
 */
import { Context, Effect, Layer, Schema } from "effect";
import type { CommandFailed } from "./command-runner.ts";
import type { ShapeMismatch } from "./decode.ts";
import type { Observation, RetryTarget, ThreadObservation } from "./pr-snapshot.ts";
import type { PrTarget } from "./pr-target.ts";

/** A forge call failed, or returned JSON the adapter could not parse. */
export type ForgeError = CommandFailed | ShapeMismatch;

/** Raised by `--pr auto` when the current branch has no single open pull request. */
export class NoOpenPullRequest extends Schema.TaggedError<NoOpenPullRequest>()("NoOpenPullRequest", {
  /** The branch that was looked up. */
  branch: Schema.String,
  /** How many open pull requests were found (0, or more than 1). */
  found: Schema.Number,
}) {
  /** How many pull requests matched, and what to pass instead. */
  override get message(): string {
    return this.found === 0
      ? `No open pull request has source branch "${this.branch}"; pass --pr <number|url>`
      : `${this.found} open pull requests have source branch "${this.branch}"; pass --pr <number|url>`;
  }
}

/** Raised when `--check-thread` names a thread the pull request does not have. */
export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()("ThreadNotFound", {
  /** The requested thread ID. */
  threadId: Schema.String,
}) {
  /** Which thread was missing. */
  override get message(): string {
    return `Thread ${this.threadId} was not found on this pull request`;
  }
}

/**
 * The result of one rerun request. `stale_head` and `not_terminal` mean nothing was rerun;
 * the next snapshot decides again against the current head.
 */
export type RerunResult =
  | { readonly _tag: "triggered"; readonly detail: string }
  | { readonly _tag: "stale_head"; readonly currentHead: string }
  | { readonly _tag: "not_terminal"; readonly status: string };

/** What a forge client can do for its one pull request. */
export type ForgeClientShape = {
  /** The pull request this client reads and reruns. */
  readonly target: PrTarget;

  /**
   * Read the pull request, its checks, and its review feedback, following every page. Read-only.
   * Gaps are reported in the observation's `completeness`.
   */
  readonly observe: Effect.Effect<Observation, ForgeError>;

  /**
   * Read one review thread in full (every comment page). Read-only.
   *
   * @param threadId - The thread ID from a snapshot item.
   * @returns The thread, `ThreadNotFound`, or a forge failure.
   */
  readonly readThread: (threadId: string) => Effect.Effect<ThreadObservation, ForgeError | ThreadNotFound>;

  /**
   * Rerun one failed check target for the head SHA its retry cycle was reserved on. The only CI
   * mutation the watcher performs. A forge whose rerun would act on a different commit must
   * check first and skip instead.
   *
   * @param target - A target chosen by the decision.
   * @param headSha - The head SHA the retry cycle was charged to.
   * @returns What happened, or a forge failure.
   */
  readonly rerun: (target: RetryTarget, headSha: string) => Effect.Effect<RerunResult, ForgeError>;
};

/** The forge client of the babysat pull request. */
export class ForgeClient extends Context.Service<ForgeClient, ForgeClientShape>()("babysit/ForgeClient") {
  /**
   * Test layer: a client that answers from a fixed script instead of a forge.
   *
   * @param shape - The client's behaviour.
   * @returns A layer providing that client.
   */
  static layerTest(shape: ForgeClientShape): Layer.Layer<ForgeClient> {
    return Layer.succeed(ForgeClient, ForgeClient.of(shape));
  }
}
