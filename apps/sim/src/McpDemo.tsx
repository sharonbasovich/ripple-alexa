import { useEffect, useMemo, useRef, useState } from 'react';
import {
  callBrowserMcpTool,
  connectBrowserMcp,
  McpConnectionError,
  McpToolError,
  McpTransportError,
  type BrowserMcpSession,
  type RpcExchange,
} from './mcpClient';

interface McpOp {
  id: string;
  kind: string;
  service: string;
  commitmentId: string;
  label: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  patch: Record<string, unknown>;
  fee: number;
  costDelta: number;
  requiresConsent: boolean;
  irreversibleNote?: string;
  changedBy?: string[];
  status: string;
  reason?: string;
  payloadHash: string;
  factsVersion: number;
}

interface McpStatus {
  ok: boolean;
  facts: { arrival: string; departure: string; guests: number; budget: number };
  factsVersion: number;
  liveCommitments: {
    id: string;
    state: string;
    params: Record<string, unknown>;
    cost: number;
  }[];
  feesCharged: number;
  openOps: number;
  budget: {
    budget: number;
    committed: number;
    fees: number;
    pendingAdds: number;
    projected: number;
    feasible: boolean;
    overBy: number;
  };
  changeSet: {
    id: string;
    status: string;
    trigger: string;
    factsVersion: number;
    expiresAt: number;
    ops: McpOp[];
  } | null;
}

const SAMPLE_FACTS = {
  arrival: '2026-10-16T18:05',
  departure: '2026-10-18T17:00',
  guests: 2,
  budget: 300,
};

const TESTED_COMMIT = (import.meta.env as ImportMetaEnv & { VITE_GIT_COMMIT?: string }).VITE_GIT_COMMIT ?? 'unknown';

export interface McpDemoProps {
  endpoint?: URL;
  allowConnect?: boolean;
}

