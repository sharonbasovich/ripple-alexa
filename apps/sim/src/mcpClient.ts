import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface RpcExchange {
  method: string;
  request: unknown;
  response?: unknown;
  httpStatus?: number;
  error?: string;
}

export interface BrowserMcpSession {
  client: McpClient;
  transport: StreamableHTTPClientTransport;
  tools: Tool[];
  trace: RpcExchange[];
}

export class McpConnectionError extends Error {
  constructor(message: string, readonly trace: RpcExchange[]) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/**
 * Connect the actual MCP SDK client used by the browser UI. The endpoint is
 * same-origin (/mcp); Vite's local development proxy forwards it to the
 * loopback-only server without enabling CORS on that server.
 */
export async function connectBrowserMcp(endpoint: URL): Promise<BrowserMcpSession> {
  // Keep the offline static preview lean; fetch the SDK chunk only when the
  // user explicitly opens and connects the MCP demonstration.
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const trace: RpcExchange[] = [];
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: traceFetch(trace),
  });
  const client = new Client({ name: 'ripple-browser-demo', version: '0.1.0' });

  try {
    // Client.connect performs initialize and notifications/initialized.
    // SDK 1.31's optional sessionId declaration conflicts with this repo's
    // exactOptionalPropertyTypes setting; the transport is the SDK transport
    // implementation and is runtime-compatible with Client.connect.
    await client.connect(transport as unknown as Parameters<McpClient['connect']>[0]);
    // Do not claim a usable connection until tools/list succeeds too.
    const { tools } = await client.listTools();
    return { client, transport, tools, trace };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new McpConnectionError(errorMessage(error), [...trace]);
  }
}

export async function callBrowserMcpTool(
  session: BrowserMcpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await session.client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`MCP tool ${name} returned an error: ${JSON.stringify(result)}`);
  }
  if (!result.structuredContent) {
    throw new Error(`MCP tool ${name} returned no structured content.`);
  }
  return result.structuredContent as Record<string, unknown>;
}

function traceFetch(trace: RpcExchange[]): typeof fetch {
  return async (input, init) => {
    let rawRequest: string | undefined;
    if (typeof init?.body === 'string') rawRequest = init.body;
    else if (input instanceof Request) rawRequest = await input.clone().text();

    let request: unknown;
    let method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (rawRequest) {
      try {
        request = JSON.parse(rawRequest) as unknown;
        const rpcMethod = (request as { method?: unknown })?.method;
        if (typeof rpcMethod === 'string') method = rpcMethod;
      } catch {
        request = rawRequest;
      }
    }

    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (request && typeof request === 'object' && 'jsonrpc' in request) {
        trace.push({ method, request, error: errorMessage(error) });
      }
      throw error;
    }

    if (request && typeof request === 'object' && 'jsonrpc' in request) {
      const rawResponse = await response.clone().text();
      const responseBody = parseResponseBody(rawResponse);
      trace.push({
        method,
        request,
        response: responseBody,
        httpStatus: response.status,
      });
    }
    return response;
  };
}

function parseResponseBody(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Streamable HTTP responses can be one or more server-sent events.
  }
  const decoded = raw
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n'))
    .filter(Boolean)
    .map((data) => {
      try {
        return JSON.parse(data) as unknown;
      } catch {
        return data;
      }
    });
  if (decoded.length === 1) return decoded[0];
  return decoded.length ? decoded : raw;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
