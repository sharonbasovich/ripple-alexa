# Ripple

**Change one thing. Everything that depended on it gets repaired — and only that.**

Ripple is an explicitly **simulated Alexa+ experience**: a deterministic, consent-first
model of how an assistant *should* reconcile a plan when real life moves. Maya's parents
are visiting Friday–Sunday; their flight moves to Saturday morning and one more adult
joins. Across five simulated services — calendar, grocery delivery, restaurant
reservations, household routines and pickup reminders — Ripple computes the minimal
diff, shows every affected commitment with before/after parameters, asks for explicit
consent where money or irreversibility is involved, and tells the truth about the
things it cannot fix.

Everything is fictional. Nothing real is booked, charged or dispatched. All data is
synthetic and stays on your device.

## Why it's different

| Claim | Where it's enforced |
| --- | --- |
| Causal reconciliation, not a canned animation | `packages/engine/src/planner.ts` — a dependency graph (`dependsOn`) over typed facts; the diff only touches commitments whose dependencies changed. |
| Exact consent | `opPayloadHash` over the normalized op payload **plus** the facts version. Approving a stale payload or a superseded revision is rejected distinctly. |
| Honest irreversible outcomes | A dispatched grocery order *cannot* be rescheduled — the service rejects the op at execution, keeps the original, and the app offers a separately-consented paid alternative. Sunk fees stay on the receipt forever. |
| Persistence | Versioned, validated `localStorage` snapshot. Pending choices, declines and sunk fees survive reload; a corrupt blob resets safely instead of crashing. |
| Later-session causal recall | "What changed because of the flight?" is answered from the ledger + dependency graph — any number of reloads later. |
| Determinism | Zero I/O, zero randomness, zero wall-clock access in `packages/engine`. A replay of the journal must reproduce the world *and* the ledger byte-for-byte — a tested invariant, not a hope. |

## Design review gates (honored)

- Changing **arrival** never moves **departure** — the preview states this every time.
- Consent binds to normalized op payload + facts revision, not a plan label.
- Completed/unknown outcomes and sunk fees stay truthful across replan, retry, reload.
- "Reset demo" clears **only** synthetic local demo data, and says so.
- One explicit **simulated clock** drives every dispatch/cancellation window — the demo
  never depends on what weekday it really is.
- All fixture prices, fees and policies are labelled fictional in-app and in code.

## Quick start

```bash
npm install
npm run dev        # Vite dev server
npm run build      # production build (apps/sim/dist)
npm run typecheck  # strict TS across workspaces
npm run lint       # eslint
npm test           # engine: unit + integration + property tests
npm run test:sim -w @ripple/sim       # sim state-layer tests (Node/vitest — not a browser run)
npm run test -w @ripple/mcp-server    # MCP wrapper: real HTTP transport + engine parity
npm run mcp                           # optional local MCP inspector at http://127.0.0.1:8787/mcp
                                      # (dev tool — NOT an Alexa add-on; loopback only)
```

The deployed site is a fully static build — no backend, no network calls, no
microphone, no LLM. Optional browser speech synthesis reads summaries aloud
(< 75 words); text is always present.

## Repository layout

```
packages/engine   Pure deterministic core: facts, diff, consent, ledger, replay, policies
apps/sim          Vite + React simulated Alexa+ experience (the demo)
apps/mcp-server   Optional local-only MCP inspection wrapper (dev tool, NOT an Alexa add-on)
docs/             Demo script, Devpost draft, friction log, screenshots
.github/workflows Pages deploy (typecheck + lint + all test suites gate the artifact)
```

## Verification

- **1,200 randomized action sequences** (≈7,200 actions) assert invariants on every
  step: valid facts, fee ledger integrity, approve-before-execute, monotonic event
  sequencing, no resurrection of cancelled commitments, serialize/reload round-trip,
  and **full journal-replay equality** of world and ledger.
- A→B→A oscillation including sunk fees, decline/repeat, interrupted reloads,
  expired and stale approvals, invalid-input non-mutation, budget infeasibility,
  unknown utterances, duplicate clicks and partial failure — all covered by the
  engine suite.
- The property tests already caught and now guard two real bugs: lazy-expiry
  mutating the ledger during reads, and op `before`/`after` objects aliasing live
  commitment params.
- Browser checks: desktop, 390 px phone-width and the in-app device-size switch,
  keyboard path, axe scan — see `docs/friction-log.md` and screenshots.

Single-tab only: cross-tab synchronization is not implemented or claimed.

## Honest limits

- This is a **simulation** — it demonstrates the reconciliation contract, not a live
  Alexa+ integration, and claims none.
- The intent parser is deliberately bounded; unknown text returns examples and
  changes nothing. The fact editor covers arbitrary supported edits.
- Fixture policies (8 h grocery dispatch cutoff, $25/seat <24 h restaurant fee,
  same-day-only restaurant edits) are fictional demo data.
- State is device-local `localStorage`; one browser tab at a time.

## License

MIT — see [LICENSE](LICENSE). Built for the Amazon App Dev 2026 hackathon,
Alexa+ simulation track. Contains no Amazon marks, no real services and no
claims of Amazon integration.
