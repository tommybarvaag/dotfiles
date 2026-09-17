/**
 * Rendering of scan progress to a terminal.
 *
 * Two implementations of the same port: one that draws, one that does not.
 * The drawing one is deliberately modest — a single repainted line, no spinner
 * fiber, no hidden cursor. After the scan was made fast, events arrive
 * continuously enough that repainting on each one supplies all the motion
 * needed, and nothing is left to clean up if the process dies abruptly.
 */
import { Console, Effect, Layer, Ref, Stdio, Terminal } from "effect";
import { ScanProgress } from "../ports.ts";

/** Erase the current line and return the cursor to its start. */
const CLEAR_LINE = "\r[2K";

/** Counters backing the rendered line. */
type Counts = {
  readonly lookingFor: string;
  readonly found: number;
  readonly measured: number;
  readonly latest: string;
};

const initialCounts: Counts = { lookingFor: "", found: 0, measured: 0, latest: "" };

/**
 * Build the single status line.
 *
 * @param counts - The current progress counters.
 * @param columns - The terminal width to fit within.
 * @returns The line, truncated to fit.
 */
function renderLine(counts: Counts, columns: number): string {
  const measured = counts.measured > 0 ? `, ${counts.measured} measured` : "";
  const line = `  ${counts.lookingFor}: ${counts.found} found${measured}  ${counts.latest}`;

  // Leave the last column free so the terminal does not wrap and scroll.
  return line.slice(0, Math.max(0, columns - 1));
}

/**
 * Progress that renders to an interactive terminal and stays silent otherwise.
 *
 * On a non-interactive stdout nothing is emitted at all — not even a summary —
 * so piped output contains only the report, with no escape sequences and no
 * carriage returns to confuse a parser.
 */
export const ScanProgressLive = Layer.effect(
  ScanProgress,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const terminal = yield* Terminal.Terminal;
    const interactive = yield* stdio.stdoutIsTerminal;

    if (!interactive) {
      return ScanProgress.of({
        scanning: () => Effect.void,
        found: () => Effect.void,
        measured: () => Effect.void,
        done: Effect.void,
      });
    }

    const columns = yield* terminal.columns;
    const counts = yield* Ref.make(initialCounts);

    // A failed write must never fail a scan, so every display is ignored.
    const repaint = Effect.flatMap(Ref.get(counts), (current) =>
      Effect.ignore(terminal.display(CLEAR_LINE + renderLine(current, columns))),
    );

    return ScanProgress.of({
      scanning: (lookingFor, root) =>
        Effect.flatMap(
          Ref.set(counts, { ...initialCounts, lookingFor, latest: root }),
          () => repaint,
        ),

      found: (path) =>
        Effect.flatMap(
          Ref.update(counts, (current) => ({
            ...current,
            found: current.found + 1,
            latest: path,
          })),
          () => repaint,
        ),

      measured: (path) =>
        Effect.flatMap(
          Ref.update(counts, (current) => ({
            ...current,
            measured: current.measured + 1,
            latest: path,
          })),
          () => repaint,
        ),

      done: Effect.ignore(terminal.display(CLEAR_LINE)),
    });
  }),
);

/** Progress that reports nothing, for tests and for quiet runs. */
export const ScanProgressSilent = Layer.succeed(
  ScanProgress,
  ScanProgress.of({
    scanning: () => Effect.void,
    found: () => Effect.void,
    measured: () => Effect.void,
    done: Effect.void,
  }),
);

/**
 * Progress that prints one line per phase without cursor control.
 *
 * Useful when watching a run whose output is being captured, where repainting
 * would be invisible but silence is unhelpful.
 */
export const ScanProgressPlain = Layer.succeed(
  ScanProgress,
  ScanProgress.of({
    scanning: (lookingFor, root) => Console.log(`scanning ${lookingFor} in ${root}`),
    found: () => Effect.void,
    measured: () => Effect.void,
    done: Effect.void,
  }),
);
