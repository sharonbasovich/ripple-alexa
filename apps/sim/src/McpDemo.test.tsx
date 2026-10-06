// @vitest-environment jsdom
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpDemo } from './McpDemo';

const mcp = vi.hoisted(() => ({
  connectBrowserMcp: vi.fn(),
  callBrowserMcpTool: vi.fn(),
}));

vi.mock('./mcpClient', async () => {
  const actual = await vi.importActual('./mcpClient');
  return {
    ...actual,
    connectBrowserMcp: mcp.connectBrowserMcp,
    callBrowserMcpTool: mcp.callBrowserMcpTool,
  };
});

import { McpToolError, McpTransportError } from './mcpClient';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function makeSession() {
  const trace = [
    { method: 'initialize', httpStatus: 200, request: { method: 'initialize' }, response: { result: { serverInfo: { name: 'ripple-test-server' } } } },
    { method: 'notifications/initialized', httpStatus: 202, request: { method: 'notifications/initialized' }, response: '' },
    { method: 'tools/list', httpStatus: 200, request: { method: 'tools/list' }, response: { result: { tools: [{ name: 'apply_change' }] } } },
    { method: 'tools/call', httpStatus: 200, request: { method: 'tools/call', params: { name: 'get_status' } }, response: { result: { structuredContent: { ok: true } } } },
  ];
  return {
    client: { close: vi.fn().mockResolvedValue(undefined) },
    transport: {},
    tools: [{ name: 'apply_change' }],
    trace,
    initialStatus: {
      ok: true,
      facts: { arrival: '2026-10-16T18:05', departure: '2026-10-18T17:00', guests: 2, budget: 300 },
      factsVersion: 1,
      liveCommitments: [{ id: 'synthetic:visit', state: 'confirmed', params: { guests: 2 }, cost: 10 }],
      feesCharged: 0,
      openOps: 0,
      budget: { budget: 300, committed: 10, fees: 0, pendingAdds: 0, projected: 10, feasible: true, overBy: 0 },
      changeSet: null,
    },
  };
}

async function mountDemo() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(McpDemo as ComponentType<{ allowConnect: boolean }>, { allowConnect: true }));
  });
}

function uiText() {
  return container?.textContent ?? '';
}

async function clickAndWait(label: string, done: () => boolean) {
  if (!container) throw new Error('Demo component is not mounted.');
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Could not find button containing "${label}".`);
  if (button.disabled) throw new Error(`Button containing "${label}" is disabled.`);
  await act(async () => button.click());
  const deadline = Date.now() + 4000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${label}" to finish. UI: ${uiText()}`);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

function persistedLocalState() {
  return JSON.stringify(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]));
}

beforeEach(() => {
  mcp.connectBrowserMcp.mockReset();
  mcp.callBrowserMcpTool.mockReset();
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

describe('McpDemo connection lifecycle', () => {
  it('does not show connected when the initial status read fails and retains its failed trace', async () => {
    const failedTrace = [
      { method: 'initialize', httpStatus: 200, request: { method: 'initialize' }, response: { result: {} } },
      { method: 'tools/list', httpStatus: 200, request: { method: 'tools/list' }, response: { result: { tools: [] } } },
      { method: 'tools/call', httpStatus: 503, request: { method: 'tools/call', params: { name: 'get_status' } }, error: 'HTTP 503' },
    ];
    mcp.connectBrowserMcp.mockRejectedValueOnce(new McpTransportError('HTTP 503 during initial status', failedTrace));
    const localStateBefore = persistedLocalState();
    await mountDemo();

    await clickAndWait('Connect to MCP server', () => uiText().includes('MCP transport failed during the initial get_status read'));

    expect(container?.querySelector('.connection-badge')?.textContent).toBe('Not connected');
    expect(uiText()).not.toContain('Tools returned by tools/list');
    expect(uiText()).toContain('tools/call · HTTP 503');
    expect(mcp.callBrowserMcpTool).not.toHaveBeenCalled();
    expect(persistedLocalState()).toBe(localStateBefore);
  });

  it('keeps the session connected after an ordinary tool-validation rejection without retrying', async () => {
    const session = makeSession();
    mcp.connectBrowserMcp.mockResolvedValueOnce(session);
    mcp.callBrowserMcpTool.mockRejectedValueOnce(new McpToolError('invalid synthetic edit', [], 'apply_change'));
    const localStateBefore = persistedLocalState();
    await mountDemo();

    await clickAndWait('Connect to MCP server', () => uiText().includes('MCP connected'));
    await clickAndWait('Propose Saturday arrival + one guest', () => uiText().includes('was rejected by the MCP server'));

    expect(container?.querySelector('.connection-badge')?.textContent).toBe('MCP connected');
    expect(uiText()).toContain('The MCP session remains connected');
    expect(uiText()).toContain('Tools returned by tools/list');
    expect(mcp.callBrowserMcpTool).toHaveBeenCalledTimes(1);
    expect(persistedLocalState()).toBe(localStateBefore);
  });

  it('clears connected state after a later transport failure and reconnects only after a click', async () => {
    const firstSession = makeSession();
    const secondSession = makeSession();
    mcp.connectBrowserMcp.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    const localStateBefore = persistedLocalState();
    await mountDemo();

    await clickAndWait('Connect to MCP server', () => uiText().includes('MCP connected'));
    mcp.callBrowserMcpTool.mockImplementationOnce(async (activeSession, tool) => {
      const failed = { method: 'tools/call', httpStatus: 503, request: { method: 'tools/call', params: { name: tool } }, error: 'server disconnected' };
      activeSession.trace.push(failed);
      throw new McpTransportError('server disconnected', activeSession.trace);
    });
    await clickAndWait('Propose Saturday arrival + one guest', () => uiText().includes('MCP transport disconnected during apply_change'));

    expect(container?.querySelector('.connection-badge')?.textContent).toBe('Not connected');
    expect(uiText()).not.toContain('Tools returned by tools/list');
    expect(uiText()).toContain('tools/call · HTTP 503');
    expect(mcp.connectBrowserMcp).toHaveBeenCalledTimes(1);
    expect(mcp.callBrowserMcpTool).toHaveBeenCalledTimes(1);
    expect(persistedLocalState()).toBe(localStateBefore);

    await clickAndWait('Connect to MCP server', () => uiText().includes('MCP connected') && mcp.connectBrowserMcp.mock.calls.length === 2);

    expect(container?.querySelector('.connection-badge')?.textContent).toBe('MCP connected');
    expect(uiText()).toContain('tools/call · HTTP 503');
    expect(uiText()).toContain('tools/list · HTTP 200');
    expect(mcp.connectBrowserMcp).toHaveBeenCalledTimes(2);
    expect(mcp.callBrowserMcpTool).toHaveBeenCalledTimes(1);
    expect(firstSession.client.close).toHaveBeenCalled();
    expect(persistedLocalState()).toBe(localStateBefore);
  });
});
