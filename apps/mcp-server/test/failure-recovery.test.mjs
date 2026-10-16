// Real SDK client + production server/engine. Faults alter only the response
// after the actual synthetic mutation, never the client's implementation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import * as E from '@ripple/engine';
import { connectBrowserMcp, callBrowserMcpTool } from '../../sim/src/mcpClient.ts';
import { createRippleMcpServer, handleMcpRequest } from '../src/server.mjs';

let httpServer;
let endpoint;
let fault;
let world;
const calls = [];

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      req.body = raw ? JSON.parse(raw) : undefined;
      const name = req.body?.params?.name;
      if (name) calls.push({ name, args: req.body.params.arguments });
      const serverFactory = () => {
        const server = createRippleMcpServer(world);
        const connect = server.connect.bind(server);
        server.connect = async (transport) => {
          const send = transport.send.bind(transport);
          transport.send = async (message, options) => {
            if (fault?.tool === name && message.result?.structuredContent) {
              const mode = fault.mode;
              fault = undefined;
              if (mode === 'drop') {
                res.destroy();
                return;
              } else if (mode === 'missing') {
                message = { ...message, result: { content: message.result.content } };
              } else if (mode === 'invalid') {
                message = { ...message, result: { content: 'not valid MCP content' } };
              } else if (mode === 'status') {
                message = { ...message, result: { ...message.result, structuredContent: { ok: true } } };
              }
            }
            return send(message, options);
          };
          return connect(transport);
        };
        return server;
      };
      await handleMcpRequest(world, serverFactory, req, res);
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  endpoint = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
});

describe('uncertain outcomes after a real synthetic mutation', () => {
  it.each(['confirm_ops', 'execute_approved'].flatMap((tool) =>
    ['missing', 'invalid', 'drop'].map((mode) => [tool, mode])))('reconciles committed %s after a %s response', async (tool, mode) => {
    world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
    E.advanceTime(world, E.FIXTURE_NOW);
    calls.length = 0;
    const session = await connectBrowserMcp(endpoint);
    let selected;
    try {
      const proposal = await callBrowserMcpTool(session, 'apply_change', {
        edits: [{ key: 'arrival', value: '2026-10-17T09:40' }, { key: 'guests', value: 3 }],
      });
      selected = proposal.ops.find((op) => op.kind === 'cancel' && op.requiresConsent);
      const consent = { ops: [{ id: selected.id, payloadHash: selected.payloadHash, factsVersion: selected.factsVersion }] };
      if (tool === 'execute_approved') await callBrowserMcpTool(session, 'confirm_ops', consent);
      fault = { tool, mode };
      const failure = await callBrowserMcpTool(session, tool, tool === 'confirm_ops' ? consent : {}).catch((error) => error);
      // Assert the real mutation committed even on the original broken client.
      expect(world.feesCharged).toBe(tool === 'execute_approved' ? 75 : 0);
      expect(world.changeSets.at(-1).ops.find((op) => op.id === selected.id).status)
        .toBe(tool === 'execute_approved' ? 'executed' : 'approved');
      expect(failure).toMatchObject({ name: 'McpTransportError' });
    } finally {
      await session.client.close();
    }

    const beforeReconnect = JSON.stringify(world);
    const callCount = calls.length;
    const recovered = await connectBrowserMcp(endpoint);
    try {
      expect(recovered.initialStatus.changeSet.ops.find((op) => op.id === selected.id)).toMatchObject({
        status: tool === 'execute_approved' ? 'executed' : 'approved',
        payloadHash: selected.payloadHash, factsVersion: selected.factsVersion,
      });
      expect(recovered.initialStatus.feesCharged).toBe(tool === 'execute_approved' ? 75 : 0);
      expect(calls.slice(callCount).map((call) => call.name)).toEqual(['get_status']);
      expect(calls.filter((call) => call.name === 'execute_approved')).toHaveLength(tool === 'execute_approved' ? 1 : 0);
      expect(calls.filter((call) => call.name === 'confirm_ops')).toHaveLength(1);
      expect(JSON.stringify(world)).toBe(beforeReconnect);
    } finally {
      await recovered.client.close();
    }
  });

  it('rejects an incomplete successful status instead of accepting renderable state', async () => {
    world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
    fault = { tool: 'get_status', mode: 'status' };
    const result = await connectBrowserMcp(endpoint).catch((error) => error);
    await result.client?.close();
    expect(result).toMatchObject({ name: 'McpTransportError' });
  });
});
