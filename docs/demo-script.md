# Demo script — Ripple (simulated Alexa+ experience)

Target: ~2:20, under the 3-minute limit. All numbers on screen come from the
live engine — nothing is scripted into the UI. Record real footage of the
deployed Pages build (or `npm run dev`).

Simulated clock control (top-right) is the session's only time source; it is
explicitly labelled. Everything below is a real interaction, not a canned
animation.

## 1. The plan (0:00–0:20)

- Fresh load: "Family visit — Friday 18:05 → Sunday 17:00 · 2 adults · $300
  budget". Budget pill shows committed spend under budget.
- Point at the board: 7 commitments across 5 fictional services (calendar,
  grocery delivery, restaurant, routines, pickup reminders), each with a
  lifecycle state badge (confirmed / dispatched / pending).
- Persistent label in header: "Simulated Alexa+ experience — fictional
  services". No Amazon marks anywhere.

## 2. The change (0:20–0:50)

- Click the preset: **"New plan: arrive Sat 9:40 · one more guest"**.
- Preview modal: arrival Fri 18:05 → Sat 09:40, guests 2 → 3; explicit note
  "Departure stays Sunday 17:00 — the visit gets shorter, it never silently
  stays three nights." Confirm.
- The affected-count line appears; the board highlights exactly the
  commitments that depend on the changed facts. Departure-day lock-up is
  visibly untouched.

## 3. Minimal diff + honest outcomes (0:50–1:30)

- "Needs your decision" cards: each shows before → after, a "Because …
  changed" line naming the real fact(s), fee/consent flags.
- Restaurant: same-day-only policy → cancel + rebook, with the fictional
  cancellation fee shown BEFORE consent (irreversible note included).
- Grocery: already dispatched — the update is rejected truthfully and a
  separately-priced top-up alternative is offered instead; the original
  delivery stays on the board as dispatched+billed.
- Approve one op, decline another (decline records "kept as booked", does
  not re-ask). Click **Apply** — partial outcomes are shown truthfully
  (applied / rejected, never a contradictory receipt).

## 4. Idempotence + persistence (1:30–1:50)

- Re-submit the same change → "No fact actually changed — nothing to do."
- Reload the page (or reset): pending decisions and the ledger persist via
  device-local storage; declining stays declined across reloads.
- Clock control: advance simulated time past a decision window → cards show
  explicit expiry, nothing executes unapproved; Re-check re-proposes with
  fresh consent scope.

## 5. Causal recall (1:50–2:05)

- Ask: "What changed because of the flight?" → recall lists only
  arrival-caused commitments with what changed and whether each was
  applied / approved / proposed — a guest-only edit never appears.

## 6. Unscripted + responsive (2:05–2:20)

- One unscripted fact edit in the editor (e.g. departure → Monday 9:00):
  validation preview, diff, decisions — showing this isn't a canned demo.
- Toggle "Phone size" (or real 390px viewport): layout reflows, no clipping.
- Optional: voice toggle reads a <75-word summary via browser speech
  synthesis; the same text stays on screen.

## 7. Close (2:20–2:25)

- Receipts tab: the append-only causal ledger — every event links to the
  fact that caused it. Reset button: "clears synthetic local demo data only."

## Capture notes

- Measure duration; keep under 3:00.
- Include the on-screen simulation disclosure and a closing line on
  limitations (simulation, fictional services, device-local state,
  single-tab).
- No music, no trademark imagery, no invented metrics — counts come from
  the running engine.
