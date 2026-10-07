# Ripple connected MCP capture plan

**Target runtime:** 2:00 at 1280×900. The capture is raw browser footage with
separate VTT captions; it has no narration audio. Use
`capture-action-log.json` to synchronize narration against the actual UI and
server actions.

## Story

**“Your flight moves. Your hotel, ride and dinner don’t move with it.”** Maya’s
parents change their Friday arrival to Saturday morning, and the guest count
changes from two to three. The browser connects to Ripple’s local MCP server,
shows seven proposed operations and the unchanged Sunday departure, and confirms
that existing commitments have not yet changed. Review only the restaurant
cancellation with its simulated $75 fee. Approve that exact operation, show
that approval alone changes no commitment, then execute separately. Finish on
one completed cancellation, six live commitments, a $75 sunk fee, and six other
proposals still awaiting decisions.

The UI identifies `$329 / $300` as a projection including pending proposals and
explicitly says it is not completed spend. Keep this qualifier visible when
framing the number.

## Timed capture

| Time | Picture and real action | Narration / caption |
| --- | --- | --- |
| 0:00–0:08 | Start on the offline preview's persistent fiction disclosure. The hook is narration, not a recreated title card. | “Your flight moves. Your hotel, ride and dinner don’t move with it.” |
| 0:08–0:20 | Select Connected MCP demo and connect. Show the real initialized session and seven tools. | “Maya’s parents now arrive Saturday morning, and one more guest is coming. The browser connects to our self-hosted MCP server.” |
| 0:20–0:28 | Show the initial server facts and expanded current commitment parameters, including the Sunday 17:00 departure. | “The starting plan is Friday evening to Sunday at five, with two guests.” |
| 0:28–0:40 | Send the Saturday arrival and guest-count change. Show seven operation cards and the server’s unchanged commitment parameters. | “The server proposes seven operations. Sunday stays fixed, and no existing commitment has changed.” |
| 0:40–0:52 | Review only the arrival-day restaurant cancellation. Frame its $75 fee, operation ID, payload hash and facts revision. | “I’m reviewing only the restaurant cancellation. Its simulated fee is $75.” |
| 0:52–1:06 | Approve the exact operation. Show the approved state awaiting `execute_approved`, with zero sunk fees and all seven commitments live. | “I approve this exact operation. Approval alone changes no commitment; execution is still pending.” |
| 1:06–1:20 | Click the separate execute action. Show one executed operation and six proposed operations. | “Now I execute separately. One cancellation completes; the other six proposals still await decisions.” |
| 1:20–1:32 | Briefly show actual browser request/response rows for initialization, tools/list, apply_change, confirm_ops, execute_approved and final get_status. | “These are real request and response exchanges from the browser and local MCP server.” |
| 1:32–2:00 | End on the server state: six live commitments, six open decisions, $75 sunk fee, and the labelled $329/$300 projection. | “The projection includes pending proposals; it is not completed spend. The services and fees are fictional.” |

## Capture guardrails

- Capture against the real localhost Vite app and self-hosted Streamable HTTP
  server. Keep raw browser footage, the downloaded JSON-RPC trace, viewport
  screenshots, and the timestamped action log together.
- The narration must follow the action log. Do not fake UI, fabricate request
  rows, or claim that the hotel phrase refers to a separate MCP tool or booking
  visible in this app.
- Preserve the persistent synthetic-data disclosure. Do not imply a real
  reservation, charge, Alexa runtime, or Alexa integration.
- Keep the request/response panel brief. The raw capture has no voice track; the
  VTT remains separate for alignment and editing.
- No public upload or Devpost change is part of this capture preparation.
