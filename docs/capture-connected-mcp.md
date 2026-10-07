# Connected MCP demo capture

The capture workflow runs the repository's local app and self-hosted MCP server
on an ephemeral GitHub Actions runner. Chromium uses the application's real
browser MCP client through Vite's localhost `/mcp` proxy; the capture is not a
mock or a recording of the offline planner.

## Trigger and artifact

- Opening or updating a pull request that changes the capture workflow, capture
  script, captions, engine, server, app, or lockfile runs the capture job.
- After the workflow is merged, `workflow_dispatch` can produce another run.
- Download the `ripple-connected-mcp-capture-<commit>` artifact from that run.
  It contains the raw WebM, viewport screenshots, VTT captions, a timestamped
  action log, downloaded browser JSON-RPC trace, localhost network summary,
  server/Vite logs, and a manifest with the exact tested commit and duration.

The action log records elapsed milliseconds for browser actions, screenshots,
verified server states, and planned holds. Use it to align separately produced
narration with the real capture. The raw WebM has no narration audio. Do not
invent or recreate screens to fit a narration line.

## Story and safety

The 105.850-second story follows Maya's parents moving their Friday arrival to
Saturday morning and the guest count changing from two to three. The browser
connects to the self-hosted MCP server, shows seven proposed operations and an
unchanged Sunday departure, confirms existing commitments are unchanged, then
reviews only the arrival-day restaurant cancellation and its simulated $75 fee.
Approval binds to that exact operation and does not change a commitment; the
separate execute action completes one cancellation. The ending shows six live
commitments, six open decisions, and a $75 sunk fee.

The UI labels `$329 / $300` as a projection including pending proposals and as
not completed spend. The Playwright mouse ring and disclosure strip are
capture-only overlays. They do not alter app text, MCP requests, tool responses,
approval binding, or server state. The captions are a separate VTT file.

All services and fees are fictional; no real bookings, charges, Alexa runtime,
or Alexa integration are involved. The existing 1:49 `docs/demo.mp4` and its
captions describe the earlier offline engine flow. They are not reused as
connected-MCP footage or copied as the new captions.
