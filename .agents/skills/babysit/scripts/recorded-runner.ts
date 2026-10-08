/**
 * Test support: a {@link CommandRunner} layer that answers `gh` / `az` / `git` calls from recorded
 * output, so adapters are exercised through their real seam without touching a forge.
 */
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { CommandFailed, CommandRunner, type Argv } from "./command-runner.ts";

/** A recorded answer: fixed stdout, the stderr of a failing command, or computed per call. */
export type Reply =
  | { readonly stdout: string }
  | { readonly fails: string }
  | { readonly respond: (argv: Argv) => Effect.Effect<string, CommandFailed> };

/** One recorded answer: the first route whose `when` matches the argv answers it. */
export type Route = { readonly when: (argv: Argv) => boolean; readonly reply: Reply };

/** A runner layer plus the argv of every call it received, in order. */
export type RecordedRunner = {
  readonly layer: Layer.Layer<CommandRunner>;
  readonly calls: ReadonlyArray<Argv>;
};

/**
 * Build a recorded runner from routes. An unmatched call fails like a missing program, so a test
 * never reaches a real CLI by accident.
 *
 * @param routes - Recorded answers, first match wins.
 * @returns The runner layer and its call log.
 */
export function recordedRunner(routes: ReadonlyArray<Route>): RecordedRunner {
  const calls: Argv[] = [];
  const run = (argv: Argv): Effect.Effect<string, CommandFailed> =>
    Effect.suspend(() => {
      calls.push(argv);
      const route = routes.find((candidate) => candidate.when(argv));
      if (route === undefined) return Effect.fail(CommandFailed.of(argv, "missing", "no recorded reply"));
      const reply = route.reply;
      if ("respond" in reply) return reply.respond(argv);
      return "stdout" in reply ? Effect.succeed(reply.stdout) : Effect.fail(CommandFailed.of(argv, "exit", reply.fails));
    });
  return { layer: Layer.succeed(CommandRunner, CommandRunner.of({ run })), calls };
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

/** A path into parsed JSON: object keys and array indexes. */
export type JsonPath = ReadonlyArray<string | number>;

/**
 * Parsed fixture JSON, edited through checked paths. Values stay `unknown`, so an edit may set
 * any value (including a protocol value the adapter must reject), but every step of a path must
 * exist: a mistyped path fails the test instead of silently editing nothing.
 */
export class FixtureJson {
  #root: unknown;

  /** @param root - The parsed fixture. */
  constructor(root: unknown) {
    this.#root = root;
  }

  /** The whole document. */
  get root(): unknown {
    return this.#root;
  }

  /**
   * Read the value at a path.
   *
   * @param path - Keys and indexes from the root.
   * @returns The value.
   * @throws When a step of the path does not exist (a defect in the test).
   */
  get(path: JsonPath): unknown {
    return path.reduce<unknown>((node, step, index) => child(node, step, path.slice(0, index + 1)), this.#root);
  }

  /**
   * Read an object at a path, for copying it into a new value.
   *
   * @param path - Keys and indexes from the root.
   * @returns The object's own fields.
   * @throws When the path is missing or does not hold an object.
   */
  object(path: JsonPath): Readonly<Record<string, unknown>> {
    const value = this.get(path);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`no object at ${render(path)}`);
    return Object.fromEntries(Object.entries(value));
  }

  /**
   * Replace an existing value.
   *
   * @param path - Keys and indexes from the root; its last step must already exist.
   * @param value - The new value.
   * @throws When the path is empty or a step does not exist.
   */
  set(path: JsonPath, value: unknown): void {
    const last = path.at(-1);
    if (last === undefined) throw new Error("cannot replace the fixture root; use replaceRoot");
    const parent = this.get(path.slice(0, -1));
    child(parent, last, path);
    Reflect.set(Object(parent), last, value);
  }

  /**
   * Replace the whole document, e.g. with one of its own sub-values.
   *
   * @param value - The new root.
   */
  replaceRoot(value: unknown): void {
    this.#root = value;
  }
}

function child(node: unknown, step: string | number, path: JsonPath): unknown {
  const present =
    typeof step === "number"
      ? Array.isArray(node) && step >= 0 && step < node.length
      : typeof node === "object" && node !== null && !Array.isArray(node) && Object.hasOwn(node, step);
  if (!present) throw new Error(`fixture has nothing at ${render(path)}`);
  return Reflect.get(Object(node), step);
}

function render(path: JsonPath): string {
  return `$${path.map((step) => (typeof step === "number" ? `[${step}]` : `.${step}`)).join("")}`;
}

/** A scenario edit on a parsed fixture. */
export type FixtureEdit = (json: FixtureJson) => void;

/**
 * Read a recorded fixture, apply an edit to a fresh parse, and return it as JSON text.
 *
 * @param name - File name under `scripts/fixtures/`.
 * @param edit - Edits the parsed copy to build a scenario variant.
 * @returns The edited JSON text.
 */
export function editedFixture(name: string, edit: FixtureEdit): string {
  const json = new FixtureJson(JSON.parse(fixtureText(name)));
  edit(json);
  return JSON.stringify(json.root);
}

/** Path to the GitHub fixture's pull request. */
export const GH_PR = ["data", "repository", "pullRequest"] as const;

/** Path to the GitHub fixture's head-commit check contexts connection. */
export const GH_CONTEXTS = [...GH_PR, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts"] as const;
