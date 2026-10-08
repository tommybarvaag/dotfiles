/**
 * End-to-end tests through the real CLI entry point. A fake `gh` on PATH replays a recorded
 * GraphQL response, so the whole stack (argv parsing, target resolution, adapter, decision,
 * state file, JSON output) runs without touching GitHub.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./babysit.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/github-pr-open.json", import.meta.url));

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function run(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : Number(Reflect.get(error, "code") ?? 1);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fakeGhPath(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "babysit-bin-"));
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!${process.execPath}\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));\n`,
  );
  await chmod(gh, 0o755);
  return bin;
}

describe("babysit CLI", () => {
  it("prints usage for --help", async () => {
    const result = await run(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--retry-failed-now/);
  });

  it("exits 2 with usage on a bad argument", async () => {
    const result = await run(["--pr", "not-a-pr"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--pr must be/);
  });

  it("exits 2 when two modes are combined", async () => {
    assert.equal((await run(["--once", "--watch"])).code, 2);
    assert.equal((await run(["--once", "--check-thread", "PRRT_x"])).code, 2);
    assert.equal((await run(["--check-thread", " "])).code, 2);
  });

  it("never prints credentials embedded in a rejected PR URL", async () => {
    const result = await run(["--pr", "https://bob:PAT_SECRET_123@gitlab.com/acme/widgets/-/merge_requests/1"]);
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /PAT_SECRET_123/);
  });

  it("prints one JSON snapshot for --once against a PR URL", async () => {
    const bin = await fakeGhPath();
    const stateDir = await mkdtemp(join(tmpdir(), "babysit-state-"));
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    const result = await run(["--pr", "https://github.com/acme/widgets/pull/42", "--once", "--state-dir", stateDir], env);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.forge, "github");
    assert.equal(snapshot.pr.number, 42);
    assert.deepEqual(snapshot.actions, ["process_review_comment", "diagnose_ci_failure", "retry_failed_checks"]);
    assert.deepEqual(snapshot.ci.retries, { used: 0, budget: 3, exhausted: false });

    const again = JSON.parse((await run(["--pr", "https://github.com/acme/widgets/pull/42", "--state-dir", stateDir], env)).stdout);
    assert.deepEqual(again.review.newItems, [], "the state file remembers surfaced items");
  });
});
