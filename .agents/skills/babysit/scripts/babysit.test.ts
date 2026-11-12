/**
 * End-to-end tests through the real CLI entry point. A fake `gh` on PATH replays a recorded
 * GraphQL response, so the whole stack (argv parsing, target resolution, adapter, decision,
 * state file, JSON output, process lifecycle) runs without touching GitHub.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";

const SCRIPT = fileURLToPath(new URL("./babysit.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/github-pr-open.json", import.meta.url));
const PR_URL = "https://github.com/acme/widgets/pull/42";

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function run(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : Number(Reflect.get(error, "code") ?? 1);
      resolve({ code, stdout, stderr });
    });
  });
}

async function fakeGhEnv(): Promise<NodeJS.ProcessEnv> {
  const bin = await mkdtemp(join(tmpdir(), "babysit-bin-"));
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!${process.execPath}\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));\n`,
  );
  await chmod(gh, 0o755);
  return { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
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
    const env = await fakeGhEnv();
    const stateDir = await mkdtemp(join(tmpdir(), "babysit-state-"));
    const result = await run(["--pr", PR_URL, "--once", "--state-dir", stateDir], env);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.forge, "github");
    assert.equal(snapshot.pr.number, 42);
    assert.deepEqual(snapshot.actions, ["process_review_comment", "diagnose_ci_failure", "retry_failed_checks"]);
    assert.deepEqual(snapshot.ci.retries, { used: 0, budget: 3, exhausted: false });

    const again = JSON.parse((await run(["--pr", PR_URL, "--state-dir", stateDir], env)).stdout);
    assert.deepEqual(again.review.newItems, [], "the state file remembers surfaced items");
  });

  it("releases the watcher lock and exits 130 when --watch is interrupted", async () => {
    const env = await fakeGhEnv();
    const stateDir = await mkdtemp(join(tmpdir(), "babysit-state-"));
    const child = spawn(process.execPath, [SCRIPT, "--pr", PR_URL, "--watch", "--state-dir", stateDir], { env });
    const firstLine = new Promise<string>((resolve) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        if (buffered.includes("\n")) resolve(buffered);
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    const snapshot = JSON.parse(await firstLine);
    assert.deepEqual(snapshot.actions, ["process_review_comment", "diagnose_ci_failure", "retry_failed_checks"]);
    const [stateFile] = (await readdir(stateDir)).filter((name) => name.endsWith(".json"));
    const watchLock = join(stateDir, `${stateFile ?? "missing"}.watch.lock`);
    await access(watchLock);

    child.kill("SIGINT");
    assert.equal(await exited, 130);
    await assert.rejects(access(watchLock), "the watcher lock was released on interruption");
  });

  it("exits 130 and releases the watcher lock on Ctrl-C even while gh ignores SIGTERM", { timeout: 20_000 }, async () => {
    const bin = await mkdtemp(join(tmpdir(), "babysit-bin-"));
    const pidFile = join(bin, "gh.pid");
    // A gh that hangs mid-poll and shrugs off SIGTERM; only the runner's SIGKILL escalation ends it.
    await writeFile(
      join(bin, "gh"),
      `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const stateDir = await mkdtemp(join(tmpdir(), "babysit-state-"));
    const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    const child = spawn(process.execPath, [SCRIPT, "--pr", PR_URL, "--watch", "--state-dir", stateDir], { env });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    let ghPid = Number.NaN;
    while (Number.isNaN(ghPid)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      ghPid = Number(await readFile(pidFile, "utf8").catch(() => "NaN"));
    }
    const [watchLock] = (await readdir(stateDir)).filter((name) => name.endsWith(".json.watch.lock"));
    assert.ok(watchLock !== undefined, "the watcher holds its lock while gh runs");

    child.kill("SIGINT");
    assert.equal(await exited, 130);
    await assert.rejects(access(join(stateDir, watchLock)), "the watcher lock was released");
    assert.throws(() => process.kill(ghPid, 0), "the stubborn gh was killed");
  });
});
