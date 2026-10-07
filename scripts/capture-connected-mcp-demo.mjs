/* global process, URL, document, console */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.env.CAPTURE_DIR ?? path.join(repoRoot, 'artifacts/mcp-capture'));
const screenshotDir = path.join(outputDir, 'screenshots');
const videoWorkDir = path.join(outputDir, 'video-work');
const captionSource = path.join(repoRoot, 'docs/demo-captions-mcp.vtt');
const testedCommit = process.env.CAPTURE_COMMIT ?? process.env.VITE_GIT_COMMIT ?? process.env.GITHUB_SHA;
const viewport = { width: 1280, height: 900 };
const pageUrl = 'http://127.0.0.1:5173/';
const requiredTools = [
  'apply_change',
  'confirm_ops',
  'decline_ops',
  'execute_approved',
  'get_receipt',
  'get_status',
  'plan_visit',
];

assert.match(testedCommit ?? '', /^[a-f0-9]{40}$/i, 'CAPTURE_COMMIT must be the exact 40-character source commit.');
await fs.mkdir(screenshotDir, { recursive: true });
await fs.mkdir(videoWorkDir, { recursive: true });
await fs.copyFile(captionSource, path.join(outputDir, 'ripple-connected-mcp-captions.vtt'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport,
  deviceScaleFactor: 1,
  recordVideo: { dir: videoWorkDir, size: viewport },
});
const page = await context.newPage();
const video = page.video();
const networkExchanges = [];
const recordingStartedAt = Date.now();
const actionLog = [];

function mark(event, details = {}) {
  actionLog.push({ offsetMs: Date.now() - recordingStartedAt, event, ...details });
}

page.on('response', (response) => {
  if (new URL(response.url()).pathname !== '/mcp') return;
  const request = response.request();
  let body;
  try {
    body = request.postDataJSON();
  } catch {
    body = undefined;
  }
  networkExchanges.push({
    httpMethod: request.method(),
    rpcMethod: body?.method ?? null,
    toolName: body?.params?.name ?? null,
    status: response.status(),
  });
});

async function holdUntil(milliseconds) {
  const remaining = milliseconds - (Date.now() - recordingStartedAt);
  if (remaining > 0) await page.waitForTimeout(remaining);
  mark('hold_completed', { targetOffsetMs: milliseconds });
}

