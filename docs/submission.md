# Devpost draft — Ripple

## Tagline

Change one thing. Alexa fixes everything that depended on it — and only that.

## The hook

Mom and Dad's flight moved to Saturday morning — but Friday's groceries are
already on a courier route, the arrival-day dinner still says Friday, and the
airport-pickup reminder is still set for Friday evening. Ripple shows what an
assistant should do in that moment: repair exactly what the change breaks,
charge what the change honestly costs, and leave everything else alone.

## What it does

Ripple is a simulated Alexa+ experience for hosting a 3-day family visit.
Five simulated services (calendar, grocery delivery, restaurant
reservations, household routines, pickup reminders) hold a coherent plan
against a fictional $300 budget. When one fact changes, Ripple computes the
minimal repair:

- **Causal reconciliation** — a dependency graph produces only the
  operations the change requires; unrelated commitments are listed as
  untouched. Each operation is stamped with the fact that caused it, and the
  stamp survives re-plans.
- **Exact consent** — every operation binds to a normalized payload hash +
  state revision. Changed facts, expired windows, or a price that drifted
  between approval and execution all stop the operation and require a fresh
  decision — never a silent charge at the new price.
- **Honest irreversible outcomes** — services distinguish
  pending/confirmed/dispatched/completed. A dispatched grocery order can't
  be un-dispatched: the original stays billed and a separately-approved,
  separately-priced top-up is offered instead. Fees are sunk and are never
  presented as savings.
- **Persistent state** — an append-only causal ledger plus a replayable
  journal. Pending decisions survive reloads; declined choices stay declined.
- **Later-session causal recall** — "What changed because of the flight?"
  answers from the ledger's recorded fact-change events, labeling each item
  proposed / approved / applied.

## How we built it

TypeScript npm workspace. `packages/engine` is a pure deterministic core
(typed facts, desired-state diff, consent binding, lifecycle policies,
ledger+journal replay) with zero I/O — the same code powers the UI and the
tests. `apps/sim` is a Vite+React single-page app with an utterance
composer, a fact editor, a causal receipt ledger, and an explicit
simulated-clock control. `apps/mcp-server` wraps the same engine as a
localhost-only MCP inspection tool for developers — it is not an Alexa
add-on and makes no network calls off the loopback interface. Consent can be
bound to the reviewed payload hash + facts revision, or taken at face value
by op id; either way it stays a developer inspector, not a consumer surface.

**Verification**: 88 automated tests — unit + integration + a property suite
running 1,000+ randomized action sequences per run asserting idempotence,
unaffected-action preservation, minimal diffs, consent/fee gating, sunk-fee
honesty, full-state replay equality, and causal provenance — plus targeted
regression tests covering defects found in independent review. Lint, strict
typecheck, all test suites, and the production build run in CI on every
push. These tests are regression evidence for the cases we covered, not a
proof of correctness.

## Challenges

Making "minimal" checkable: the diff must leave departure-scoped commitments
alone when only arrival changes (early versions didn't). Consent under clock
drift: a fee can legitimately change between approval and execution — the
engine re-quotes and requires a fresh decision rather than charging the
cached price. Causal attribution in multi-fact batches: a departure-only
effect must never appear in the arrival recall, and a pending effect must
keep its original cause when a later, unrelated edit triggers a re-plan.
The full list of defects found in review — ours, fixed, and locked in by
regressions — is in `docs/friction-log.md`.

## What we learned

Determinism is a feature: an injected clock and a replayable journal turn
"did we break recall?" into a repeatable property test. Review-driven fixes
are expensive in the best way — most of the interesting defects were ours,
and each hard-won case is now covered by a regression.

## What's next

- Multi-tab/concurrent-session semantics (single-tab limit is documented).
- Richer simulated policies (waitlists, partial refunds with reason codes).
- The localhost MCP wrapper as a bridge if official preview tooling becomes
  available to entrants.

## Built with

TypeScript, React, Vite, Vitest, @modelcontextprotocol/sdk — AI-assisted
development (Devin) with separate source and browser review.

## Honest limitations

Simulated experience — no real Alexa runtime or integration exists or is
claimed; no AWS services used; all prices/policies are fictional fixture
data; state is device-local `localStorage` (one browser tab, documented);
no voice input (optional browser text-to-speech output only); simulated
clock is UTC-labelled with no DST modeling; the intent parser is
deliberately bounded and clarifies rather than guesses; no Amazon marks.

**Demo video**: `docs/demo.mp4` (48s, under the 3:00 limit) — real app footage
with burned-in captions; transcript at `docs/demo-captions.txt`. Public
video upload and Devpost submission remain separate, human steps.

**Product feedback**: see `docs/feedback.md`; friction observations are in
`docs/friction-log.md`.