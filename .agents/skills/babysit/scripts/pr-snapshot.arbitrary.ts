/**
 * Test data: forge-neutral observations covering every lifecycle state, mergeability, check status,
 * author role and thread shape the decision distinguishes, over a small shared vocabulary of SHAs,
 * item IDs and authors so generated observations collide with generated watch states.
 */
import { Arbitrary, Schema } from "effect";
import type { Check, Observation, ReviewAuthor, ReviewItem } from "./pr-snapshot.ts";
import { HEAD_SHAS, ITEM_IDS } from "./watch-state.arbitrary.ts";

const literals = <const L extends ReadonlyArray<string | number>>(values: L) => Arbitrary.schema(Schema.Literals(values));
const boolean = Arbitrary.schema(Schema.Boolean);

/** Authors spanning every trust outcome under {@link policyIdentities}. */
const AUTHORS = {
  alice: { login: "alice", key: "alice", role: "collaborator" },
  me: { login: "me", key: "me", role: "outsider" },
  mallory: { login: "mallory", key: "mallory", role: "outsider" },
  codex: { login: "codex[bot]", key: "chatgpt-codex-connector", role: "bot" },
  noisy: { login: "noisy[bot]", key: "github-actions", role: "bot" },
} as const satisfies Record<string, ReviewAuthor>;

/** The requester and allow-listed bot the generated authors are meant to be judged against. */
export const policyIdentities = { requester: "me", reviewBots: ["chatgpt-codex-connector"] } as const;

const author = literals(["alice", "me", "mallory", "codex", "noisy"]).pipe(
  Arbitrary.map((name): ReviewAuthor => AUTHORS[name]),
);

const check: Arbitrary.Arbitrary<Check> = Arbitrary.all({
  status: literals(["passed", "failed", "pending", "skipped"]),
  retryable: boolean,
  ready: boolean,
  runId: literals([1, 2, 3]),
  failedJob: boolean,
}).pipe(
  Arbitrary.map(
    ({ status, retryable, ready, runId, failedJob }): Check => ({
      name: `job-${runId}`,
      group: "CI",
      status,
      conclusion: status,
      required: true,
      url: null,
      retry: retryable ? { key: `github_run:${runId}`, ready, target: { _tag: "github_run", runId } } : null,
      failedJobs: failedJob || status === "failed" ? [{ name: `job-${runId}`, check: "CI", url: null, errors: [], log: null }] : [],
    }),
  ),
);

const reviewItem: Arbitrary.Arbitrary<ReviewItem> = Arbitrary.all({
  id: literals(ITEM_IDS),
  author,
  participants: Arbitrary.array(author, { minLength: 1, maxLength: 3 }),
  threaded: boolean,
  resolved: boolean,
  body: literals(["Please rename this.", "[babysit] Fixed in abc."]),
}).pipe(
  Arbitrary.map(
    ({ id, author, participants, threaded, resolved, body }): ReviewItem => ({
      id,
      kind: threaded ? "inline_comment" : "conversation_comment",
      author,
      body,
      url: null,
      createdAt: "2026-10-08T12:00:00.000Z",
      verdict: null,
      thread: threaded ? { id: `thread-${id}`, resolved, outdated: false, path: "a.ts", line: 1, participants } : null,
    }),
  ),
);

/** Any observation an adapter could report. */
export const observation: Arbitrary.Arbitrary<Observation> = Arbitrary.all({
  state: literals(["open", "open", "merged", "closed"]),
  isDraft: boolean,
  headSha: literals(HEAD_SHAS),
  mergeability: literals(["clean", "conflicting", "behind", "blocked", "unknown"]),
  reviewDecision: literals(["approved", "changes_requested", "review_required", "none"]),
  checks: Arbitrary.array(check, { maxLength: 4 }),
  reviewItems: Arbitrary.array(reviewItem, { maxLength: 4 }),
  complete: boolean,
  viewer: literals(["me", "octo"]),
}).pipe(
  Arbitrary.map(
    (generated): Observation => ({
      forge: "github",
      pr: {
        number: 1,
        url: "https://github.com/acme/widgets/pull/1",
        title: "t",
        state: generated.state,
        isDraft: generated.isDraft,
        headSha: generated.headSha,
        headBranch: "feat",
        baseBranch: "main",
      },
      mergeability: { status: generated.mergeability, detail: null },
      reviewDecision: generated.reviewDecision,
      checks: generated.checks,
      reviewItems: generated.reviewItems,
      viewer: generated.viewer,
      completeness: generated.complete ? { _tag: "complete" } : { _tag: "incomplete", reasons: ["generated gap"] },
    }),
  ),
);
