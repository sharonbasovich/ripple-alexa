import fs from 'node:fs';
import path from 'node:path';

const [endpoint = 'http://127.0.0.1:5173/mcp', outputPath = 'artifacts/mcp-capture/mcp-readiness-response.txt'] = process.argv.slice(2);
const request = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'capture-readiness', version: '1.0.0' },
  },
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
try {
  const page = await fetch(new URL('/', endpoint), { signal: controller.signal });
  if (!page.ok) throw new Error(`Simulator page returned HTTP ${page.status}`);
  const html = await page.text();
  if (!html.includes('<title>Ripple — simulated Alexa+ experience</title>')) {
    throw new Error('Simulator page did not contain its expected title.');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`MCP initialize returned HTTP ${response.status}`);

  let body;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    body = '';
    while (!body.split(/\r?\n/).some((line) => line.startsWith('data:'))) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } else {
    body = await response.text();
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, body);
  const eventData = body.split(/\r?\n/).find((line) => line.startsWith('data:'));
  const message = JSON.parse(eventData ? eventData.slice(5).trim() : body);
  if (message.id !== request.id || message.result?.protocolVersion !== request.params.protocolVersion || message.result?.serverInfo?.name !== 'ripple-sim-inspection') {
    throw new Error('MCP proxy returned an unexpected initialize response.');
  }
  console.log(`Readiness verified: simulator page served; MCP via ${endpoint}: HTTP ${response.status}, protocol ${message.result.protocolVersion}, server ${message.result.serverInfo.name}.`);
} finally {
  clearTimeout(timeout);
}
