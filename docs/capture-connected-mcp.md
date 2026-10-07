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
  It contains the raw WebM, viewport screenshots, VTT captions, downloaded
  browser JSON-RPC trace, localhost network summary, server/Vite logs, and a
  manifest with the exact tested commit and duration.

The Playwright mouse ring and disclosure strip are capture-only overlays. The
browser app text, MCP requests, tool responses, approval binding, and server
state are not altered. The captions are a separate VTT file; the raw WebM has
no narration audio and is not a polished edit.

## Story and safety

The 2:15 script keeps the outcome central: connect to the self-hosted server,
propose a Saturday arrival and one additional guest, review the synthetic
restaurant cancellation fee, approve only that exact operation, then execute
it in a separate action. The ending shows the final server state and briefly
opens the real JSON-RPC exchange evidence. All services and fees are fictional;
no real bookings, charges, Alexa runtime, or Alexa integration are involved.

The existing 1:49 `docs/demo.mp4` and its captions describe the earlier offline
engine flow, including multiple approvals and other behaviors. They are not
reused as connected-MCP footage or copied as the new captions.
