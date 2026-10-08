/**
 * Port for running an external CLI (`gh`, `az`, `git`) and capturing its standard output. The
 * forge adapters depend on this service, so tests swap in recorded output (recorded-runner.ts)
 * without touching a forge.
 */
import { Context, Duration, Effect, Layer, PlatformError, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A command line as an argv array: program first, never a shell string. */
export type Argv = readonly [program: string, ...args: string[]];

/** Why a command failed. */
export const CommandFailureReason = Schema.Literals(["exit", "missing", "timeout", "output_limit"]);

/** Raised when a CLI exits non-zero, cannot be found, times out, or floods its output. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  /** The program that failed, e.g. `gh`. */
  program: Schema.String,
  /** The first three argv tokens, e.g. `gh api graphql`. Later arguments can carry long queries. */
  command: Schema.String,
  /**
   * `exit` for a non-zero or signal exit, `missing` when the program is not installed,
   * `timeout`, or `output_limit` when stdout or stderr outgrew the runner's bound.
   */
  reason: CommandFailureReason,
  /** Trimmed standard error the child wrote before it failed, for diagnosis. */
  stderr: Schema.String,
  /** What the runner itself observed (signal exit, spawn error, which stream overflowed), or `null`. */
  detail: Schema.NullOr(Schema.String),
}) {
  /**
   * Build the error for a failed argv.
   *
   * @param argv - The command that failed.
   * @param reason - Why it failed.
   * @param stderr - Its standard error.
   * @param detail - Runner-side context, kept apart from the child's own stderr.
   * @returns The error.
   */
  static of(argv: Argv, reason: typeof CommandFailureReason.Type, stderr: string, detail: string | null = null): CommandFailed {
    return new CommandFailed({ program: argv[0], command: argv.slice(0, 3).join(" "), reason, stderr, detail });
  }

  /** What failed, with runner context and the last lines of standard error. */
  override get message(): string {
    if (this.reason === "missing") return `${this.program} is not installed or not on PATH`;
    const timedOut = this.reason === "timeout" ? " (timed out)" : "";
    const context = [this.detail, this.stderr.split("\n").slice(-5).join("\n")].filter((part) => part !== null && part !== "");
    return `${this.command} failed${timedOut}: ${context.join("\n")}`;
  }
}

/** Options for one command run. */
export type RunOptions = { readonly cwd?: string };

/** Bounds for the live runner. */
export type RunnerLimits = {
  /** A run longer than this fails with `timeout`. */
  readonly timeout: Duration.Input;
  /** Grace after SIGTERM before the child's process group gets SIGKILL (timeout or interruption). */
  readonly forceKillAfter: Duration.Input;
  /** Bytes kept per stream; one byte more fails the run with `output_limit`. */
  readonly maxOutputBytes: number;
};

/** The production bounds: the old `execFile` timeout and `maxBuffer`, plus a SIGKILL escalation. */
export const defaultLimits: RunnerLimits = {
  timeout: Duration.minutes(2),
  forceKillAfter: Duration.seconds(3),
  maxOutputBytes: 64 * 1024 * 1024,
};

/** Runs one external CLI to completion and returns its standard output. */
export class CommandRunner extends Context.Service<
  CommandRunner,
  {
    /**
     * Run a command.
     *
     * @param argv - Program and arguments.
     * @param options - Working directory.
     * @returns Standard output, or `CommandFailed`.
     */
    readonly run: (argv: Argv, options?: RunOptions) => Effect.Effect<string, CommandFailed>;
  }
>()("babysit/CommandRunner") {
  /**
   * The real runner with explicit bounds: spawns the program with an argv array (no shell). A
   * timed-out, overflowing or interrupted run closes the child's scope, which sends SIGTERM to
   * its process group and SIGKILL after `forceKillAfter`.
   *
   * @param limits - Timeout, kill escalation and output bound.
   * @returns A layer that needs the platform's child-process spawner.
   */
  static layerWith(limits: RunnerLimits): Layer.Layer<CommandRunner, never, ChildProcessSpawner.ChildProcessSpawner> {
    return Layer.effect(
      CommandRunner,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return CommandRunner.of({ run: (argv, options) => runWith(spawner, limits, argv, options) });
      }),
    );
  }

  /** The real runner with {@link defaultLimits}. */
  static readonly layer: Layer.Layer<CommandRunner, never, ChildProcessSpawner.ChildProcessSpawner> =
    CommandRunner.layerWith(defaultLimits);
}