export function McpDemo(props: McpDemoProps = {}) {
  const { endpoint, allowConnect = import.meta.env.DEV } = props;
  const [session, setSession] = useState<BrowserMcpSession | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [trace, setTrace] = useState<RpcExchange[]>([]);
  const [baseline, setBaseline] = useState<McpStatus['liveCommitments'] | null>(null);
  const [afterProposal, setAfterProposal] = useState<McpStatus['liveCommitments'] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const traceCursor = useRef(new WeakMap<BrowserMcpSession, number>());

  useEffect(() => () => {
    void session?.client.close().catch(() => undefined);
  }, [session]);

  const connected = session !== null;
  const ops = status?.changeSet?.ops ?? [];
  const approvedCount = ops.filter((op) => op.status === 'approved').length;
  const pendingCount = ops.filter((op) => op.status === 'proposed').length;
  const hasOpenSet = status?.changeSet?.status === 'open';
  const noMutationBeforeConsent = useMemo(
    () => baseline !== null && afterProposal !== null && JSON.stringify(baseline) === JSON.stringify(afterProposal),
    [afterProposal, baseline],
  );

  const appendSessionTrace = (active: BrowserMcpSession) => {
    const from = traceCursor.current.get(active) ?? 0;
    const added = active.trace.slice(from);
    traceCursor.current.set(active, active.trace.length);
    if (added.length) setTrace((previous) => [...previous, ...added]);
  };

  const connect = async () => {
    setConnecting(true);
    setError('');
    setMessage('');
    setTools([]);
    setStatus(null);
    setBaseline(null);
    setAfterProposal(null);
    setSession(null);
    try {
      const createdSession = await connectBrowserMcp(endpoint ?? new URL('/mcp', window.location.origin));
      appendSessionTrace(createdSession);
      const initial = createdSession.initialStatus as unknown as McpStatus;
      setSession(createdSession);
      setTools(createdSession.tools.map((tool) => tool.name).sort());
      setStatus(initial);
      setMessage('Browser MCP client initialized, listed tools, and read server state.');
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof McpConnectionError || cause instanceof McpTransportError || cause instanceof McpToolError) {
        setTrace((previous) => [...previous, ...cause.trace]);
      }
      setSession(null);
      setTools([]);
      setStatus(null);
      if (cause instanceof McpConnectionError) {
        setError(`MCP initialization or tools/list failed: ${detail}. No offline engine action was run.`);
      } else if (cause instanceof McpTransportError) {
        setError(`MCP transport failed during the initial get_status read: ${detail}. No offline engine action was run.`);
      } else if (cause instanceof McpToolError) {
        setError(`The initial get_status tool was rejected: ${detail}. No MCP session was marked connected, and no offline engine action was run.`);
      } else {
        setError(`MCP connection setup failed: ${detail}. No offline engine action was run.`);
      }
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    if (session) appendSessionTrace(session);
    setSession(null);
    setTools([]);
    setStatus(null);
    setBaseline(null);
    setAfterProposal(null);
    setError('');
    setMessage('Disconnected from the MCP server.');
  };

  const refreshStatus = async (active: BrowserMcpSession) => {
    const next = (await callBrowserMcpTool(active, 'get_status', {})) as unknown as McpStatus;
    if (!next.ok) throw new Error('The MCP server returned an unsuccessful get_status result.');
    setStatus(next);
    return next;
  };

  const runTool = async <T,>(tool: string, args: Record<string, unknown>, onResult: (result: T) => Promise<void> | void) => {
    if (!session) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = (await callBrowserMcpTool(session, tool, args)) as unknown as T;
      await onResult(result);
    } catch (cause) {
      if (cause instanceof McpTransportError) {
        appendSessionTrace(session);
        setSession((current) => current === session ? null : current);
        setTools([]);
        setStatus(null);
        setBaseline(null);
        setAfterProposal(null);
        setMessage('The last server state was cleared because the transport failed. Reconnect to read current state.');
        setError(`MCP transport disconnected during ${tool}: ${cause.message}. No offline engine action was run; reconnect manually to continue.`);
      } else if (cause instanceof McpToolError) {
        setError(`${tool} was rejected by the MCP server: ${cause.message}. The MCP session remains connected; no offline engine action was run.`);
      } else {
        setError(`${tool} failed: ${cause instanceof Error ? cause.message : String(cause)}. The MCP session remains connected; no offline engine action was run.`);
      }
    } finally {
      appendSessionTrace(session);
      setBusy(false);
    }
  };

  const resetServer = () =>
    runTool<Record<string, unknown>>('plan_visit', SAMPLE_FACTS, async (result) => {
      if (result.ok !== true) throw new Error('Server refused the sample plan.');
      const next = await refreshStatus(session!);
      setBaseline(next.liveCommitments);
      setAfterProposal(null);
      setMessage('The server reset its in-memory synthetic sample plan.');
    });

  const proposeSample = () => {
    if (!status) return;
    const before = structuredClone(status.liveCommitments);
    setBaseline(before);
    setAfterProposal(null);
    runTool<Record<string, unknown>>(
      'apply_change',
      {
        edits: [
          { key: 'arrival', value: '2026-10-17T09:40' },
          { key: 'guests', value: status.facts.guests + 1 },
        ],
      },
        async (result) => {
        if (result.ok !== true) throw new Error('Server rejected the proposed fact edits.');
        const next = await refreshStatus(session!);
        setAfterProposal(structuredClone(next.liveCommitments));
        setMessage('Proposal received from apply_change. Nothing executes until you approve an exact operation.');
      },
    );
  };

  const decide = (op: McpOp, decision: 'confirm_ops' | 'decline_ops') =>
    runTool<{ ok: boolean; results?: { ok: boolean; reason?: string }[] }>(
      decision,
      {
        ops: [{ id: op.id, payloadHash: op.payloadHash, factsVersion: op.factsVersion }],
      },
      async (result) => {
        if (result.ok !== true || result.results?.[0]?.ok !== true) {
          throw new Error(result.results?.[0]?.reason ?? 'Server did not accept the decision.');
        }
        await refreshStatus(session!);
        setMessage(decision === 'confirm_ops'
          ? 'Server recorded approval against the displayed operation hash and facts revision. It is not executed yet.'
          : 'Server recorded the decline; the booking remains as it was.');
      },
    );

  const executeApproved = () =>
    runTool<{ ok: boolean; outcomes?: { opId: string; status: string; reason?: string }[] }>(
      'execute_approved',
      {},
      async (result) => {
        if (result.ok !== true) throw new Error('Server did not execute the approved operations.');
        await refreshStatus(session!);
        const count = result.outcomes?.length ?? 0;
        setMessage(`Server returned ${count} execution outcome${count === 1 ? '' : 's'}; current state is refreshed from get_status.`);
      },
    );

  const downloadEvidence = () => {
    const artifact = {
      name: 'Ripple browser MCP evidence',
      testedCommit: TESTED_COMMIT,
      capturedAt: new Date().toISOString(),
      endpoint: new URL('/mcp', window.location.origin).toString(),
      transport: 'Streamable HTTP',
      exchanges: trace,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ripple-browser-mcp-evidence-${TESTED_COMMIT.slice(0, 12)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="app device-desktop mcp-app">
      <header className="hero">
        <div className="sim-banner">
          Browser MCP client · Streamable HTTP · synthetic plan only · loopback server
        </div>
        <div>
          <h1>Ripple MCP session</h1>
          <p className="tagline">
            The browser SDK initializes the server, lists its tools and calls them over HTTP.
            Decisions are reviewed against the exact returned operation before consent.
          </p>
        </div>
        <span className={`connection-badge ${connected ? 'is-connected' : error ? 'is-error' : ''}`} role="status">
          {connecting ? 'Connecting' : connected ? 'MCP connected' : error ? 'Not connected' : 'Offline'}
        </span>
      </header>

      <main className="mcp-main">
        <section className="mcp-connection" aria-label="MCP connection">
          <div className="mcp-connection-copy">
            <h2>Self-hosted MCP server</h2>
            <p>
              This path uses the real TypeScript MCP client from this page. It talks to the same-origin
              <code> /mcp</code> route; Vite proxies that route to the loopback server.
            </p>
          </div>
          <div className="mcp-actions">
            {!connected ? (
              <button className="primary" onClick={connect} disabled={connecting || !allowConnect}>
                {connecting ? 'Connecting…' : 'Connect to MCP server'}
              </button>
            ) : (
              <button onClick={disconnect} disabled={busy}>Disconnect</button>
            )}
            {!import.meta.env.DEV && (
              <p className="mcp-hint">The static build stays offline. Run <code>npm run dev</code> to use its local MCP proxy.</p>
            )}
            {connected && (
              <button onClick={resetServer} disabled={busy}>Reset server to sample plan</button>
            )}
          </div>
          {error && <p className="mcp-error" role="alert">{error}</p>}
          {message && <p className="mcp-message" role="status">{message}</p>}
        </section>

        {connected && (
          <>
            <section className="mcp-tools-panel" aria-label="Server tools">
              <div>
                <h2>Tools returned by tools/list</h2>
                <p className="muted">These names came from the connected server over Streamable HTTP.</p>
              </div>
              <ul className="mcp-tool-list">
                {tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}
              </ul>
            </section>

            {status && (
              <section className="mcp-state-panel" aria-label="Server-confirmed state">
                <div className="mcp-state-head">
                  <div>
                    <h2>Server state</h2>
                    <p className="muted">Refreshed with <code>get_status</code> · facts revision {status.factsVersion}</p>
                  </div>
                  <div className="mcp-budget" role="note" aria-label={`Projected budget including pending proposals: $${status.budget.projected} of $${status.budget.budget}; not completed spend`}>
                    <span className="mcp-budget-label">Projected plan, including pending proposals</span>
                    <strong className={status.budget.feasible ? 'mcp-budget-ok' : 'mcp-budget-over'}>
                      ${status.budget.projected} / ${status.budget.budget}
                    </strong>
                    <span className="mcp-budget-note">Not completed spend</span>
                  </div>
                </div>
                <p className="mcp-facts">
                  Arrival {status.facts.arrival} · departure {status.facts.departure} · {status.facts.guests} guests
                </p>
                <p className="mcp-facts">
                  {status.liveCommitments.length} live commitments · {status.openOps} proposed decisions · ${status.feesCharged} sunk fees
                </p>
                {baseline && afterProposal && (
                  <p className={noMutationBeforeConsent ? 'mcp-proof' : 'mcp-error'} role="status">
                    {noMutationBeforeConsent
                      ? 'Verified by successive get_status responses: no booking parameters or lifecycle states changed before approval.'
                      : 'Server state differs from the pre-proposal snapshot; inspect the JSON-RPC evidence before proceeding.'}
                  </p>
                )}
                {status.liveCommitments.length > 0 && (
                  <details className="mcp-commitments">
                    <summary>Inspect current commitment parameters</summary>
                    <ul>
                      {status.liveCommitments.map((commitment) => (
                        <li key={commitment.id}>
                          <strong>{commitment.id}</strong> · {commitment.state} · ${commitment.cost}
                          <pre>{JSON.stringify(commitment.params, null, 2)}</pre>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )}

            <section className="mcp-proposal-panel" aria-label="MCP change proposal">
              <div className="mcp-proposal-head">
                <div>
                  <h2>Review the server's proposal</h2>
                  <p className="muted">The sample sends fact edits to <code>apply_change</code>; this browser does not run the offline planner.</p>
                </div>
                <button className="primary" onClick={proposeSample} disabled={busy || hasOpenSet}>
                  Propose Saturday arrival + one guest
                </button>
              </div>
              {hasOpenSet && (
                <p className="mcp-hint">Resolve or execute this open change set before proposing another one.</p>
              )}
              {status?.changeSet && (
                <div className="mcp-change-meta">
                  Change set <code>{status.changeSet.id}</code> · {status.changeSet.status} · facts revision {status.changeSet.factsVersion} · {status.changeSet.ops.length} operations
                </div>
              )}
              {ops.length > 0 ? (
                <div className="mcp-op-list">
                  {ops.map((op) => (
                    <article className={`mcp-op status-${op.status}`} key={op.id}>
                      <header>
                        <div>
                          <span className="mcp-op-kind">{op.kind} · {op.service}</span>
                          <h3>{op.label}</h3>
                        </div>
                        <span className={`pill pill-${op.status}`}>{op.status}</span>
                      </header>
                      <p className="mcp-op-id">Commitment <code>{op.commitmentId}</code></p>
                      <div className="mcp-param-grid">
                        <div>
                          <h4>Before</h4>
                          <pre>{op.before ? JSON.stringify(op.before, null, 2) : 'No existing parameters'}</pre>
                        </div>
                        <div>
                          <h4>After</h4>
                          <pre>{op.after ? JSON.stringify(op.after, null, 2) : 'Commitment removed'}</pre>
                        </div>
                      </div>
                      <p className="mcp-costs">
                        Cost change {op.costDelta > 0 ? '+' : ''}${op.costDelta} · cancellation fee ${op.fee}
                        {op.requiresConsent ? ' · requires your consent' : ''}
                      </p>
                      {op.irreversibleNote && <p className="mcp-hint">{op.irreversibleNote}</p>}
                      <details className="mcp-consent-context" open={op.status === 'proposed'}>
                        <summary>Exact approval context</summary>
                        <dl>
                          <div><dt>Operation ID</dt><dd><code>{op.id}</code></dd></div>
                          <div><dt>Payload hash</dt><dd><code>{op.payloadHash}</code></dd></div>
                          <div><dt>Facts revision</dt><dd><code>{op.factsVersion}</code></dd></div>
                        </dl>
                      </details>
                      {op.status === 'proposed' && (
                        <div className="op-actions">
                          <button className="primary" onClick={() => decide(op, 'confirm_ops')} disabled={busy}>
                            Approve this exact operation
                          </button>
                          <button onClick={() => decide(op, 'decline_ops')} disabled={busy}>Decline</button>
                        </div>
                      )}
                      {op.status === 'approved' && <p className="mcp-proof">Approved by the server; still awaiting execute_approved.</p>}
                      {op.reason && <p className="mcp-error">{op.reason}</p>}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">Connect to the MCP server to load its current operation state.</p>
              )}
              {approvedCount > 0 && (
                <button className="primary mcp-execute" onClick={executeApproved} disabled={busy}>
                  Execute {approvedCount} approved change{approvedCount === 1 ? '' : 's'} on server
                </button>
              )}
              {status?.changeSet && pendingCount === 0 && approvedCount === 0 && status.changeSet.ops.length > 0 && (
                <p className="muted">This change set has no pending or approved operations.</p>
              )}
            </section>
          </>
        )}

        <section className="mcp-evidence" aria-label="JSON-RPC network evidence">
          <div className="mcp-state-head">
            <div>
              <h2>Browser JSON-RPC evidence</h2>
              <p className="muted">Captured from the SDK client's actual fetch calls and server responses.</p>
            </div>
            <div className="mcp-evidence-actions">
              <span>{trace.length} exchange{trace.length === 1 ? '' : 's'}</span>
              {trace.length > 0 && <button onClick={downloadEvidence}>Download JSON-RPC evidence</button>}
            </div>
          </div>
          {trace.length ? (
            <ol className="mcp-trace">
              {trace.map((entry, index) => (
                <li key={`${entry.method}-${index}`}>
                  <details>
                    <summary>
                      <code>{entry.method}</code>
                      {entry.httpStatus ? ` · HTTP ${entry.httpStatus}` : ''}
                      {entry.error ? ` · ${entry.error}` : ''}
                    </summary>
                    <div className="mcp-json-pair">
                      <div><h4>Request</h4><pre>{JSON.stringify(entry.request, null, 2)}</pre></div>
                      <div><h4>Response</h4><pre>{JSON.stringify(entry.response ?? entry.error ?? 'No response body (notification)', null, 2)}</pre></div>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No MCP traffic has been sent. Connect to start a real browser session.</p>
          )}
        </section>
      </main>
    </div>
  );
}
