// Local-only entrypoint: node src/index.mjs  →  http://127.0.0.1:8787/mcp
import http from 'node:http';
import * as E from '@ripple/engine';
import { createRippleMcpServer, handleMcpRequest } from './server.mjs';

const world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
E.advanceTime(world, E.FIXTURE_NOW);
const serverFactory = () => createRippleMcpServer(world);

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      req.body = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    await handleMcpRequest(world, serverFactory, req, res);
  });
});

httpServer.listen(8787, '127.0.0.1', () => {
  console.log('ripple MCP inspection server (local dev tool, NOT an Alexa add-on) listening on http://127.0.0.1:8787/mcp');
});