/** Bytes of one output stream, counted before decoding and capped. */
class BoundedOutput {
  readonly #chunks: Uint8Array[] = [];
  #bytes = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Keep a chunk; `false` once the stream has outgrown the bound (the chunk is dropped). */
  push(chunk: Uint8Array): boolean {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.#limit) return false;
    this.#chunks.push(chunk);
    return true;
  }

  /** The bytes kept so far, decoded as UTF-8. */
  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

/** Why a run stopped short of a clean exit; mapped to `CommandFailed` with the stderr kept so far. */
type Interrupted =
  | { readonly _tag: "Overflow"; readonly stream: "stdout" | "stderr" }
  | { readonly _tag: "Platform"; readonly notFound: boolean; readonly detail: string }
  | { readonly _tag: "Timeout" };

/**
 * Runner-side context for a platform failure. The platform's own message embeds the full command
 * line (for `gh`, a whole GraphQL query); this keeps only what went wrong and where.
 */
function platformDetail(error: PlatformError.PlatformError): string {
  const reason = error.reason;
  const description = reason.description === undefined ? "" : `: ${reason.description}`;
  return `${reason._tag}: ${reason.module}.${reason.method}${description}`;
}

/** Read one output stream into its bound; past the bound, fail so the child's scope closes. */
function drain(
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  into: BoundedOutput,
  name: "stdout" | "stderr",
): Effect.Effect<void, Interrupted> {
  return Stream.runForEach(stream, (chunk) =>
    into.push(chunk) ? Effect.void : Effect.fail<Interrupted>({ _tag: "Overflow", stream: name }),
  ).pipe(
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail<Interrupted>({ _tag: "Platform", notFound: false, detail: platformDetail(error) }),
    ),
  );
}

function runWith(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  limits: RunnerLimits,
  argv: Argv,
  options: RunOptions | undefined,
): Effect.Effect<string, CommandFailed> {
  const [program, ...args] = argv;
  return Effect.gen(function* () {
    // Created outside the child's scope, so stderr survives a signal exit, an overflow or a timeout.
    const stdout = new BoundedOutput(limits.maxOutputBytes);
    const stderr = new BoundedOutput(limits.maxOutputBytes);
    const command = ChildProcess.make(program, args, {
      cwd: options?.cwd,
      stdin: "ignore",
      forceKillAfter: limits.forceKillAfter,
    });
    const run = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command);
        const [, , exitCode] = yield* Effect.all(
          [drain(handle.stdout, stdout, "stdout"), drain(handle.stderr, stderr, "stderr"), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return exitCode;
      }),
    ).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail<Interrupted>({ _tag: "Platform", notFound: error.reason._tag === "NotFound", detail: platformDetail(error) }),
      ),
      Effect.timeoutOrElse({ duration: limits.timeout, orElse: () => Effect.fail<Interrupted>({ _tag: "Timeout" }) }),
    );

    const outcome = yield* Effect.result(run);
    const diagnostics = stderr.text().trim();
    if (Result.isFailure(outcome)) {
      const stopped = outcome.failure;
      switch (stopped._tag) {
        case "Overflow":
          return yield* CommandFailed.of(argv, "output_limit", diagnostics, `${stopped.stream} exceeded ${limits.maxOutputBytes} bytes`);
        case "Timeout":
          return yield* CommandFailed.of(argv, "timeout", diagnostics);
        case "Platform":
          return yield* CommandFailed.of(argv, stopped.notFound ? "missing" : "exit", diagnostics, stopped.detail);
      }
    }
    if (outcome.success !== 0) return yield* CommandFailed.of(argv, "exit", diagnostics);
    return stdout.text();
  });
}
