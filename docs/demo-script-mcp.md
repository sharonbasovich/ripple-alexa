# Ripple connected MCP capture plan

**Target runtime:** 105.850 seconds at 1280×900. The capture is raw browser
footage with separate VTT captions; it has no narration audio. Use
`capture-action-log.json` to synchronize narration against the actual UI and
server actions.

## Story

**“Your plans change. Your commitments don’t change with them.”** Maya’s parents
move their Friday arrival to Saturday morning, and the guest count changes from
two to three. The browser connects to Ripple’s local MCP server, shows seven
proposed operations and the unchanged Sunday departure, and confirms that
existing commitments have not yet changed. Review only the restaurant
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
| 0:00–0:01.800 | Start on the offline preview's persistent fiction disclosure. The hook is narration, not a recreated title card. | “Your plans change.” |
| 0:01.800–0:04.375 | Keep the real app visible; do not add a title card. | “Your commitments don’t change with them.” |
| 0:04.375–0:08.350 | Switch to Connected MCP demo at the planned 0:06 point; let the real connection begin. | “Ripple brings those consequences together, before you commit.” |
| 0:08.350–0:09.100 | Hold the real UI in silence while initialization completes. | (silence) |
| 0:09.100–0:18.000 | Show the initialized session and seven tools while narrating the facts change. | “Maya’s parents move their Friday arrival to Saturday morning; guests go from two to three. The browser connects and lists seven tools.” |
| 0:18–0:24 | Show initial server facts and expanded current commitment parameters, including Sunday 17:00 departure. | “The baseline departure remains Sunday at five.” |
| 0:24–0:36 | Send the Saturday arrival and guest-count change. Show seven operation cards and the server's unchanged commitment parameters. | “Seven operations are proposed. Sunday stays fixed, and existing commitments have not moved.” |
| 0:36–0:47 | Review only the arrival-day restaurant cancellation. Frame its $75 fee, operation ID, payload hash and facts revision. | “I’m reviewing only the restaurant cancellation. Its simulated fee is $75.” |
| 0:47–0:58 | Approve the exact operation. Show the approved server state, then the card awaiting `execute_approved`. | “I approve this exact operation. Approval alone changes no commitment; execution is still pending.” |
| 0:58–1:10 | Click the separate execute action. Show one executed operation and six proposed operations. | “Now I execute separately. One cancellation completes; the other six proposals still await decisions.” |
| 1:10–1:20 | Briefly show actual browser request/response rows for initialization, tools/list, apply_change, confirm_ops, execute_approved and final get_status. | “These are real request and response exchanges from the browser and local MCP server.” |
| 1:20–1:36 | End on the server state: six live commitments, six open decisions and a $75 sunk fee. | “The server reports six live commitments, six open decisions, and one simulated $75 sunk fee.” |
| 1:36–1:45.850 | Keep the final state visible with the labelled $329/$300 projection. | “The projection includes pending proposals; it is not completed spend. Services and fees are fictional.” |

## Capture guardrails

- Capture against the real localhost Vite app and self-hosted Streamable HTTP
  server. Keep raw browser footage, the downloaded JSON-RPC trace, viewport
  screenshots, and timestamped action log together.
- The narration must follow the action log. Do not fake UI, fabricate request
  rows, or claim services not present in the prototype.
- Preserve the persistent synthetic-data disclosure. Do not imply a real
  reservation, charge, Alexa runtime, or Alexa integration.
- Keep the request/response panel brief. The raw capture has no voice track; the
  VTT remains separate for alignment and editing.
- No public upload or Devpost change is part of this capture preparation.
