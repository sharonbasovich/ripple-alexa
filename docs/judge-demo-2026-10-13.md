# Judge-demo follow-up — 2026-10-13

Base: `fb1da1ea9401606b2c0a8412eeec4d716fbb4f2d`.

**MEDIUM usability issue:** a fresh visitor to the public Pages app could choose
“Connected MCP demo” and reach a disabled Connect button plus local setup
instructions. The working fictional plan requires no credentials or setup,
but this adjacent route made that first-run path less clear.

The production navigation now says **Local MCP setup**. That view offers
**Try offline preview** as an explicit return to the interactive plan, and keeps
the local commands behind a disclosure. Development retains **Connected MCP
demo** and its real connection behavior. Switching back preserves the current
synthetic plan; this is not an automatic fallback after an MCP transport failure.

A mounted regression failed before repair and passes afterward. It changes
arrival, opens the static setup route, returns to the working preview and
compares the saved snapshot byte-for-byte. All 28 simulator/DOM, 77 engine and
12 MCP tests pass, as do lint, typecheck and build. An independent read-only AI
reviewer approved and independently ran 28/28 simulator tests and typecheck.
Production Chrome checks cover keyboard return, plan preservation, reset and
desktop/375 px guide rendering; remote CI and capture gate publication.

Applied selected Markdown checks from Impeccable revision
`2f98774f86bc05563876643db37e6c37c322850f`:
[onboard](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/reference/onboard.md),
[clarify](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/reference/clarify.md),
[harden](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/reference/harden.md),
[animate](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/.agents/skills/impeccable/reference/animate.md).
No skill runtime, new dependency, tour, animation or user-study gate was added.
Samples are deliberate judge-demo data. Policies, consent, frozen traces and
videos remain unchanged.
