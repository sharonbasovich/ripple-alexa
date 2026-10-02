# Devpost draft — Ripple

*(Draft copy for submission; root reviews and posts. Do not submit from
Devin sessions.)*

## Tagline

Change one thing. Alexa fixes everything that depended on it — and only that.

## Inspiration

Planning tools treat every change as a fresh problem: re-plan the whole trip
and hope nothing important silently changed. Real assistance is the opposite —
a tiny change should ripple exactly as far as it must and stop. Ripple makes
that ripple visible, causal, and consented.

## What it does

Ripple is a simulated Alexa+ experience for hosting a 3-day family visit.
Five simulated services (calendar, grocery delivery, restaurant
reservations, household routines, pickup reminders) hold a coherent plan
against a fictional $300 budget. When one fact changes — the flight moves,
one more adult joins — Ripple computes the *minimal* repair:

- **Causal reconciliation** — a typed dependency graph produces only the ops
  the change actually requires; unrelated commitments provably stay put.
  Each op carries immutable provenance naming the fact event that caused it.
- **Exact consent** — every op binds to a normalized payload hash + state
  revision. Facts changing, windows expiring, or prices drifting all
  invalidate consent truthfully; a fee that changed since approval bounces
  back for a fresh decision instead of silently charging the new price.
- **Honest irreversible outcomes** — services distinguish
  pending/confirmed/dispatched/completed. A dispatched grocery order can't
  be un-dispatched: the original stays billed and a separately-approved,
  separately-priced top-up is offered. Fees are sunk and never netted as
  "savings".
- **Persistent state** — the world lives in an append-only causal ledger
  plus a replayable journal: replay(journal) reproduces the entire world —
  tested, not claimed. Pending decisions survive reloads.
- **Later-session causal recall** — "What changed because of the flight?"
  answers from the ledger's actual fact-change events, labeling each item
  proposed / approved / applied.

## How we built it

TypeScript npm workspace. `packages/engine` is a pure deterministic core
(typed facts, desired-state diff, consent binding, lifecycle policies,
ledger+journal replay) with zero I/O — the same code powers the UI and the
tests. `apps/sim` is a Vite+React single-page app with an utterance
composer, a real fact editor, a causal receipt ledger, and an explicit
simulated-clock control. An optional `apps/mcp-server` wraps the same
engine as a localhost-only MCP inspection tool (dev tool, not an Alexa
add-on).

**Verification**: 75 automated tests including a property suite that runs
1,000+ randomized action sequences per run asserting idempotence,
unaffected-action preservation, minimal diffs, exact consent/fee gating,
sunk-fee honesty, complete-state replay equality, and causal provenance —
plus 28 targeted regression tests written against defects found in
independent review (each reproduced before fixing). Lint, strict
typecheck, and production build all pass in CI on every push.

## Challenges

The honest ones: making "minimal" provable (the diff must not touch
departure-scoped commitments when only arrival changes — and the property
tests caught two cases where it did); keeping consent exact under clock
drift (a fee can change *between* approval and execution — we re-quote
instead of hoping); and causal attribution in multi-fact batches (a
departure-only effect must never appear in the arrival recall — ops now
carry stamped provenance through re-proposals). See
`docs/friction-log.md` for the full, unflattering list.

## Accomplishments

- A planner that is *provably* minimal and causal — the property suite
  would catch us lying.
- Consent that can't be tricked by stale prices, expired windows, replayed
  clicks, or superseded proposals.
- Truthful partial failure everywhere: rejected ops, stale async pings
  (fenced by booking occurrence), declined-but-remembered choices, sunk
  fees.
- The whole demo is explainable from one artifact: the append-only ledger.

## What we learned

Determinism is a feature, not a limitation: injecting the clock and making
the journal replayable turned "did we break recall?" into a 1,000-sequence
property test instead of a demo-day prayer. Also: independent review is
brutal and worth it — most of the interesting bugs were ours, and each is
now a regression test.

## What's next

- Multi-tab concurrency semantics (single-tab limit is documented honestly).
- Richer service policies (waitlists, partial refunds with reason codes).
- The localhost MCP wrapper as the bridge to a real runtime, when official
  preview tooling becomes available to entrants.

## Built with

TypeScript, React, Vite, Vitest — and Devin (AI-assisted implementation
with human-directed independent review; disclosed per rules).

## Honest limitations

Simulated experience — no real Alexa runtime or integration exists or is
claimed; no AWS services used; all prices/policies are fictional fixture
data; state is device-local (one browser tab); no voice input (optional
text-to-speech output only); no Amazon marks.
