// The same browser SDK client imported by the React app, exercised against the
// real Streamable HTTP server. Browser UI proof is captured separately.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import * as E from '@ripple/engine';
import { connectBrowserMcp, callBrowserMcpTool } from '../../sim/src/mcpClient.ts';
import { createRippleMcpServer, handleMcpRequest } from '../src/server.mjs';

let httpServer;
let world;
let endpoint;
let failToolCalls = false;

beforeAll(async () => {
  world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
  E.advanceTime(world, E.FIXTURE_NOW);
  const serverFactory = () => createRippleMcpServer(world);
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/mcp') return void res.writeHead(404).end('not found');
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        req.body = body ? JSON.parse(body) : undefined;
      } catch {
        return void res.writeHead(400).end('bad json');
      }
      if (failToolCalls && req.body?.method === 'tools/call') {
        return void res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server disconnected' }));
      }
      await handleMcpRequest(world, serverFactory, req, res);
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  endpoint = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
});

describe('browser MCP client over the repository server', () => {
  it('initializes, lists tools, proposes without changing commitments, binds consent, then executes', async () => {
    const session = await connectBrowserMcp(endpoint);
    try {
      const methods = session.trace.map((exchange) => exchange.method);
      expect(methods).toContain('initialize');
      expect(methods).toContain('notifications/initialized');
      expect(methods).toContain('tools/list');
      expect(session.tools.map((tool) => tool.name)).toContain('apply_change');
      expect(session.trace.find((exchange) => exchange.method === 'initialize').response.result.serverInfo.name)
        .toBe('ripple-sim-inspection');
      expect(session.trace.find((exchange) => exchange.method === 'tools/list').response.result.tools)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'apply_change' })]));

      const before = await callBrowserMcpTool(session, 'get_status');
      const beforeState = before.liveCommitments;
      const proposed = await callBrowserMcpTool(session, 'apply_change', {
        edits: [
          { key: 'arrival', value: '2026-10-17T09:40' },
          { key: 'guests', value: 3 },
        ],
      });
      expect(proposed.ok).toBe(true);
      expect(proposed.factsVersion).toBe(2);
      const ops = proposed.ops;
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        expect(op).toHaveProperty('before');
        expect(op).toHaveProperty('after');
        expect(op.patch).toEqual(expect.any(Object));
        expect(op.fee).toEqual(expect.any(Number));
        expect(op.costDelta).toEqual(expect.any(Number));
        expect(op.payloadHash).toMatch(/^[a-f0-9]+$/);
        expect(op.factsVersion).toBe(2);
        expect(op.status).toBe('proposed');
      }

      const proposedState = await callBrowserMcpTool(session, 'get_status');
      expect(proposedState.liveCommitments).toEqual(beforeState);
      expect(proposedState.changeSet.ops.every((op) => op.status === 'proposed')).toBe(true);

      const selected = ops.find((op) => op.kind === 'cancel' && op.requiresConsent);
      expect(selected).toBeDefined();
      expect(selected).toMatchObject({ fee: 75, costDelta: -120, requiresConsent: true });
      if (!selected) throw new Error('fixture should include a fee-bearing cancellation');
      const approved = await callBrowserMcpTool(session, 'confirm_ops', {
        ops: [{ id: selected.id, payloadHash: selected.payloadHash, factsVersion: selected.factsVersion }],
      });
      expect(approved.results[0]).toMatchObject({ ok: true, reason: 'approve' });
      const approvedState = await callBrowserMcpTool(session, 'get_status');
      expect(approvedState.liveCommitments).toEqual(beforeState);
      expect(approvedState.changeSet.ops.find((op) => op.id === selected.id).status).toBe('approved');
      const confirmation = session.trace.find((exchange) => exchange.request?.params?.name === 'confirm_ops');
      expect(confirmation.request.params.arguments.ops[0]).toEqual({
        id: selected.id,
        payloadHash: selected.payloadHash,
        factsVersion: selected.factsVersion,
      });

      const execution = await callBrowserMcpTool(session, 'execute_approved');
      expect(execution.outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ opId: selected.id, status: 'executed', feeCharged: 75 }),
      ]));
      const finalState = await callBrowserMcpTool(session, 'get_status');
      expect(finalState.changeSet.ops.find((op) => op.id === selected.id).status)
        .toBe('executed');
      expect(finalState.liveCommitments).toHaveLength(beforeState.length - 1);
      expect(finalState.feesCharged).toBe(75);
      expect(session.trace.some((exchange) => exchange.method === 'tools/call' && exchange.request?.params?.name === 'confirm_ops')).toBe(true);
    } finally {
      await session.client.close();
    }
  });

  it('surfaces transport failure and retains the failed JSON-RPC exchange', async () => {
    const failedServer = http.createServer((req, res) => {
      if (req.method === 'GET') return void res.writeHead(405).end();
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'server unavailable' }));
    });
    await new Promise((resolve) => failedServer.listen(0, '127.0.0.1', resolve));
    const badEndpoint = new URL(`http://127.0.0.1:${failedServer.address().port}/mcp`);
    try {
      await expect(connectBrowserMcp(badEndpoint)).rejects.toMatchObject({
        name: 'McpConnectionError',
        trace: expect.arrayContaining([
          expect.objectContaining({ method: 'initialize', httpStatus: 503 }),
        ]),
      });
    } finally {
      await new Promise((resolve) => failedServer.close(resolve));
    }
  });

  it('classifies later transport loss, preserves the failed trace, and allows an explicit reconnect', async () => {
    const session = await connectBrowserMcp(endpoint);
    const before = E.worldSummary(world);
    try {
      failToolCalls = true;
      await expect(callBrowserMcpTool(session, 'get_status')).rejects.toMatchObject({
        name: 'McpTransportError',
        trace: expect.arrayContaining([
          expect.objectContaining({ method: 'tools/call', httpStatus: 503 }),
        ]),
      });
      expect(E.worldSummary(world)).toEqual(before);
    } finally {
      failToolCalls = false;
      await session.client.close();
    }

    const reconnected = await connectBrowserMcp(endpoint);
    try {
      expect(reconnected.initialStatus.ok).toBe(true);
      expect(reconnected.tools.map((tool) => tool.name)).toContain('apply_change');
      expect(reconnected.trace.map((exchange) => exchange.method)).toContain('initialize');
    } finally {
      await reconnected.client.close();
    }
  });
});
