/**
 * Test support: a {@link CommandRunner} that answers `gh` / `az` / `git` calls from recorded
 * output, so adapters are exercised through their real seam without touching a forge.
 */
import { readFileSync } from "node:fs";
import { CommandFailed, type Argv, type CommandRunner } from "./command-runner.ts";
import { err, ok } from "./result.ts";

/** One recorded answer: the first route whose `when` matches the argv answers it. */
export type Route = {
  readonly when: (argv: Argv) => boolean;
  /** Recorded stdout, or the stderr of a failing command. */
  readonly reply: { readonly stdout: string } | { readonly fails: string };
};

/** A runner plus the argv of every call it received, in order. */
export type RecordedRunner = { readonly runner: CommandRunner; readonly calls: ReadonlyArray<Argv> };

/**
 * Build a runner from routes. An unmatched call fails like a missing program, so a test never
 * reaches a real CLI by accident.
 *
 * @param routes - Recorded answers, first match wins.
 * @returns The runner and its call log.
 */
export function recordedRunner(routes: ReadonlyArray<Route>): RecordedRunner {
  const calls: Argv[] = [];
  const runner: CommandRunner = async (argv) => {
    calls.push(argv);
    const route = routes.find((candidate) => candidate.when(argv));
    if (route === undefined) return err(new CommandFailed(argv, "missing", "no recorded reply"));
    return "stdout" in route.reply ? ok(route.reply.stdout) : err(new CommandFailed(argv, "exit", route.reply.fails));
  };
  return { runner, calls };
}

/**
 * A predicate matching argv that contains every given token.
 *
 * @param tokens - Tokens that must all appear.
 * @returns The predicate.
 */
export function argvHas(...tokens: ReadonlyArray<string>): (argv: Argv) => boolean {
  return (argv) => tokens.every((token) => argv.includes(token));
}

/**
 * Read a recorded fixture as text.
 *
 * @param name - File name under `scripts/fixtures/`.
 * @returns The file content.
 */
export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/**
 * A scenario edit on parsed fixture JSON.
 */
// oxlint-disable-next-line no-explicit-any -- SAFETY: test-only scenario edits reach into recorded forge JSON; the adapter under test re-parses the result, so a wrong path fails the test instead of hiding a bug.
export type FixtureEdit = (json: any) => void;

/**
 * Read a recorded fixture, apply an edit to a deep copy, and return it as JSON text.
 *
 * @param name - File name under `scripts/fixtures/`.
 * @param edit - Mutates the parsed copy to build a scenario variant.
 * @returns The edited JSON text.
 */
export function editedFixture(name: string, edit: FixtureEdit): string {
  const json: unknown = JSON.parse(fixtureText(name));
  edit(json);
  return JSON.stringify(json);
}