async function saveScreenshot(name) {
  await page.screenshot({ path: path.join(screenshotDir, name), fullPage: false });
  mark('screenshot_saved', { file: name });
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function responseText(exchange) {
  return exchange?.response?.result?.content?.find((item) => typeof item.text === 'string')?.text ?? '';
}

async function addCaptureOnlyPointer() {
  // This ring only makes the real Playwright mouse actions visible in the raw recording.
  // It does not alter the app's text, state, requests, or server responses.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      #capture-pointer {
        position: fixed; z-index: 2147483647; width: 22px; height: 22px;
        border: 3px solid #b94e1a; border-radius: 50%; box-sizing: border-box;
        background: rgba(255,255,255,.24); pointer-events: none;
        transform: translate(-50%, -50%); left: -40px; top: -40px;
        box-shadow: 0 1px 6px rgba(0,0,0,.45);
      }
      #capture-pointer::after {
        content: ''; position: absolute; width: 5px; height: 5px; left: 50%; top: 50%;
        border-radius: 50%; transform: translate(-50%, -50%); background: #b94e1a;
      }
      #capture-pointer.is-down { background: rgba(185,78,26,.35); transform: translate(-50%, -50%) scale(.82); }
      #capture-disclosure {
        position: fixed; z-index: 2147483646; left: 50%; bottom: 12px; transform: translateX(-50%);
        max-width: calc(100vw - 40px); padding: 9px 18px; border-radius: 999px;
        background: rgba(32,31,28,.92); color: #fff; font: 600 14px/1.3 system-ui, sans-serif;
        letter-spacing: .02em; text-align: center; pointer-events: none;
        box-shadow: 0 3px 16px rgba(0,0,0,.22);
      }
    `;
    document.head.append(style);
    const pointer = document.createElement('div');
    pointer.id = 'capture-pointer';
    pointer.setAttribute('aria-hidden', 'true');
    document.body.append(pointer);
    const disclosure = document.createElement('div');
    disclosure.id = 'capture-disclosure';
    disclosure.setAttribute('aria-hidden', 'true');
    disclosure.textContent = 'CAPTURE LABEL: fictional services and simulated fees; no real bookings or charges';
    document.body.append(disclosure);
    document.addEventListener('mousemove', (event) => {
      pointer.style.left = `${event.clientX}px`;
      pointer.style.top = `${event.clientY}px`;
    });
    document.addEventListener('mousedown', () => pointer.classList.add('is-down'));
    document.addEventListener('mouseup', () => pointer.classList.remove('is-down'));
  });
}

let captureError;
let manifest;

try {
  mark('recording_started', { viewport, pageUrl });
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await addCaptureOnlyPointer();

  const offlineLabel = await page.locator('.sim-banner').innerText();
  assert.match(offlineLabel, /Simulated Alexa\+ experience.*fictional services/i);
  mark('offline_preview_disclosure_visible');
  await saveScreenshot('00-offline-preview-disclosure.png');
  await holdUntil(8_000);

  await page.getByRole('button', { name: 'Connected MCP demo' }).click();
  mark('connected_mode_selected');
  await page.getByRole('button', { name: 'Connect to MCP server' }).click();
  mark('connect_requested');
  await page.waitForFunction(() => document.querySelector('.connection-badge')?.textContent?.trim() === 'MCP connected');
  await page.waitForFunction(() => document.querySelectorAll('.mcp-tool-list li').length === 7);
  const listedTools = await page.locator('.mcp-tool-list code').allTextContents();
  assert.deepEqual([...listedTools].sort(), [...requiredTools].sort(), 'The connected server must return the expected tool list.');
  const initialStatus = normalize(await page.locator('.mcp-state-panel').innerText());
  assert.match(initialStatus, /7 live commitments.*\$\s*0 sunk fees/i);
  const initialFacts = normalize(await page.locator('.mcp-state-panel .mcp-facts').first().innerText());
  assert.match(initialFacts, /arrival 2026-10-16T18:05.*departure 2026-10-18T17:00.*2 guests/i);
  mark('browser_mcp_initialized_and_tools_listed', { tools: listedTools, initialFacts });
  await saveScreenshot('01-connected-init-and-tools.png');
  await holdUntil(20_000);

  const commitments = page.locator('.mcp-commitments');
  await commitments.locator('summary').click();
  const initialCommitments = normalize(await commitments.innerText());
  assert.match(initialCommitments, /2026-10-18T17:00/, 'The visible baseline commitment parameters must retain the Sunday departure.');
  mark('baseline_commitments_inspected', { sundayDeparture: '2026-10-18T17:00' });
  await saveScreenshot('02-baseline-commitments-and-sunday-departure.png');
  await holdUntil(28_000);

  await page.getByRole('button', { name: 'Propose Saturday arrival + one guest' }).click();
  mark('apply_change_requested');
  await page.waitForFunction(() => document.querySelectorAll('.mcp-op').length === 7);
  const proposedFacts = normalize(await page.locator('.mcp-state-panel .mcp-facts').first().innerText());
  assert.match(proposedFacts, /arrival 2026-10-17T09:40.*departure 2026-10-18T17:00.*3 guests/i);
  const restaurant = page.locator('.mcp-op').filter({ hasText: 'Cancel Arrival-day dinner reservation' });
  await restaurant.scrollIntoViewIfNeeded();
  const reviewText = normalize(await restaurant.innerText());
  assert.match(reviewText, /cancellation fee \$75/i);
  assert.match(reviewText, /requires your consent/i);
  assert.match(reviewText, /0f606a50/i);
  assert.match(reviewText, /942c42ac/i);
  assert.match(reviewText, /Facts revision 2/i);
  const beforeConsent = normalize(await page.locator('.mcp-state-panel').innerText());
  assert.match(beforeConsent, /7 live commitments.*7 proposed decisions.*\$\s*0 sunk fees/i);
  assert.match(beforeConsent, /no booking parameters or lifecycle states changed before approval/i);
  mark('seven_proposals_and_unchanged_baseline_verified', {
    arrival: '2026-10-17T09:40', guests: 3, sundayDeparture: '2026-10-18T17:00',
    liveCommitments: 7, proposedDecisions: 7, sunkFees: 0,
  });
  await page.locator('.mcp-state-panel').scrollIntoViewIfNeeded();
  await saveScreenshot('03-server-confirms-current-commitments-unchanged.png');
  await holdUntil(40_000);

  await restaurant.scrollIntoViewIfNeeded();
  await restaurant.locator('h3').hover();
  mark('restaurant_cancellation_reviewed_before_consent', { fee: 75, operationId: '0f606a50', payloadHash: '942c42ac', factsVersion: 2 });
  await saveScreenshot('04-fee-before-approval.png');
  await holdUntil(52_000);

  await restaurant.getByRole('button', { name: 'Approve this exact operation' }).click();
  mark('exact_operation_approval_requested', { operationId: '0f606a50', payloadHash: '942c42ac', factsVersion: 2 });
  await page.waitForFunction(() => document.querySelector('.mcp-op.status-approved .mcp-proof')?.textContent?.includes('awaiting execute_approved'));
  const afterConsent = normalize(await page.locator('.mcp-state-panel').innerText());
  assert.match(afterConsent, /7 live commitments.*6 proposed decisions.*\$\s*0 sunk fees/i);
  assert.match(afterConsent, /projected plan, including pending proposals/i);
  assert.match(afterConsent, /not completed spend/i);
  mark('approval_recorded_without_execution', { liveCommitments: 7, proposedDecisions: 6, approvedOperations: 1, sunkFees: 0 });
  await page.locator('.mcp-state-panel').scrollIntoViewIfNeeded();
  await saveScreenshot('05-approved-server-state-unchanged.png');
  await holdUntil(60_000);
  const consentContext = restaurant.locator('details.mcp-consent-context');
  if (!(await consentContext.getAttribute('open'))) await consentContext.locator('summary').click();
  await restaurant.scrollIntoViewIfNeeded();
  await restaurant.locator('h3').hover();
  await saveScreenshot('06-approved-awaiting-separate-execution.png');
  await holdUntil(66_000);

  await page.getByRole('button', { name: 'Execute 1 approved change on server' }).click();
  mark('execute_approved_requested_separately');
  await page.waitForFunction(() => document.querySelector('.mcp-op.status-executed') !== null);
  await page.waitForFunction(() => /6 live commitments/.test(document.querySelector('.mcp-state-panel')?.innerText ?? ''));
  assert.equal(await page.locator('.mcp-op.status-executed').count(), 1);
  assert.equal(await page.locator('.mcp-op.status-proposed').count(), 6);
  const finalPanel = normalize(await page.locator('.mcp-state-panel').innerText());
  assert.match(finalPanel, /6 live commitments.*6 proposed decisions.*\$\s*75 sunk fees/i);
  assert.match(finalPanel, /projected plan, including pending proposals.*\$\s*329\s*\/\s*\$\s*300.*not completed spend/i);
  mark('one_cancellation_executed_server_state_verified', {
    executedOperations: 1, liveCommitments: 6, pendingDecisions: 6, committed: 76, sunkFees: 75,
    projectedBudget: 329, budgetLimit: 300,
  });
  await restaurant.scrollIntoViewIfNeeded();
  await restaurant.locator('h3').hover();
  await saveScreenshot('07-one-executed-six-still-pending.png');
  await holdUntil(80_000);

  const evidencePanel = page.locator('.mcp-evidence');
  await evidencePanel.scrollIntoViewIfNeeded();
  const traceRows = page.locator('.mcp-trace details');
  await page.waitForFunction(() => document.querySelectorAll('.mcp-trace details').length === 10);
  for (const index of [0, 2, 4, 6, 8, 9]) {
    const row = traceRows.nth(index);
    if (!(await row.getAttribute('open'))) await row.locator('summary').click();
  }
  mark('real_browser_json_rpc_evidence_opened', { exchanges: 10, visibleRows: [0, 2, 4, 6, 8, 9] });
  await saveScreenshot('08-brief-json-rpc-proof.png');
  await holdUntil(92_000);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    evidencePanel.getByRole('button', { name: 'Download JSON-RPC evidence' }).click(),
  ]);
  const tracePath = path.join(outputDir, 'ripple-browser-mcp-evidence.json');
  await download.saveAs(tracePath);
  const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
  assert.equal(trace.testedCommit, testedCommit, 'The trace must identify the exact captured source commit.');
  assert.equal(trace.transport, 'Streamable HTTP');
  assert.equal(trace.exchanges.length, 10, 'Expected initialize, tool listing, and the full proposal/consent/execute lifecycle.');
  assert.deepEqual(trace.exchanges.map((exchange) => exchange.httpStatus), [200, 202, 200, 200, 200, 200, 200, 200, 200, 200]);
  const listExchange = trace.exchanges.find((exchange) => exchange.method === 'tools/list');
  assert.deepEqual(listExchange.response.result.tools.map((tool) => tool.name).sort(), [...requiredTools].sort());

  const calls = trace.exchanges.filter((exchange) => exchange.method === 'tools/call');
  const callNames = calls.map((exchange) => exchange.request.params.name);
  assert.deepEqual(callNames, ['get_status', 'apply_change', 'get_status', 'confirm_ops', 'get_status', 'execute_approved', 'get_status']);
  const approvalCall = calls.find((exchange) => exchange.request.params.name === 'confirm_ops');
  const approval = approvalCall.request.params.arguments.ops;
  assert.deepEqual(approval, [{ id: '0f606a50', payloadHash: '942c42ac', factsVersion: 2 }]);
  const executeIndex = callNames.indexOf('execute_approved');
  assert.ok(executeIndex > callNames.indexOf('confirm_ops'), 'Execution must occur in a separate later tool call.');

  const serverStates = calls.filter((exchange) => exchange.request.params.name === 'get_status').map(responseText);
  assert.match(serverStates[0], /7 live commitments; \$196 committed, \$0 sunk fees; 0 open decisions/i);
  assert.match(serverStates[1], /7 live commitments; \$196 committed, \$0 sunk fees; 7 open decisions/i);
  assert.match(serverStates[2], /7 live commitments; \$196 committed, \$0 sunk fees; 6 open decisions/i);
  assert.match(serverStates[3], /6 live commitments; \$76 committed, \$75 sunk fees; 6 open decisions/i);
  assert.ok(networkExchanges.length === trace.exchanges.length, 'The browser made the MCP exchanges over the Vite localhost proxy.');
  assert.ok(networkExchanges.every((exchange) => exchange.httpMethod === 'POST'));
  assert.deepEqual(networkExchanges.map((exchange) => exchange.status), trace.exchanges.map((exchange) => exchange.httpStatus));
  await fs.writeFile(path.join(outputDir, 'browser-network-summary.json'), `${JSON.stringify(networkExchanges, null, 2)}\n`);

  const statusResults = calls
    .filter((exchange) => exchange.request.params.name === 'get_status')
    .map((exchange) => exchange.response?.result?.structuredContent);
  assert.equal(statusResults.length, 4);
  assert.deepEqual(statusResults[0].liveCommitments, statusResults[1].liveCommitments,
    'The proposal must not mutate any live commitment before consent.');
  assert.deepEqual(statusResults[1].liveCommitments, statusResults[2].liveCommitments,
    'Recording approval must not mutate any live commitment before separate execution.');
  assert.equal(statusResults[0].facts.departure, '2026-10-18T17:00');
  assert.equal(statusResults[1].facts.departure, '2026-10-18T17:00');
  assert.equal(statusResults[1].facts.arrival, '2026-10-17T09:40');
  assert.equal(statusResults[1].facts.guests, 3);
  mark('downloaded_trace_proves_preconsent_and_preexecution_immutability');

  await page.locator('.mcp-state-panel').scrollIntoViewIfNeeded();
  await page.locator('.mcp-state-panel h2').hover();
  await saveScreenshot('09-ending-on-server-outcome-and-budget-note.png');
  await holdUntil(120_000);

  manifest = {
    name: 'Ripple connected MCP browser capture',
    testedCommit,
    capturedAt: new Date().toISOString(),
    browser: 'Chromium via Playwright 1.63.0',
    endpoint: 'http://127.0.0.1:5173/mcp',
    proxiedServer: 'http://127.0.0.1:8787/mcp',
    transport: 'Streamable HTTP',
    videoFile: `ripple-connected-mcp-${testedCommit.slice(0, 12)}.webm`,
    durationMs: Date.now() - recordingStartedAt,
    videoView: viewport,
    screenshotFiles: (await fs.readdir(screenshotDir)).sort(),
    traceFile: path.basename(tracePath),
    traceExchanges: trace.exchanges.length,
    listedTools: requiredTools,
    actionLogFile: 'capture-action-log.json',
    verifiedPreConsentCommitmentsUnchanged: true,
    verifiedApprovalDoesNotChangeCommitments: true,
    syntheticDemoOnly: true,
    captureOverlays: ['mouse-pointer ring', 'fictional-services/simulated-fees disclosure strip'],
  };
  await fs.writeFile(path.join(outputDir, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  captureError = error;
} finally {
  mark(captureError ? 'capture_failed' : 'capture_actions_complete', captureError ? { message: String(captureError) } : {});
  await fs.writeFile(path.join(outputDir, 'capture-action-log.json'), `${JSON.stringify({
    name: 'Ripple connected MCP capture action log',
    testedCommit,
    recordingStartedAt: new Date(recordingStartedAt).toISOString(),
    timeline: actionLog,
  }, null, 2)}\n`);
  await context.close();
  if (video) {
    const videoPath = await video.path();
    const videoName = `ripple-connected-mcp-${testedCommit.slice(0, 12)}.webm`;
    await fs.copyFile(videoPath, path.join(outputDir, videoName));
  }
  await browser.close();
}

if (captureError) throw captureError;
console.log(JSON.stringify(manifest, null, 2));
