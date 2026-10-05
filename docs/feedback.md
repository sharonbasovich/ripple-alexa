# Product feedback

Per-tool answers for everything actually used in this build. For each: what we
used it for, what worked well, what needs work, what onboarding was like, and
whether we'd use it again. Genuine observations only — nothing attributed to
tools we never touched.

## Contest platform context

The rules for this track allow a simulated Alexa+ web experience, and the
organizer forum clarification permits a deterministic simulation. Per the
contest FAQ, official Alexa+ preview tooling (SDKs, MCP add-on runtimes) is not
available to entrants — so there is no sponsor SDK onboarding to review here.
That gap itself is our main platform observation, listed as item 1 of the
friction log: even a static intent/schema sandbox would let simulation-track
entrants validate designs against something real.

## Tools actually used

### TypeScript (5.9.2, strict + `exactOptionalPropertyTypes`)

- **Used for**: the entire codebase — pure engine, React app, typecheck gate in CI.
- **Worked well**: strict mode plus `exactOptionalPropertyTypes` caught a whole
  class of "field present but undefined" bugs at compile time, especially around
  optional op/commitment fields. Discriminated unions (`Op`, `JournalEntry`,
  `Intent`) made the deterministic state machine easy to keep honest.
- **Needs work**: under `exactOptionalPropertyTypes`, explicitly assigning
  `undefined` to an optional field fails with errors that read like ordinary
  type mismatches; the "omit the key or `delete` it" fix is correct but not
  obvious. A dedicated error hint would help.
- **Onboarding**: trivial — `npm i -D typescript`, `tsc --noEmit`.
- **Use again?** Yes — the compile-time guarantees are exactly what a
  replay/state-equality demo needs.

### Vite (7.3.6)

- **Used for**: dev server and production build of `apps/sim`; the Pages
  artifact is a plain static `vite build` output.
- **Worked well**: instant startup and HMR made the UI fix–verify loop fast;
  the production build is a single static folder, perfect for free Pages
  hosting.
- **Needs work**: version skew inside npm workspaces produced confusing
  rollup/plugin type conflicts until `vite.config.ts` was kept out of the app
  tsconfig. The 7.0–7.3.3 dev-server advisories (now patched in 7.3.6) were a
  reminder to keep it current — our shipped artifact is static, so runtime
  exposure was nil.
- **Onboarding**: minutes.
- **Use again?** Yes.

### React (19.1.1) + eslint-plugin-react-hooks

- **Used for**: all UI — plan board, op cards, preview modal, recall panel,
  simulated controls.
- **Worked well**: the hooks lint caught a real pattern violation early
  (`set-state-in-effect`); the "adjust state during render" alternative the docs
  recommend was a cleaner fix than an effect would have been. No external state
  library needed — the engine owns all state.
- **Needs work**: nothing material for this scope.
- **Onboarding**: trivial via Vite plugin.
- **Use again?** Yes.

### Vitest (5.0.3)

- **Used for**: all 88 tests — engine unit/integration, a 1,200-sequence
  property suite, sim state tests, and the MCP transport tests.
- **Worked well**: fast, deterministic, same config pattern in every workspace
  package; the property suite caught two real engine bugs (lazy-expiry ledger
  mutation, op `before` aliasing) before review did.
- **Needs work**: nothing material; note that 4.x carries a `mocker` path-
  traversal advisory fixed in 5.x, which is why we run 5.0.3.
- **Onboarding**: zero-config with Vite.
- **Use again?** Yes.

### @modelcontextprotocol/sdk (1.31.0)

- **Used for**: `apps/mcp-server` — a localhost-only MCP inspection wrapper
  exposing the *same* engine over Streamable HTTP.
- **Worked well**: `registerTool` + zod input schemas produce well-formed tool
  definitions with almost no boilerplate, and the stateless
  per-request-server pattern works exactly as documented in the examples.
- **Needs work**: the "one server + transport per request" pattern required for
  stateless Streamable HTTP is easy to get wrong — our first attempt reused a
  single transport and got "Already connected" failures. More prominent
  stateless-mode guidance in the main docs would help.
- **Onboarding**: moderate — good examples exist, but the right pattern lives
  in the repo's example servers rather than the quickstart.
- **Use again?** Yes — it made the engine inspectable over real MCP transport
  with ~150 lines.

### axe-core (4.13.0, vendored dev tool)

- **Used for**: automated accessibility checks at 1165px, 390px, and the
  in-app phone-size toggle (run via a vendored `axe.min.js` against the real
  DOM over CDP).
- **Worked well**: caught real issues our keyboard-only checks missed —
  invalid list semantics (`role=list` over `<section>` children), an element
  outside any landmark, a heading-level skip, and low-contrast badge/pill
  combinations. All were fixed and re-verified to zero violations.
- **Needs work**: nothing material.
- **Onboarding**: trivial for scripted use — inject the script, run, read
  violations.
- **Use again?** Yes — it's now part of the repo's check tooling.

### Playwright (`playwright-core` over CDP)

- **Used for**: scripted browser verification — viewport metrics, overflow
  measurement, keyboard focus paths, axe injection, screenshots.
- **Worked well**: `connectOverCDP` against the running Chrome meant no
  browser downloads and real-fidelity checks; `getBoundingClientRect`-based
  overflow measurement caught a 496px-vs-358px phone-frame defect that
  screenshots alone didn't prove.
- **Needs work**: the `--no-save` install gets pruned by the next `npm
  install` — a small gotcha we hit twice.
- **Onboarding**: moderate; CDP attach is a documented but less-traveled path.
- **Use again?** Yes.

### Devin (AI development agent)

- **Used for**: this entire build — engine, app, tests, docs, review-fix loop.
- **Worked well**: the long fix loop across many independent review rounds
  stayed coherent; reproduction-then-regression discipline fit the honest
  "show the failing case" requirement.
- **Needs work**: review cycles referenced pushed SHAs while fixes were in
  flight — reconciling "which finding applies to which commit" took explicit
  bookkeeping. Findings keyed to a SHA would cut that overhead.
- **Onboarding**: n/a — it's the agent.
- **Use again?** Yes.

### GitHub Actions

- **Used for**: lint, type checks, tests, build and deployment.
- **Worked well**: clean-checkout verification.
- **Needs work**: CI needed the MCP workspace build before its imports were used.
- **Onboarding**: existing GitHub accounts were reused, so this was not a new-account onboarding test. GitHub Actions and Pages required initial repository deployment setup and a verified first clean run.
- **Use again?** Yes, for reproducible checks.

### GitHub Pages

- **Used for**: hosting the public simulation.
- **Worked well**: free, reproducible deployment.
- **Needs work**: GitHub Pages needed repository setup.
- **Onboarding**: existing GitHub accounts were reused, so this was not a new-account onboarding test. GitHub Actions and Pages required initial repository deployment setup and a verified first clean run.
- **Use again?** Yes, for free hosting.

## Honest summary of remaining limits

- The app is a **simulation**: official Alexa+ preview tooling is unavailable
  to hackathon entrants (per the contest FAQ), and no claim of Alexa+
  integration is made anywhere.
- `localStorage` persistence is single-tab and device-local; no cross-tab or
  cross-device sync is implemented or claimed.
- The intent grammar is deliberately bounded — unsupported phrasing returns
  examples rather than guessing; the fact editor covers all supported edits.
- Speech output is optional browser TTS; it is off by default and never
  required.
