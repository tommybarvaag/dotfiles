import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decide,
  isTerminal,
  threadWriteEligibility,
  type Check,
  type Observation,
  type ReviewAuthor,
  type ReviewItem,
  type ReviewThread,
  type WatchPolicy,
} from "./pr-snapshot.ts";
import * as WatchState from "./watch-state.ts";

const policy: WatchPolicy = { reviewBots: ["chatgpt-codex-connector"], requester: "me", retryBudget: 2, replyMarker: "[babysit]" };
const NOW = "2026-10-08T12:00:00.000Z";
const alice: ReviewAuthor = { login: "alice", key: "alice", role: "collaborator" };
const me: ReviewAuthor = { login: "Me", key: "me", role: "collaborator" };
const codex: ReviewAuthor = { login: "chatgpt-codex-connector[bot]", key: "chatgpt-codex-connector", role: "bot" };

function check(overrides: Partial<Check> & Pick<Check, "name" | "status">): Check {
  return { group: "CI", conclusion: overrides.status, required: true, url: null, retry: null, failedJobs: [], ...overrides };
}

function failedJob(name: string) {
  return { name, check: "CI", url: null, errors: [], log: null };
}

function flakyCheck(runId: number, ready = true): Check {
  return check({
    name: `job-${runId}`,
    status: "failed",
    conclusion: "FAILURE",
    retry: { key: `github_run:${runId}`, ready, target: { _tag: "github_run", runId } },
    failedJobs: [failedJob(`job-${runId}`)],
  });
}

function threadOf(id: string, participants: ReadonlyArray<ReviewAuthor>, resolved = false): ReviewThread {
  return { id, resolved, outdated: false, path: "a.ts", line: 1, participants };
}

function item(id: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id,
    kind: "inline_comment",
    author: alice,
    body: "Please rename this.",
    url: null,
    createdAt: NOW,
    verdict: null,
    thread: threadOf(`thread-${id}`, [alice]),
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    forge: "github",
    pr: {
      number: 1,
      url: "https://github.com/acme/widgets/pull/1",
      title: "t",
      state: "open",
      isDraft: false,
      headSha: "sha-1",
      headBranch: "feat",
      baseBranch: "main",
    },
    mergeability: { status: "clean", detail: null },
    reviewDecision: "none",
    checks: [check({ name: "build", status: "passed" })],
    reviewItems: [],
    viewer: "me",
    completeness: { _tag: "complete" },
    ...overrides,
  };
}

