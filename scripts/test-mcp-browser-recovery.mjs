/* global process, URL, console, document, structuredClone */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const outputDir = path.resolve(process.env.RECOVERY_DIR ?? path.join(root, 'artifacts/mcp-recovery'));
const testedCommit = process.env.CAPTURE_COMMIT ?? process.env.GITHUB_SHA;
assert.match(testedCommit ?? '', /^[a-f0-9]{40}$/i, 'Supply the exact tested source commit.');
await fs.mkdir(outputDir, { recursive: true });

const world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
E.advanceTime(world, E.FIXTURE_NOW);
const requests = [];
const faults = [];
const checkpoints = [];
const artifacts = [];
const errors = [];
let fault;
let vite;
let browser;
let page;
let failure;
let lastEvidence;

// Real production handlers and engine run first. Only the outgoing response is
// damaged, at the SDK transport boundary. Nothing mocks the browser or client.
function faultableServer(request) {
  const server = createRippleMcpServer(world);
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (message.result?.structuredContent) {
        request.originalResponse = structuredClone(message);
        if (fault?.tool === request.tool) {
          const mode = fault.mode;
          fault = undefined;
          const committedWorld = structuredClone(world);
          if (mode === 'missing') {
            message = { ...message, result: { content: message.result.content } };
          } else if (mode === 'invalid') {
            message = { ...message, result: { content: 'not valid MCP content' } };
          } else {
            message = { ...message, result: { ...message.result, structuredContent: { ok: true } } };
          }
          faults.push({ requestId: request.id, tool: request.tool, mode, committedWorld });
        }
        request.deliveredResponse = structuredClone(message);
      }
      return send(message, options);
    };
    return connect(transport);
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
    try {
      req.body = raw ? JSON.parse(raw) : undefined;
      const request = {
        id: requests.length, httpMethod: req.method, rpcMethod: req.body?.method ?? null,
        tool: req.body?.params?.name ?? null, body: req.body,
      };
      requests.push(request);
      await handleMcpRequest(world, () => faultableServer(request), req, res);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
});

const calls = () => requests.filter((request) => request.tool);
const currentOp = (id) => world.changeSets.at(-1).ops.find((op) => op.id === id);
const consentTuple = (op) => ({ id: op.id, payloadHash: op.payloadHash, factsVersion: op.factsVersion });
const opCard = (op) => page.locator('.mcp-op').filter({ has: page.getByRole('heading', { name: op.label, exact: true }) });

async function evidence(label) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download JSON-RPC evidence', exact: true }).click(),
  ]);
  const file = `${label}-${testedCommit}.json`;
  await download.saveAs(path.join(outputDir, file));
  const result = JSON.parse(await fs.readFile(path.join(outputDir, file), 'utf8'));
  assert.equal(result.testedCommit, testedCommit);
  assert.equal(result.transport, 'Streamable HTTP');
  if (lastEvidence) {
    assert.deepEqual(result.exchanges.slice(0, lastEvidence.exchanges.length), lastEvidence.exchanges,
      'Reconnect must retain every earlier exchange, including the failed response.');
  }
  lastEvidence = result;
  artifacts.push({ file, testedCommit });
  return result;
}

async function screenshot(label) {
  const file = `${label}-${testedCommit}.png`;
  await page.locator('.mcp-connection').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outputDir, file), fullPage: true });
  artifacts.push({ file, testedCommit, sha256: createHash('sha256').update(await fs.readFile(path.join(outputDir, file))).digest('hex') });
}

async function waitConnected() {
  await page.waitForFunction(() => document.querySelector('.connection-badge')?.textContent === 'MCP connected');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  assert.equal(await page.locator('.mcp-connection .mcp-error').count(), 0);
}

async function assertExactCard(op, state) {
  const card = opCard(op);
  assert.equal(await card.locator(`.pill-${state}`).count(), 1);
  const context = card.locator('.mcp-consent-context');
  if (await context.getAttribute('open') === null) await context.locator('summary').click();
  assert.deepEqual(await context.locator('dd code').allTextContents(), [op.id, op.payloadHash, String(op.factsVersion)]);
  assert.equal(currentOp(op.id).status, state);
  const actualConsent = E.consentFor(world, currentOp(op.id));
  assert.deepEqual(actualConsent, { opId: op.id, payloadHash: op.payloadHash, factsVersion: op.factsVersion });
}

