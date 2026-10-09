// Real HTTP transport + same-engine parity tests for the local MCP wrapper.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as E from '@ripple/engine';
import { createRippleMcpServer, handleMcpRequest } from '../src/server.mjs';

let httpServer, client, world, port;

beforeAll(async () => {
  world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
  E.advanceTime(world, E.FIXTURE_NOW);
  const serverFactory = () => createRippleMcpServer(world);
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        req.body = body ? JSON.parse(body) : undefined;
      } catch {
        return void res.writeHead(400).end();
      }
      await handleMcpRequest(world, serverFactory, req, res);
    });
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
});

afterAll(async () => {
  await client?.close();
  httpServer?.close();
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });

describe('MCP inspection wrapper over HTTP', () => {
  it('lists the documented tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const t of ['plan_visit', 'apply_change', 'confirm_ops', 'decline_ops', 'get_receipt', 'get_status', 'execute_approved']) {
      expect(names).toContain(t);
    }
  });

  it('get_status returns structured content matching the engine summary', async () => {
    const res = await call('get_status');
    const s = res.structuredContent;
    expect(s.ok).toBe(true);
    const direct = E.worldSummary(world);
    expect(s.liveCommitments.length).toBe(direct.liveCommitments.length);
    expect(s.budget.committed).toBe(direct.budget.committed);
  });

  it('apply_change proposes ops identical to calling the engine directly', async () => {
    const res = await call('apply_change', {
      edits: [{ key: 'guests', value: 3 }],
    });
    expect(res.structuredContent.ok).toBe(true);
    const viaMcp = res.structuredContent.ops.map((o) => o.commitmentId).sort();
    // parity: same edit on an independent world yields the same op set
    const w2 = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
    E.advanceTime(w2, E.FIXTURE_NOW);
    const r2 = E.changeFacts(w2, [{ key: 'guests', value: 3 }], E.FIXTURE_NOW);
    const viaEngine = r2.changeSet.ops.map((o) => o.commitmentId).sort();
    expect(viaMcp).toEqual(viaEngine);
  });

  it('confirm + execute mutates the world truthfully', async () => {
    const cs = world.changeSets[world.changeSets.length - 1];
    const upd = cs.ops.find((o) => o.kind === 'update' && o.commitmentId === 'restaurant:arrival-dinner');
    const res = await call('confirm_ops', { opIds: [upd.id] });
    expect(res.structuredContent.results[0].ok).toBe(true);
    const before = world.commitments['restaurant:arrival-dinner'].cost;
    const ex = await call('execute_approved');
    const mine = ex.structuredContent.outcomes.find((o) => o.opId === upd.id);
    expect(['executed', 'rejected', 'requoted']).toContain(mine.status);
    if (mine.status === 'executed') {
      expect(world.commitments['restaurant:arrival-dinner'].cost).toBe(before + upd.costDelta);
    }
  });

  it('unknown op ids are rejected honestly', async () => {
    const res = await call('decline_ops', { opIds: ['no-such-op'] });
    expect(res.structuredContent.results[0].ok).toBe(false);
    expect(res.structuredContent.results[0].reason).toBe('not-found');
  });

  it('caller-supplied payload hash binds consent: wrong hash rejected, right hash approves', async () => {
    const ch = await call('apply_change', { edits: [{ key: 'arrival', value: '2026-10-17T09:40' }] });
    const op = ch.structuredContent.ops.find((o) => o.kind === 'update');
    expect(op.payloadHash).toMatch(/^[a-f0-9]+$/);
    const bad = await call('confirm_ops', { ops: [{ id: op.id, payloadHash: 'deadbeef' }] });
    expect(bad.structuredContent.results[0].ok).toBe(false);
    expect(bad.structuredContent.results[0].reason).toBe('payload-mismatch');
    const staleRev = await call('confirm_ops', { ops: [{ id: op.id, factsVersion: op.factsVersion + 9 }] });
    expect(staleRev.structuredContent.results[0].reason).toBe('revision-mismatch');
    const good = await call('confirm_ops', {
      ops: [{ id: op.id, payloadHash: op.payloadHash, factsVersion: op.factsVersion }],
    });
    expect(good.structuredContent.results[0].ok).toBe(true);
  });

  it('get_receipt returns provenance-stamped ops', async () => {
    const res = await call('get_receipt', { fact: 'guests' });
    const s = res.structuredContent;
    expect(s.ok).toBe(true);
    for (const o of s.ops) {
      expect(o.changedBy ?? []).toContain('guests');
    }
  });

  it('non-loopback host header is refused', async () => {
    // fetch() cannot forge Host — use raw http.request
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
          headers: { host: 'evil.example.com', 'content-type': 'application/json' } },
        (r) => { r.resume(); resolve(r); },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(res.statusCode).toBe(403);
  });

  it('adds truthful recall without changing receipt fields, matching direct engine reads across transitions', async () => {
    Object.assign(world, E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT));
    E.advanceTime(world, E.FIXTURE_NOW);
    async function receipt() {
      const before = E.serializeWorld(world);
      const s = (await call('get_receipt', { fact: 'arrival' })).structuredContent;
      expect(s.recall).toEqual(E.recallByFact(world, 'arrival', E.FIXTURE_NOW));
      expect(s.ops).toEqual(E.receiptsForFact(world, 'arrival').ops.map(o => ({
        id: o.id, kind: o.kind, commitmentId: o.commitmentId, status: o.status, changedBy: o.changedBy,
      })));
      expect(s.events).toEqual(E.receiptsForFact(world, 'arrival').events.map(e => ({ seq: e.seq, type: e.type })));
      expect(E.serializeWorld(world)).toBe(before);
      return s.recall;
    }
    async function propose(value) {
      const res = await call('apply_change', { edits: [{ key: 'arrival', value }] });
      return res.structuredContent.ops.find(o => o.commitmentId === 'calendar:visit');
    }
    const first = await propose('2026-10-17T09:40');
    await call('confirm_ops', { opIds: [first.id] });
    await call('execute_approved');
    const next = await propose('2026-10-17T10:40');
    let r = await receipt();
    expect(r.appliedHistory.some(o => o.id === first.id)).toBe(true);
    expect(r.pendingOperations.find(o => o.id === next.id).state).toBe('proposed');
    await call('confirm_ops', { opIds: [next.id] });
    r = await receipt();
    expect(r.pendingOperations.find(o => o.id === next.id).state).toBe('approved');
    await call('execute_approved');
    r = await receipt();
    expect(r.appliedHistory.filter(o => o.commitmentId === 'calendar:visit')).toHaveLength(2);
    expect(r.pendingOperations.some(o => o.id === next.id)).toBe(false);
    const declined = await propose('2026-10-17T11:40');
    await call('decline_ops', { opIds: [declined.id] });
    expect((await receipt()).pendingOperations.some(o => o.id === declined.id)).toBe(false);
  });
});
