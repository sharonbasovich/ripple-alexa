# Browser MCP proof capture

Captured from Chrome on 2026-10-06 against the local checkout. The browser page
ran the repository's `@modelcontextprotocol/sdk` client and sent JSON-RPC over
Streamable HTTP through Vite's same-origin `/mcp` proxy to the loopback server.
This is synthetic demo state only.

## Reproduce

Start `npm run mcp` and `npm run dev` in separate terminals. Open
`http://127.0.0.1:5173`, select **Connected MCP demo**, then choose **Connect to
MCP server**. The page's **Browser JSON-RPC evidence** disclosure shows the
captured request and response bodies.

## Observed exchange

The browser completed these requests in order:

| JSON-RPC method | HTTP | Result |
| --- | ---: | --- |
| `initialize` | 200 | Protocol `2025-11-25`; server `ripple-sim-inspection` `0.1.0` |
| `notifications/initialized` | 202 | Client initialization completed |
| `tools/list` | 200 | Listed `plan_visit`, `apply_change`, `confirm_ops`, `decline_ops`, `get_receipt`, `get_status`, and `execute_approved` |
| `tools/call` → `get_status` | 200 | 7 live commitments; $196 committed; $0 sunk fees; 0 open decisions |
| `tools/call` → `apply_change` | 200 | Proposed 7 operations for arrival Saturday 09:40 and one additional guest |
| `tools/call` → `get_status` | 200 | 7 live commitments; 7 proposed decisions; $0 sunk fees |
| `tools/call` → `confirm_ops` | 200 | Exact-hash approval accepted for one reviewed cancellation |
| `tools/call` → `get_status` | 200 | 7 live commitments; 6 proposed operations; 1 approved; $0 sunk fees |
| `tools/call` → `execute_approved` | 200 | The approved operation executed; reported simulated fee: $75 |
| `tools/call` → `get_status` | 200 | 6 live commitments; $76 committed; $75 sunk fees; 6 open decisions |

The approval request captured in the browser was:

```json
{
  "method": "tools/call",
  "params": {
    "name": "confirm_ops",
    "arguments": {
      "ops": [
        {
          "id": "0f606a50",
          "payloadHash": "942c42ac",
          "factsVersion": 2
        }
      ]
    }
  },
  "jsonrpc": "2.0",
  "id": 5
}
```

The matching server response was `ok: true` with `reason: "approve"`. The page
then separately called `execute_approved`; its response identified operation
`0f606a50` as `executed` with `feeCharged: 75`.

## Approval and state evidence

Before consent, the operation card showed the server-returned before/after
parameters, `$75` cancellation fee, `- $120` cost delta, operation ID, payload
hash, and facts revision. The proposal's following `get_status` response kept
all 7 live commitments and their parameters/lifecycle states unchanged; the
page displayed this comparison before approval. After approval, a second status
read still showed 7 live commitments and no sunk fees. Only after the separate
execution call did the server report 6 live commitments and $75 sunk fees.

The verified operation was a fictional restaurant cancellation. No real
reservation, charge, service, account, or external system was involved.

## Failure behavior

With the MCP server stopped, the browser attempted `initialize` and received
HTTP 500 from the local proxy. The page displayed **Not connected**, showed the
failed JSON-RPC exchange, and stated that no offline engine action ran. Starting
the server and retrying completed initialization, tool listing, and the calls
above.

## Demo-video beats

The browser captures shown during this task provide visual proof of the offline
versus MCP mode labels, the unavailable-server error, the pre-consent review,
and the approved/executed states. For a new recording, show this page's tool
list and trace, review the fee-bearing operation with its hash/revision, approve
it, and execute it as a separate step.
