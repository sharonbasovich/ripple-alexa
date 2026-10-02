// Local-only MCP inspection wrapper around the SAME engine the UI runs.
// Dev tool for judges/developers — NOT an Alexa add-on, integration, or
// claim of one. Loopback only; rejects non-loopback origins/hosts; no
// outbound calls; world state lives in this process's memory only.
import * as E from '@ripple/engine/dist/index.js'; // built engine — plain node can't consume TS source
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const FACT_KEYS = /** @type {const} */ (['arrival', 'departure', 'guests', 'budget']);

/** @param {E.World} w */
export function createRippleMcpServer(w) {
  const server = new McpServer({
    name: 'ripple-sim-inspection',
    version: '0.1.0',
  });

  const text = (s, structured) => ({
    content: [{ type: 'text', text: s }],
    structuredContent: structured,
  });

  server.registerTool(
    'plan_visit',
    {
      title: 'Plan the visit',
      description:
        'Seed a fresh simulated plan from visit facts (replaces current world in this process).',
      inputSchema: {
        arrival: z.string().describe('ISO local, e.g. 2026-10-16T18:05'),
        departure: z.string(),
        guests: z.number().int().min(1).max(8),
        budget: z.number().int().min(0),
      },
    },
    ({ arrival, departure, guests, budget }) => {
      const facts = { arrival, departure, guests, budget };
      const v = E.validateFacts(facts);
      if (!v.ok) return text(`Invalid facts: ${v.errors.join('; ')}`, { ok: false, errors: v.errors });
      const fresh = E.createWorld(facts, E.PLAN_CREATED_AT);
      E.advanceTime(fresh, E.FIXTURE_NOW);
      w.facts = fresh.facts;
      w.factsVersion = fresh.factsVersion;
      w.commitments = fresh.commitments;
      w.changeSets = fresh.changeSets;
      w.ledger = fresh.ledger;
      w.journal = fresh.journal;
      w.feesCharged = fresh.feesCharged;
      w.seq = fresh.seq;
      const sum = E.worldSummary(w);
      return text(`Planned: ${sum.liveCommitments.length} commitments, $${sum.budget.committed} of $${sum.budget.budget}.`, { ok: true, ...sum });
    },
  );

  server.registerTool(
    'apply_change',
    {
      title: 'Change visit facts',
      description:
        'Apply fact edits; returns the proposed change set. Nothing executes without confirm_ops on exact op ids.',
      inputSchema: {
        edits: z
          .array(
            z.object({
              key: z.enum(FACT_KEYS),
              value: z.union([z.string(), z.number()]),
            }),
          )
          .min(1),
      },
    },
    ({ edits }) => {
      const r = E.changeFacts(w, edits, E.FIXTURE_NOW);
      if (!r.ok) return text(`Rejected: ${r.errors.join('; ')}`, { ok: false, errors: r.errors });
      if (r.noOp) return text('No fact actually changed — nothing to do.', { ok: true, noOp: true });
      const cs = r.changeSet;
      return text(
        `Proposed ${cs.ops.length} operations (change set ${cs.id}); nothing executed.`,
        {
          ok: true,
          changeSetId: cs.id,
          ops: cs.ops.map((o) => ({
            id: o.id, kind: o.kind, commitmentId: o.commitmentId, label: o.label,
            fee: o.fee, costDelta: o.costDelta, requiresConsent: o.requiresConsent,
          })),
        },
      );
    },
  );

  const decideTool = (name, how) =>
    server.registerTool(
      name,
      {
        title: `${how === 'approve' ? 'Approve' : 'Decline'} operations`,
        description:
          'Decide proposed ops by exact id at the current facts version. Stale/expired consent is rejected honestly.',
        inputSchema: { opIds: z.array(z.string()).min(1) },
      },
      ({ opIds }) => {
        const results = opIds.map((id) => {
          const cs = w.changeSets[w.changeSets.length - 1];
          const op = cs?.ops.find((o) => o.id === id);
          if (!op) return { opId: id, ok: false, reason: 'not-found' };
          const res =
            how === 'approve' ? E.approve(w, E.consentFor(w, op), E.FIXTURE_NOW) : E.decline(w, E.consentFor(w, op), E.FIXTURE_NOW);
          return { opId: id, ok: res.ok, reason: res.ok ? how : res.reason };
        });
        return text(`${results.filter((r) => r.ok).length}/${results.length} ${how}d.`, { ok: true, results });
      },
    );
  decideTool('confirm_ops', 'approve');
  decideTool('decline_ops', 'decline');

  server.registerTool(
    'get_receipt',
    {
      title: 'Causal receipt for a fact',
      description:
        'Ops and ledger events actually caused by a fact change (provenance-stamped).',
      inputSchema: { fact: z.enum(FACT_KEYS) },
    },
    ({ fact }) => {
      const r = E.receiptsForFact(w, fact);
      return text(
        `${r.ops.length} ops, ${r.events.length} ledger events caused by ${fact}.`,
        {
          ok: true,
          fact,
          ops: r.ops.map((o) => ({ id: o.id, kind: o.kind, commitmentId: o.commitmentId, status: o.status, changedBy: o.changedBy })),
          events: r.events.map((e) => ({ seq: e.seq, type: e.type })),
        },
      );
    },
  );

  server.registerTool(
    'get_status',
    {
      title: 'Plan status',
      description: 'Current commitments, lifecycle states, spend, open decisions.',
      inputSchema: {},
    },
    () => {
      const s = E.worldSummary(w);
      return text(
        `${s.liveCommitments.length} live commitments; $${s.budget.committed} committed, $${s.feesCharged} sunk fees; ${s.openOps} open decisions.`,
        { ok: true, ...s },
      );
    },
  );

  server.registerTool(
    'execute_approved',
    {
      title: 'Execute approved ops',
      description:
        'Execute every approved op in the open change set. Truthful outcomes: applied / rejected / requoted.',
      inputSchema: {},
    },
    () => {
      const outcomes = E.executeApproved(w, E.FIXTURE_NOW);
      return text(
        outcomes.length ? `${outcomes.length} outcome(s).` : 'Nothing approved to execute.',
        { ok: true, outcomes },
      );
    },
  );

  return server;
}

export function isLoopbackRequest(req) {
  const host = (req.headers.host ?? '').split(':')[0];
  const origin = req.headers.origin;
  const hostOk = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!hostOk) return false;
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch {
      return false;
    }
  }
  return true;
}

/** Stateless per-request handling (official MCP SDK pattern): a fresh
 *  server + transport per POST, both closed when the response ends. The
 *  shared World is captured by the server factory — tools stay consistent. */
export async function handleMcpRequest(world, serverFactory, req, res) {
  if (!isLoopbackRequest(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'loopback only' }));
    return;
  }
  const server = serverFactory();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
