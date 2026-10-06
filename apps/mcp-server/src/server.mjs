// Local-only MCP server used by the browser's real Streamable HTTP client.
// It is not an Alexa add-on or integration. Loopback only; rejects
// non-loopback origins/hosts; no outbound calls; synthetic world state lives
// in this process's memory only.
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

  // Expose the complete proposed operation and the exact consent tuple so a
  // browser can show what will change before it asks the user to approve it.
  const operationForReview = (cs, op) => {
    const consent = E.consentFor(w, op);
    return {
      id: op.id,
      kind: op.kind,
      service: op.service,
      commitmentId: op.commitmentId,
      isAlternative: op.isAlternative,
      label: op.label,
      before: op.before,
      after: op.after,
      patch: op.patch,
      fee: op.fee,
      costDelta: op.costDelta,
      requiresConsent: op.requiresConsent,
      irreversibleNote: op.irreversibleNote,
      changedBy: op.changedBy,
      status: op.status,
      reason: op.reason,
      payloadHash: consent.payloadHash,
      factsVersion: cs.factsVersion,
    };
  };

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
          factsVersion: cs.factsVersion,
          trigger: cs.trigger,
          expiresAt: cs.expiresAt,
          ops: cs.ops.map((o) => operationForReview(cs, o)),
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
          'Decide proposed ops by exact id. Optionally pass the payloadHash/factsVersion ' +
          'returned by apply_change to bind consent to the reviewed payload — a mismatch is ' +
          'rejected honestly. Stale/expired consent is rejected either way.',
        inputSchema: {
          opIds: z.array(z.string()).min(1).optional(),
          ops: z
            .array(
              z.object({
                id: z.string(),
                payloadHash: z.string().optional(),
                factsVersion: z.number().int().optional(),
              }),
            )
            .min(1)
            .optional(),
        },
      },
      ({ opIds, ops }) => {
        const specs = (ops ?? []).length
          ? ops
          : (opIds ?? []).map((id) => ({ id }));
        if (!specs.length) {
          return text('Provide opIds or ops.', { ok: false, reason: 'no-ops' });
        }
        const results = specs.map((spec) => {
          const cs = w.changeSets[w.changeSets.length - 1];
          const op = cs?.ops.find((o) => o.id === spec.id);
          if (!op) return { opId: spec.id, ok: false, reason: 'not-found' };
          const consent = E.consentFor(w, op);
          if (spec.payloadHash !== undefined && spec.payloadHash !== consent.payloadHash) {
            return { opId: spec.id, ok: false, reason: 'payload-mismatch' };
          }
          if (spec.factsVersion !== undefined && spec.factsVersion !== consent.factsVersion) {
            return { opId: spec.id, ok: false, reason: 'revision-mismatch' };
          }
          const res =
            how === 'approve' ? E.approve(w, consent, E.FIXTURE_NOW) : E.decline(w, consent, E.FIXTURE_NOW);
          return { opId: spec.id, ok: res.ok, reason: res.ok ? how : res.reason };
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
        const cs = w.changeSets[w.changeSets.length - 1];
        return text(
          `${s.liveCommitments.length} live commitments; $${s.budget.committed} committed, $${s.feesCharged} sunk fees; ${s.openOps} open decisions.`,
          {
            ok: true,
            ...s,
            factsVersion: w.factsVersion,
            changeSet: cs
              ? {
                  id: cs.id,
                  status: cs.status,
                  trigger: cs.trigger,
                  factsVersion: cs.factsVersion,
                  expiresAt: cs.expiresAt,
                  ops: cs.ops.map((o) => operationForReview(cs, o)),
                }
              : null,
          },
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
