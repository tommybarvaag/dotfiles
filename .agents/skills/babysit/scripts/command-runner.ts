import { execFile } from "node:child_process";
import { err, ok, type Result } from "./result.ts";

/** A command line as an argv array: program first, never a shell string. */
export type Argv = readonly [program: string, ...args: string[]];

/** Raised when a CLI exits non-zero, cannot be found, or times out. */
export class CommandFailed extends Error {
  readonly _tag = "CommandFailed" as const;
  /** The program that failed, e.g. `gh`. Arguments are omitted: they can carry long queries. */
  readonly program: string;
  /** `exit` for a non-zero exit, `missing` when the program is not installed, `timeout`. */
  readonly reason: "exit" | "missing" | "timeout";
  /** Trimmed standard error, for diagnosis. */
  readonly stderr: string;

  /**
   * @param argv - The command that failed.
   * @param reason - Why it failed.
   * @param stderr - Its standard error.
   */
  constructor(argv: Argv, reason: "exit" | "missing" | "timeout", stderr: string) {
    const label = argv.slice(0, 3).join(" ");
    super(
      reason === "missing"
        ? `${argv[0]} is not installed or not on PATH`
        : `${label} failed${reason === "timeout" ? " (timed out)" : ""}: ${stderr.split("\n").slice(-5).join("\n")}`,
    );
    this.program = argv[0];
    this.reason = reason;
    this.stderr = stderr;
  }
}

/**
 * Port for running an external CLI and capturing its standard output.
 * The adapters depend on this, so tests substitute recorded output without touching a forge.
 */
export type CommandRunner = (argv: Argv, options?: { readonly cwd?: string }) => Promise<Result<string, CommandFailed>>;

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The real runner: `execFile` with an argv array (no shell), a timeout, and a large buffer.
 *
 * @returns A command runner for `gh`, `az`, and `git`.
 */
export function execFileRunner(): CommandRunner {
  return (argv, options) =>
    new Promise((resolve) => {
      const [program, ...args] = argv;
      execFile(
        program,
        args,
        { cwd: options?.cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve(ok(stdout));
            return;
          }
          const code = Reflect.get(error, "code");
          const reason = code === "ENOENT" ? "missing" : error.killed ? "timeout" : "exit";
          resolve(err(new CommandFailed(argv, reason, String(stderr).trim())));
        },
      );
    });
}
