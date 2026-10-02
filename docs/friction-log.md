# Friction log — honest observations

Two categories, kept separate: **implementation bugs we introduced and fixed**
(our code, verified with regressions) and **tool/platform observations**
(things actually experienced while building, not attributed to Amazon or to
tools we never touched).

## Tool / platform observations (genuine, from this build)

| # | Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|------|-------|----------|--------|----------|------------|------------|
| 1 | Confirm Alexa+ dev tooling for the sim track | Read rules + forum clarification | Some preview/SDK path for entrants | Per the contest FAQ, official preview tooling is not available to entrants; the rules explicitly allow a simulated web experience | Low (documented constraint, not a failure) | Built a deterministic simulation, labelled as such, per the organizer clarification | Publish a minimal intent/schema sandbox for the simulation track — even a static schema checker would let entrants validate designs against something real |
| 2 | TypeScript strictness vs. `exactOptionalPropertyTypes` | Set optional fields to `undefined` | Compiles | TS2375/TS2379 errors — `X | undefined` fields can't be assigned `undefined` explicitly under the flag | Low | Omit keys or `delete` instead of assigning `undefined` | Document this as a recipe; the error message is correct but non-obvious on union-typed optional props |
| 3 | Vite version skew in npm workspaces | Root devDep vite (hoisted by vitest) newer than app's pinned vite + plugin | `vite.config.ts` typechecks | Cross-version rollup/plugin type conflict between the app's vite and the hoisted newer vite | Low | Keep `vite.config.ts` out of the app tsconfig `include` | Workspaces that pin different vite majors should warn on mixed plugin type resolution |
| 4 | Devin agent workflow | Independent review ran against a pushed SHA while fixes were in flight | Review always lands on latest | Static findings referenced the older SHA — required explicit "reproduced at HEAD before fix" bookkeeping per item | Low | Reproduced each finding against the exact commit, then again post-fix | A "findings keyed to SHA" view would reduce reconciliation overhead on fast-moving sessions |
| 5 | `npm run lint` after moving a vendored file | Moved `axe.min.js` from `public/` to `docs/tools/` | Same ignore coverage | 7,000+ lint errors — the vendored minified file was re-linted from the new path | Low | Added `docs/tools/**` to eslint ignores | Lint setups should flag "newly un-ignored large minified files" rather than emitting thousands of token errors |
| 6 | `Number('')` coercion in a number input | Clear the guests field, submit | Obvious error | `Number('') === 0` — a blank field would have silently submitted guests=0 if the engine hadn't rejected it | Medium (real UX hazard, caught) | Explicit empty-string rejection before coercion | Form libs should expose `valueAsNumber | null` semantics without the `0` footgun |

## Implementation bugs found in review — fixed, with regressions

These were OUR defects in `packages/engine` and `apps/sim`, found in
review of commits `6aab901`/`0f01e99`, fixed, and locked in by `packages/engine/test/regressions.test.ts`. Listed so the
demo doesn't overclaim — none of these are tool or Amazon failures.

- Executed `update` ops changed params but not `commitment.cost` — a repriced
  party size dropped $40 from the tracked spend.
- Causal recall inferred causes from dependency graphs and counted
  approved-but-unapplied ops as "changed" — a guests-only edit appeared in
  flight recall.
- Substring parser turned negations ("my brother is not joining"), chatty
  mentions ("likes pizza"), and malformed numbers ("2.5 guests", "$250.50",
  "-2") into edits; compound commands half-parsed.
- Cached fee consent: a $0 cancellation approved >24h out would execute
  inside the late window at the stale price — fees are now re-quoted at
  execution and stale consents bounce back for a fresh decision.
- Re-proposals minted identical op ids, so approving a fresh op could
  resolve a superseded predecessor; op ids now carry a proposal scope.
- Generated top-up commitments were orphaned by later diffs, and
  alternative-kind ops could overwrite an existing paid order.
- Stale async pings could confirm a cancelled+rebooked commitment sharing
  the id — now fenced by a mandatory monotonic booking occurrence.
- Declined dynamically-generated alternatives were re-offered on re-check.
- Fact editor sent string values the engine correctly rejected, stale form
  fields could revert newer facts, and blank inputs coerced to 0.
- Snapshot validation was shallow (`typeof object` only) — now enum/shape
  deep validation with a schema bump and a visible "old demo data cleared"
  notice.

## Remaining limits (stated, not hidden)

- Deterministic simulation only — no real Alexa runtime, no network calls,
  no outbound actions. Official preview tooling is not available to
  entrants (see item 1), so simulation-fidelity claims stop at "models
  documented behaviors".
- State is device-local `localStorage`, single browser tab; no concurrency.
- Simulated wall-clock is UTC-labelled; no DST modeling (fixture avoids it).
- Intent parser is deliberately bounded — clarify/unknown for anything
  outside the grammar rather than guessing.
