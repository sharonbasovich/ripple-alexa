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
});