describe("decide", () => {
  it("stops exclusively as soon as the PR is merged or closed", () => {
    for (const state of ["merged", "closed"] as const) {
      const obs = observation({ pr: { ...observation().pr, state }, reviewItems: [item("a")], checks: [flakyCheck(1)] });
      const decision = decide(obs, WatchState.initial, policy, NOW);
      assert.deepEqual(decision.snapshot.actions, ["stop_pr_closed"]);
      assert.ok(isTerminal(decision.snapshot));
      assert.deepEqual(decision.retryTargets, []);
      assert.equal(decision.state, WatchState.initial, "nothing marked seen");
    }
  });

  it("stops exclusively on merge conflicts: no review action, no retry plan, no state change", () => {
    const obs = observation({
      mergeability: { status: "conflicting", detail: "conflicts" },
      reviewItems: [item("a")],
      checks: [flakyCheck(7)],
    });
    const decision = decide(obs, WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["stop_merge_conflict"]);
    assert.deepEqual(decision.retryTargets, []);
    assert.equal(decision.state, WatchState.initial);
  });

  it("orders review feedback before CI diagnosis and flaky retries", () => {
    const decision = decide(observation({ reviewItems: [item("a")], checks: [flakyCheck(7)] }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["process_review_comment", "diagnose_ci_failure", "retry_failed_checks"]);
    assert.deepEqual(decision.retryTargets, [{ _tag: "github_run", runId: 7 }]);
  });

  it("surfaces each review item once, then remembers it", () => {
    const obs = observation({ reviewItems: [item("a"), item("b")] });
    const first = decide(obs, WatchState.initial, policy, NOW);
    assert.deepEqual(first.snapshot.review.newItems.map((i) => i.id), ["a", "b"]);
    const second = decide(obs, first.state, policy, NOW);
    assert.deepEqual(second.snapshot.review.newItems, []);
    assert.equal(second.snapshot.review.unresolvedThreads, 2, "still-open threads keep counting");
    assert.ok(!second.snapshot.actions.includes("process_review_comment"));
  });

  it("hides resolved threads, outsiders, unlisted bots and the operator's own marked replies", () => {
    const items = [
      item("resolved", { thread: threadOf("t-resolved", [alice], true) }),
      item("outsider", { author: { login: "mallory", key: "mallory", role: "outsider" } }),
      item("noisy-bot", { author: { login: "github-actions[bot]", key: "github-actions", role: "bot" } }),
      item("codex", { author: codex }),
      item("own-reply", { author: me, body: "[babysit] Fixed in abc." }),
      item("own-request", { author: me, body: "Please also handle nulls." }),
    ];
    const decision = decide(observation({ reviewItems: items }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.review.newItems.map((i) => i.id), ["codex", "own-request"]);
    assert.equal(decision.snapshot.review.ignoredUntrusted, 2);
  });

  it("spends the retry budget per head SHA and resets it on a new commit", () => {
    let state = WatchState.initial;
    for (let cycle = 0; cycle < policy.retryBudget; cycle += 1) {
      const decision = decide(observation({ checks: [flakyCheck(7)] }), state, policy, NOW);
      assert.ok(decision.snapshot.actions.includes("retry_failed_checks"), `cycle ${cycle} offers a retry`);
      state = WatchState.reserveRetry(decision.state, "sha-1");
    }
    const exhausted = decide(observation({ checks: [flakyCheck(7)] }), state, policy, NOW);
    assert.deepEqual(exhausted.snapshot.actions, ["diagnose_ci_failure"]);
    assert.deepEqual(exhausted.snapshot.ci.retries, { used: 2, budget: 2, exhausted: true });
    assert.deepEqual(exhausted.retryTargets, []);

    const newCommit = observation({ pr: { ...observation().pr, headSha: "sha-2" }, checks: [flakyCheck(8)] });
    assert.ok(decide(newCommit, state, policy, NOW).snapshot.actions.includes("retry_failed_checks"));
  });

  it("keeps each SHA's retry budget and celebration when an older observation is decided late", () => {
    const at = (headSha: string, checks: ReadonlyArray<Check>) => observation({ pr: { ...observation().pr, headSha }, checks });
    const budgetOne = { ...policy, retryBudget: 1 };
    // B is observed and retried; a delayed observation of A is retried afterwards; then B again.
    let state = WatchState.reserveRetry(decide(at("sha-B", [flakyCheck(2)]), WatchState.initial, budgetOne, NOW).state, "sha-B");
    state = WatchState.reserveRetry(decide(at("sha-A", [flakyCheck(1)]), state, budgetOne, NOW).state, "sha-A");
    const again = decide(at("sha-B", [flakyCheck(2)]), state, budgetOne, NOW);
    assert.deepEqual(again.retryTargets, [], "B's spent budget survived the late reservation for A");
    assert.deepEqual([WatchState.retriesUsed(state, "sha-A"), WatchState.retriesUsed(state, "sha-B")], [1, 1]);

    // B celebrates; a late green observation of A must not make B celebrate a second time.
    const green = [check({ name: "build", status: "passed" })];
    const celebratedB = decide(at("sha-B", green), WatchState.initial, policy, NOW).state;
    const lateA = decide(at("sha-A", green), celebratedB, policy, NOW).state;
    assert.ok(!decide(at("sha-B", green), lateA, policy, NOW).snapshot.actions.includes("celebrate_ci_green"));
  });

  it("diagnoses a failed job while its workflow run is still going, but waits to rerun it", () => {
    const decision = decide(observation({ checks: [flakyCheck(7, false)] }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["diagnose_ci_failure"]);
    assert.equal(decision.snapshot.ci.failedJobs.length, 1);
  });

  it("diagnoses failed tasks of a still-running build without offering a rerun or a milestone", () => {
    const running = check({ name: "widgets-e2e", status: "pending", failedJobs: [failedJob("Run e2e shard 1")] });
    const decision = decide(observation({ checks: [running] }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["diagnose_ci_failure"]);
    assert.equal(decision.snapshot.ci.status, "pending");
    assert.deepEqual(decision.retryTargets, []);
  });

  it("celebrates all-green CI once per head SHA", () => {
    const first = decide(observation(), WatchState.initial, policy, NOW);
    assert.deepEqual(first.snapshot.actions, ["celebrate_ci_green", "ready_to_merge"]);
    const again = decide(observation(), first.state, policy, NOW);
    assert.deepEqual(again.snapshot.actions, ["ready_to_merge"]);
    const pushed = decide(observation({ pr: { ...observation().pr, headSha: "sha-2" } }), again.state, policy, NOW);
    assert.ok(pushed.snapshot.actions.includes("celebrate_ci_green"));
  });

  it("never celebrates or declares the milestone from an incomplete observation", () => {
    const incomplete = observation({ completeness: { _tag: "incomplete", reasons: ["checks: stopped after 50 pages"] } });
    const decision = decide(incomplete, WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["idle"]);
    assert.ok(!WatchState.wasCelebrated(decision.state, "sha-1"), "the celebration is still owed once complete");
  });

  it("keeps watching a green PR that still needs approval, is a draft, or has open threads", () => {
    const blocked: ReadonlyArray<Observation> = [
      observation({ reviewDecision: "review_required" }),
      observation({ pr: { ...observation().pr, isDraft: true } }),
      observation({ mergeability: { status: "unknown", detail: null } }),
    ];
    for (const obs of blocked) {
      const actions = decide(obs, WatchState.markCelebrated(WatchState.initial, "sha-1"), policy, NOW).snapshot.actions;
      assert.deepEqual(actions, ["idle"]);
    }
    const seenThread = WatchState.markSeen(WatchState.markCelebrated(WatchState.initial, "sha-1"), ["a"]);
    assert.deepEqual(decide(observation({ reviewItems: [item("a")] }), seenThread, policy, NOW).snapshot.actions, ["idle"]);
  });

  it("stays idle while CI is pending", () => {
    const decision = decide(observation({ checks: [check({ name: "build", status: "pending" })] }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.actions, ["idle"]);
    assert.ok(!isTerminal(decision.snapshot));
  });

  it("trusts the confirmed requester even without repository association", () => {
    const requester = { login: "me", key: "me", role: "outsider" } as const;
    const decision = decide(observation({ reviewItems: [item("mine", { author: requester })] }), WatchState.initial, policy, NOW);
    assert.deepEqual(decision.snapshot.review.newItems.map((i) => i.id), ["mine"]);
  });

  it("marks each surfaced item's thread as writable only when policy allows", () => {
    const items = [
      item("own-bot-thread", { author: codex, thread: threadOf("t1", [codex, me]) }),
      item("mixed-thread", { author: codex, thread: threadOf("t2", [codex, alice]) }),
      item("conversation", { thread: null }),
    ];
    const newItems = decide(observation({ reviewItems: items }), WatchState.initial, policy, NOW).snapshot.review.newItems;
    assert.deepEqual(
      newItems.map((i) => i.threadWrite._tag),
      ["eligible", "ineligible", "ineligible"],
    );
  });
});

describe("threadWriteEligibility", () => {
  const complete = { _tag: "complete" } as const;
  const eligibility = (participants: ReadonlyArray<ReviewAuthor>, overrides: Partial<WatchPolicy> = {}) =>
    threadWriteEligibility({ thread: threadOf("t", participants), completeness: complete }, { ...policy, ...overrides });

  it("allows threads whose humans are all the confirmed requester, plus allow-listed bots", () => {
    assert.equal(eligibility([me, codex])._tag, "eligible");
    assert.deepEqual(eligibility([me, alice]), { _tag: "ineligible", reason: "other participants: alice" });
    assert.equal(eligibility([{ login: "sonarqube", key: "sonarqube", role: "bot" }])._tag, "ineligible");
  });

  it("allows no human thread without a confirmed requester, but still allow-listed bot threads", () => {
    assert.deepEqual(eligibility([me], { requester: null }), {
      _tag: "ineligible",
      reason: "no --requester was confirmed, so no human thread is auto-writable",
    });
    assert.equal(eligibility([codex], { requester: null })._tag, "eligible");
  });

  it("refuses when the read was incomplete or the thread is resolved", () => {
    const incomplete = { _tag: "incomplete", reasons: ["comments: stopped after 50 pages"] } as const;
    assert.equal(threadWriteEligibility({ thread: threadOf("t", [me]), completeness: incomplete }, policy)._tag, "ineligible");
    assert.equal(threadWriteEligibility({ thread: threadOf("t", [me], true), completeness: complete }, policy)._tag, "ineligible");
  });
});

describe("WatchState.parse", () => {
  it("round-trips a saved state and rejects foreign JSON", () => {
    const state = WatchState.reserveRetry(WatchState.markSeen(WatchState.initial, ["a"]), "sha");
    assert.deepEqual(WatchState.parse(JSON.parse(JSON.stringify(state))), { _tag: "ok", value: state });
    assert.equal(WatchState.parse({ version: 1, retry: null })._tag, "err", "a pre-v2 single-SHA retry state");
    assert.equal(WatchState.parse({ version: 3 })._tag, "err");
    assert.equal(WatchState.parse([])._tag, "err");
  });
});