async function assertFailed(label, tool, acknowledged = false) {
  await page.waitForFunction(() => document.querySelector('.connection-badge')?.textContent === 'Not connected');
  const copy = await page.locator('.mcp-connection').innerText();
  if (acknowledged) {
    assert.match(copy, new RegExp(`Server acknowledged ${tool}`));
    assert.match(copy, /get_status/);
  } else {
    assert.match(copy, /Outcome unknown/);
    assert.match(copy, /may have completed/);
  }
  assert.equal(await page.locator('.mcp-state-panel, .mcp-tools-panel, .mcp-proposal-panel').count(), 0,
    'Unverified state and stale operation controls must disappear.');
  assert.equal(await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).isEnabled(), true);
  assert.equal(fault, undefined, 'The intended response fault must have fired.');
  const trace = await evidence(label);
  const failed = trace.exchanges.at(-1);
  const injected = requests[faults.at(-1).requestId];
  assert.equal(failed.request.params.name, acknowledged ? 'get_status' : tool);
  assert.deepEqual(failed.response, injected.deliveredResponse, 'Keep the real malformed response in browser evidence.');
  assert.equal(failed.httpStatus, 200, 'An HTTP success must not be mistaken for a verified tool outcome.');
  await screenshot(label);
  checkpoints.push({ label, copy, failedExchange: failed, committedWorld: structuredClone(world) });
}

async function reconnect(label, op, state) {
  const beforeWorld = JSON.stringify(world);
  const start = requests.length;
  const initializes = requests.filter((request) => request.rpcMethod === 'initialize').length;
  assert.equal(initializes, 1 + checkpoints.filter((item) => item.reconnected).length,
    'Recovery must wait for an explicit Connect click, without auto-reconnect.');
  await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).click();
  await waitConnected();
  const recovery = requests.slice(start).filter((request) => request.rpcMethod);
  assert.deepEqual(recovery.map((request) => request.rpcMethod),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(recovery.filter((request) => request.tool).map((request) => request.tool), ['get_status'],
    'Manual reconnect must read state, never replay a mutation.');
  assert.equal(JSON.stringify(world), beforeWorld, 'Reconnect must not mutate the synthetic world.');
  await assertExactCard(op, state);
  const status = recovery.at(-1).originalResponse.result.structuredContent;
  assert.equal(status.changeSet.ops.find((item) => item.id === op.id).status, state);
  assert.equal(status.feesCharged, world.feesCharged);
  assert.match(await page.locator('.mcp-state-panel').innerText(), new RegExp(`\\$${world.feesCharged} sunk fees`));
  await evidence(label);
  checkpoints.push({ label, reconnected: true, recoveryRequests: recovery.map((request) => request.id) });
}

async function approve(op) {
  await assertExactCard(op, 'proposed');
  await opCard(op).getByRole('button', { name: 'Approve this exact operation', exact: true }).click();
}

async function execute() {
  await page.getByRole('button', { name: 'Execute 1 approved change on server', exact: true }).click();
}

