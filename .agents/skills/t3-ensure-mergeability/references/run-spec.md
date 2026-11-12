# Run spec

The argument is plain words. Read it into the fields below, fill every unset field with its default, and resolve every target against `orchestrator_capabilities`. A phrase that restates a default, such as "run checks", sets nothing. A phrase that fits no field, or fits two, is a decision.

| Field | Phrases that set it | Default |
|---|---|---|
| target | a branch, worktree path or PR URL | inferred |
| executor | "… as executor", "… as implementer" | [recommended](#recommendations) |
| bugs, quality | "… for reviews" and "review agents …" set both; "bugs …" or "quality …" sets one | recommended |
| simplify | "… for simplify" | recommended |
| prover | "… for proof" | the executor's target |
| rounds | "max N rounds of review" | 3 |
| simplify rounds | "max N rounds of simplify" | equal to rounds |
| switches | "after round N, change X from A to B" | none |
| reviewer checkouts | "own checkouts" or "worktrees" sets `own` (`isolation: "worktree"`); "shared checkout" or "no worktrees" sets `shared` | `own` |
| decision mode | "autonomous", "don't ask", "I'm away" | ask |
| proof | "/show-me", "proof", "show me it works" | off |
| CI wait | "wait for CI", "until checks pass", "babysit" | off |
| grants | the grant phrases in [SKILL.md](../SKILL.md#decisions-grants-stops) | none |

A **switch** names the round it starts at, the roles it changes and the new target. "After review round 1 is finished, change reviewers to X" starts at round 2. The switch's "from" model is a check: a mismatch with the role's current target is a decision.

Each grant needs its own phrase. "Push" alone is an ordinary push.

## Resolving targets

1. **Provider.** "claude" and the Claude family names (opus, sonnet, fable, haiku) mean `claudeAgent`. "gpt", "codex" and the family names in the `codex` catalog mean `codex`. Another provider applies only when the user names it, even when it lists the same model.
2. **Model.** Match the family and version against that provider's catalog. A bare family takes the newest listed member, and a version picks that one: "opus 5.5" is `claude-opus-5-5`, "gpt sol 6.1" is `gpt-6.1-sol`. A name missing from the short list gets one `orchestrator_capabilities` call with `search`.
3. **Effort.** The level word that follows the model, from that model's own option list. The option id is `effort` for `claudeAgent` and `reasoningEffort` for `codex`. A level the model lacks is a decision, with the nearest listed level recommended.
4. **Fill-ins.** A model named without an effort takes the role's recommended effort when it is the recommended model, and the model's default otherwise. Mark each fill-in in the ledger.
5. **Constraints.** `simplify` on a provider other than `claudeAgent` is a decision, with the Claude recommendation recommended ([briefs.md](briefs.md#reviewer)).

The ledger shows each role as `provider / model / option=level`, beside the phrase it came from.

## Recommendations

Map these onto today's catalog. When an evidence model or level is gone, recommend its nearest current equivalent and mark the substitution.

| Role | Recommendation | Evidence from Rex runs up to 2026-09 |
|---|---|---|
| `executor` | `claudeAgent / claude-opus-5-5 / effort=medium` | Opus at medium executed tickets reliably. |
| `bugs`, `quality` | `codex /` the most capable listed model `/ reasoningEffort=xhigh` | A Codex model at xhigh found issues the Claude reviewers had missed. |
| `simplify` | `claudeAgent / claude-opus-5-5 / effort=high` | Opus at high caught structural issues across review rounds. |

## Worked example

> claude opus 5.5 medium as executor/implementer and max 3 rounds of review and max 1 round of simplify. use claude sonnet max for reviews and opus 5.5 high for simplify. run checks, and you are allowed to force push with lease. i need you to go into autonomous mode where if any question arises, you research the decision and make a recommended approach and do that. state decisions like these in the report you give once everything is done. fix obvious bugs that occur, even though out of scope. /show-me report irrefutable proof that this works and push the PR once happy. after review round 1 is finished change review agents from sonnet to gpt sol 6.1 max

| Field | Resolved |
|---|---|
| target | inferred |
| executor | `claudeAgent / claude-opus-5-5 / effort=medium` |
| bugs, quality | round 1: `claudeAgent / claude-sonnet-5-5 / effort=max` |
| simplify | `claudeAgent / claude-opus-5-5 / effort=high`, round 1 only |
| prover | the executor's target (fill-in) |
| rounds | 3 |
| reviewer checkouts | `own` |
| switches | from round 2, bugs and quality: `codex / gpt-6.1-sol / reasoningEffort=max` |
| decision mode | autonomous |
| proof | on |
| CI wait | off |
| grants | `force-push`, `open-pr`, `fix-obvious-bugs` |
