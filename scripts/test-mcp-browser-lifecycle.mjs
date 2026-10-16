/* global process, URL, console, window, Request, document, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import * as E from '@ripple/engine/dist/index.js';
import { createRippleMcpServer, handleMcpRequest } from '../apps/mcp-server/src/server.mjs';

const { chromium } = await import(process.env.CAPTURE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.CAPTURE_PLAYWRIGHT_MODULE).href
  : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.env.LIFECYCLE_DIR ?? path.join(root, 'artifacts/mcp-lifecycle'));
const testedCommit = process.env.CAPTURE_COMMIT ?? process.env.GITHUB_SHA;
assert.match(testedCommit ?? '', /^[a-f0-9]{40}$/i, 'Supply the exact tested source commit.');
await fs.mkdir(outputDir, { recursive: true });

const world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
E.advanceTime(world, E.FIXTURE_NOW);
const baselineWorld = JSON.stringify(world);
const changes = new EventEmitter();
const requests = [];
const resources = [];
const errors = [];
const checkpoints = [];
let releaseFirstStatus;
const firstStatusGate = new Promise((resolve) => { releaseFirstStatus = resolve; });
let heldStatus;
let gateReleased = false;

// State/event barriers, not elapsed-time sleeps. Timeouts only bound failures.
function until(label, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); changes.off('change', check); };
    const check = () => {
      if (predicate()) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out: ${label}`));
    }, 15_000);
    changes.on('change', check);
    check();
  });
}

// Observe real SDK lifecycle methods and delegate unchanged. The production
// handler creates a fresh server/transport for every request, NOT a persistent
// server session. No response or MCP client implementation is mocked here.
function observedServer(request) {
  const server = createRippleMcpServer(world);
  const resource = { requestId: request.id, serverClosed: false, transportClosed: false };
  resources.push(resource);
  const connect = server.connect.bind(server);
  const close = server.close.bind(server);
  server.connect = async (transport) => {
    const closeTransport = transport.close.bind(transport);
    transport.close = async () => {
      await closeTransport();
      resource.transportClosed = true;
      changes.emit('change');
    };
    return connect(transport);
  };
  server.close = async () => {
    await close();
    resource.serverClosed = true;
    changes.emit('change');
  };
  return server;
}

const httpServer = http.createServer((req, res) => {
  if (new URL(req.url ?? '/', `http://${req.headers.host}`).pathname !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    const record = { id: requests.length, httpMethod: req.method, rpcMethod: null, tool: null, responseClosed: false };
    requests.push(record);
    res.on('close', () => {
      record.responseClosed = true;
      changes.emit('change');
    });
    try {
      req.body = raw ? JSON.parse(raw) : undefined;
      record.rpcMethod = req.body?.method ?? null;
      record.tool = req.body?.params?.name ?? null;
      if (!heldStatus && record.tool === 'get_status') {
        heldStatus = record;
        changes.emit('change');
        await firstStatusGate;
      }
      await handleMcpRequest(world, () => observedServer(record), req, res);
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500).end();
      changes.emit('change');
    }
  });
});

let vite;
let browser;
let page;
let failure;
let browserProbe;
function serverResourcesSettled(expectedOpenStreams) {
  if (!requests.length || resources.length !== requests.length) return false;
  const open = requests.filter((item) => !item.responseClosed);
  return open.length === expectedOpenStreams && open.every((item) => item.httpMethod === 'GET')
    && resources.every((item) => {
      const request = requests[item.requestId];
      return request.responseClosed ? item.serverClosed && item.transportClosed
        : !item.serverClosed && !item.transportClosed;
    });
}

try {
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  vite = await createViteServer({
    root: path.join(root, 'apps/sim'),
    configFile: path.join(root, 'apps/sim/vite.config.ts'),
    server: {
      host: '127.0.0.1', port: 0,
      proxy: { '/mcp': { target: `http://127.0.0.1:${httpServer.address().port}`, changeOrigin: false } },
    },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Passive observation only: forward the same fetch arguments and return the
  // original response. SDK close() aborts its shared signal even after HTTP
  // requests finish; that proves cleanup which a stateless server cannot see.
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const signalIds = new WeakMap();
    const probe = { signals: [], exchanges: [], unhandled: [] };
    window.__rippleLifecycle = probe;
    window.addEventListener('unhandledrejection', (event) => probe.unhandled.push(String(event.reason)));
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname !== '/mcp') return nativeFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      let signalId = signalIds.get(signal);
      if (signal && signalId === undefined) {
        signalId = probe.signals.length;
        signalIds.set(signal, signalId);
        const observed = { aborted: signal.aborted };
        probe.signals.push(observed);
        signal.addEventListener('abort', () => { observed.aborted = true; }, { once: true });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const exchange = {
        signalId, httpMethod: init?.method ?? 'GET',
        rpcMethod: body?.method ?? null, tool: body?.params?.name ?? null,
      };
      probe.exchanges.push(exchange);
      try {
        const response = await nativeFetch(input, init);
        exchange.status = response.status;
        exchange.sessionId = response.headers.get('mcp-session-id');
        return response;
      } catch (error) {
        exchange.error = String(error);
        throw error;
      }
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  await page.getByRole('button', { name: 'Connected MCP demo', exact: true }).click();
  await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).click();
  await until('first real get_status is held at the HTTP server', () => Boolean(heldStatus));
  assert.equal(gateReleased, false);
  assert.equal(await page.locator('.connection-badge').innerText(), 'Connecting');
  assert.equal(await page.getByRole('button', { name: 'Connecting…', exact: true }).isDisabled(), true);
  checkpoints.push('first connection pending on real HTTP get_status');

  await page.getByRole('button', { name: 'Offline preview', exact: true }).click();
  await page.locator('.mcp-app').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Connected MCP demo', exact: true }).click();
  assert.equal(await page.locator('.connection-badge').innerText(), 'Offline');
  assert.equal(await page.locator('.mcp-state-panel').count(), 0);
  assert.equal(await page.locator('.mcp-trace details').count(), 0);
  await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.connection-badge')?.textContent === 'MCP connected');
  await page.waitForFunction(() => document.querySelectorAll('.mcp-trace details').length === 4);
  const currentPanel = await page.locator('.mcp-state-panel').innerText();
  assert.match(currentPanel, /7 live commitments.*0 proposed decisions.*\$0 sunk fees/s);
  assert.equal(gateReleased, false, 'Reconnect must finish while the abandoned request is still held.');
  assert.deepEqual(await page.evaluate(() => window.__rippleLifecycle.signals.map((item) => item.aborted)), [false, false]);
  // Give the current session distinguishable evidence before the late result,
  // so an abandoned four-exchange trace cannot silently replace it.
  await page.getByRole('button', { name: 'Reset server to sample plan', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mcp-trace details').length === 6);
  const currentTrace = await page.locator('.mcp-trace').textContent();
  checkpoints.push('new session connected while abandoned session remains pending');

  gateReleased = true;
  releaseFirstStatus();
  await page.waitForFunction(() => window.__rippleLifecycle.signals[0]?.aborted === true);
  // Stateless mode still permits one long-lived GET/SSE stream per connected
  // client. Only the new client's stream may remain open at this checkpoint.
  await until('abandoned resources close; only the current GET stream remains', () => serverResourcesSettled(1));
  assert.deepEqual(await page.evaluate(() => window.__rippleLifecycle.signals.map((item) => item.aborted)), [true, false]);
  assert.equal(await page.locator('.connection-badge').innerText(), 'MCP connected');
  assert.equal(await page.locator('.mcp-state-panel').innerText(), currentPanel);
  assert.equal(await page.locator('.mcp-trace details').count(), 6, 'No abandoned trace may enter the current UI.');
  assert.equal(await page.locator('.mcp-trace').textContent(), currentTrace);
  assert.equal(await page.locator('.mcp-error').count(), 0);
  await page.screenshot({ path: path.join(outputDir, 'reconnected-after-abandoned-close.png'), fullPage: true });
  checkpoints.push('late connection aborts its SDK transport; new UI and transport stay current');

  // Exercise the surviving client's real transport after the late close.
  await page.getByRole('button', { name: 'Reset server to sample plan', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mcp-trace details').length === 8);
  assert.equal(await page.locator('.mcp-state-panel').innerText(), currentPanel);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => window.__rippleLifecycle.signals[1]?.aborted === true);
  assert.equal(await page.locator('.mcp-state-panel').count(), 0);
  await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.connection-badge')?.textContent === 'MCP connected');
  await page.getByRole('button', { name: 'Offline preview', exact: true }).click();
  await page.locator('.mcp-app').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.__rippleLifecycle.signals.length === 3
    && window.__rippleLifecycle.signals.every((item) => item.aborted));
  await until('all server resources close after disconnect and established unmount', () => serverResourcesSettled(0));
  checkpoints.push('surviving client works; manual disconnect and established unmount close subsequent transports');

  browserProbe = await page.evaluate(() => window.__rippleLifecycle);
  assert.deepEqual(browserProbe.unhandled, []);
  assert.deepEqual(errors, []);
  const rpc = browserProbe.exchanges.filter((item) => item.rpcMethod);
  for (let signalId = 0; signalId < 3; signalId += 1) {
    const sequence = rpc.filter((item) => item.signalId === signalId);
    assert.deepEqual(sequence.map((item) => item.rpcMethod), signalId === 1
      ? ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call', 'tools/call', 'tools/call', 'tools/call']
      : ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.deepEqual(sequence.map((item) => item.status), signalId === 1
      ? [200, 202, 200, 200, 200, 200, 200, 200] : [200, 202, 200, 200]);
    assert.ok(sequence.every((item) => item.sessionId === null), 'The real server must remain stateless.');
  }
  assert.equal(JSON.stringify(world), baselineWorld, 'Lifecycle testing must leave the synthetic world unchanged.');
} catch (error) {
  failure = error;
} finally {
  // Record observations BEFORE harness shutdown, so closing the browser/server
  // cannot manufacture a successful cleanup assertion.
  browserProbe ??= await page?.evaluate(() => window.__rippleLifecycle).catch(() => undefined);
  await fs.writeFile(path.join(outputDir, 'lifecycle-proof.json'), `${JSON.stringify({
    testedCommit, passed: !failure, failure: failure ? String(failure) : null,
    checkpoints, browser: browserProbe, requests, resources, errors,
    serverModel: 'Stateless per-request server and transport; no persistent server sessions',
  }, null, 2)}\n`);
  releaseFirstStatus();
  await browser?.close();
  await vite?.close();
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
}
if (failure) throw failure;
console.log(`PASS: real-browser delayed MCP cleanup and reconnect (${testedCommit})`);