async function waitExecuted(op) {
  await opCard(op).locator('.pill-executed').waitFor();
  await page.waitForFunction(() => !document.querySelector('button.mcp-execute'));
  await assertExactCard(op, 'executed');
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  await page.getByRole('button', { name: 'Connected MCP demo', exact: true }).click();
  await page.getByRole('button', { name: 'Connect to MCP server', exact: true }).click();
  await waitConnected();
  const baseline = structuredClone(world.commitments);
  await page.getByRole('button', { name: 'Propose Saturday arrival + one guest', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.mcp-op').length === 7);
  assert.deepEqual(world.commitments, baseline, 'Proposal must not change any live commitment.');
  const proposal = calls().find((request) => request.tool === 'apply_change').originalResponse.result.structuredContent;
  const cancellation = proposal.ops.find((op) => op.kind === 'cancel' && op.fee === 75);
  const [acknowledgedOp, laterOp] = proposal.ops.filter((op) => op.kind === 'update' && op.costDelta === 0 && op.fee === 0);
  assert.ok(cancellation && acknowledgedOp && laterOp, 'Fixture must supply the three independent reviewed operations.');

  // Approval commits but its structured acknowledgement is missing.
  fault = { tool: 'confirm_ops', mode: 'missing' };
  await approve(cancellation);
  await assertFailed('01-approval-outcome-unknown', 'confirm_ops');
  assert.equal(currentOp(cancellation.id).status, 'approved');
  assert.deepEqual(world.commitments, baseline, 'Approval alone must not execute the operation.');
  assert.equal(world.feesCharged, 0);
  await reconnect('02-read-reveals-approved', cancellation, 'approved');

  // The separately requested execution commits and charges $75, then the SDK
  // receives malformed content. Recovery must not execute or charge it twice.
  fault = { tool: 'execute_approved', mode: 'invalid' };
  await execute();
  await assertFailed('03-execution-outcome-unknown', 'execute_approved');
  assert.equal(currentOp(cancellation.id).status, 'executed');
  assert.equal(world.feesCharged, 75);
  await reconnect('04-read-reveals-executed', cancellation, 'executed');
  assert.equal(await page.locator('.mcp-execute').count(), 0);

  // A valid approval response arrives, but its subsequent read is malformed.
  // The UI must distinguish this acknowledged mutation from an unknown result.
  fault = { tool: 'get_status', mode: 'status' };
  await approve(acknowledgedOp);
  await assertFailed('05-acknowledged-approval-read-failed', 'confirm_ops', true);
  const ack = lastEvidence.exchanges.at(-2);
  assert.equal(ack.request.params.name, 'confirm_ops');
  assert.equal(ack.response.result.structuredContent.results[0].ok, true);
  assert.equal(currentOp(acknowledgedOp.id).status, 'approved');
  await reconnect('06-read-reveals-acknowledged-approval', acknowledgedOp, 'approved');
  await execute();
  await waitExecuted(acknowledgedOp);

  // After all failures, another exact consent and separate execution work
  // normally. The fee-bearing cancellation remains executed exactly once.
  await approve(laterOp);
  await opCard(laterOp).locator('.pill-approved').waitFor();
  await execute();
  await waitExecuted(laterOp);
  await assertExactCard(cancellation, 'executed');
  await evidence('07-service-recovered');
  await screenshot('07-service-recovered');
  assert.equal(world.feesCharged, 75);
  const charges = world.ledger.filter((event) => event.type === 'fee.charged');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].opId, cancellation.id);
  assert.equal(world.ledger.filter((event) => event.type === 'op.executed' && event.opId === cancellation.id).length, 1);
  assert.deepEqual(calls().filter((request) => request.tool === 'confirm_ops').map((request) => request.body.params.arguments),
    [cancellation, acknowledgedOp, laterOp].map((op) => ({ ops: [consentTuple(op)] })));
  assert.equal(calls().filter((request) => request.tool === 'execute_approved').length, 3);
  assert.deepEqual(faults.map(({ tool, mode }) => ({ tool, mode })), [
    { tool: 'confirm_ops', mode: 'missing' },
    { tool: 'execute_approved', mode: 'invalid' },
    { tool: 'get_status', mode: 'status' },
  ]);
  assert.deepEqual(errors, []);
  checkpoints.push({ label: 'normal exact consent and execution work after recovery; one $75 fee', charges });
} catch (error) {
  failure = error;
} finally {
  if (failure && page) {
    await screenshot('failure').catch((error) => errors.push(`Screenshot: ${error}`));
    await evidence('failure-trace').catch((error) => errors.push(`Evidence: ${error}`));
  }
  // Snapshot before shutdown so cleanup cannot manufacture a passing result.
  await fs.writeFile(path.join(outputDir, `recovery-proof-${testedCommit}.json`), `${JSON.stringify({
    testedCommit, passed: !failure, failure: failure ? String(failure) : null,
    checkpoints, requests, faults, world, artifacts, errors,
    injectionBoundary: 'Real production handler completed; only transport.send response altered',
    serverModel: 'Stateless per-request server and transport; synthetic in-memory world only',
  }, null, 2)}\n`);
  await browser?.close();
  await vite?.close();
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
}
if (failure) throw failure;
console.log(`PASS: real-browser uncertain MCP mutation and read-only recovery (${testedCommit})`);
