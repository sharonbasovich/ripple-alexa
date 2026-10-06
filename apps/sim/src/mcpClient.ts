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
  initialStatus: Record<string, unknown>;
}

export class McpConnectionError extends Error {
  constructor(message: string, readonly trace: RpcExchange[]) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/** A failed HTTP/fetch exchange means this session can no longer be trusted as connected. */
export class McpTransportError extends Error {
  constructor(message: string, readonly trace: RpcExchange[]) {
    super(message);
    this.name = 'McpTransportError';
  }
}

/** A server or protocol tool rejection is an operation error, not a lost connection. */
export class McpToolError extends Error {
  constructor(message: string, readonly trace: RpcExchange[], readonly tool: string) {
    super(message);
    this.name = 'McpToolError';
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

  let tools: Tool[];
  try {
    // Client.connect performs initialize and notifications/initialized.
    // SDK 1.31's optional sessionId declaration conflicts with this repo's
    // exactOptionalPropertyTypes setting; the transport is the SDK transport
    // implementation and is runtime-compatible with Client.connect.
    await client.connect(transport as unknown as Parameters<McpClient['connect']>[0]);
    // Do not claim a usable connection until tools/list succeeds too.
    ({ tools } = await client.listTools());
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new McpConnectionError(errorMessage(error), [...trace]);
  }

  const session: BrowserMcpSession = { client, transport, tools, trace, initialStatus: {} };
  try {
    // A session is ready for the UI only after its first server-state read.
    const initialStatus = await callBrowserMcpTool(session, 'get_status');
    if (initialStatus.ok !== true) {
      throw new McpToolError('The server returned an unsuccessful get_status result.', [...trace], 'get_status');
    }
    session.tools = tools;
    session.initialStatus = initialStatus;
    return session;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function callBrowserMcpTool(
  session: BrowserMcpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const traceStart = session.trace.length;
  let result;
  try {
    result = await session.client.callTool({ name, arguments: args });
  } catch (error) {
    const exchange = session.trace.slice(traceStart).find((entry) => entry.method === 'tools/call');
    if (isTransportFailure(exchange, error)) {
      throw new McpTransportError(errorMessage(error), [...session.trace]);
    }
    throw new McpToolError(errorMessage(error), [...session.trace], name);
  }

  const exchange = session.trace.slice(traceStart).find((entry) => entry.method === 'tools/call');
  if (exchange?.httpStatus !== undefined && (exchange.httpStatus < 200 || exchange.httpStatus >= 300)) {
    throw new McpTransportError(`MCP server returned HTTP ${exchange.httpStatus}.`, [...session.trace]);
  }
  if (result.isError) {
    throw new McpToolError(`MCP tool ${name} returned an error: ${JSON.stringify(result)}`, [...session.trace], name);
  }
  if (!result.structuredContent) {
    throw new McpToolError(`MCP tool ${name} returned no structured content.`, [...session.trace], name);
  }
  return result.structuredContent as Record<string, unknown>;
}

function isTransportFailure(exchange: RpcExchange | undefined, error: unknown): boolean {
  if (!exchange) return !isJsonRpcValidationError(error);
  if (exchange.error) return true;
  if (exchange.httpStatus !== undefined && (exchange.httpStatus < 200 || exchange.httpStatus >= 300)) return true;
  // JSON-RPC validation errors arrive as a valid HTTP response and leave the
  // Streamable HTTP session usable. Keep them as tool errors in the UI.
  return !isJsonRpcResponse(exchange.response) && !isJsonRpcValidationError(error);
}

function isJsonRpcResponse(response: unknown): boolean {
  return Boolean(
    response
    && typeof response === 'object'
    && 'jsonrpc' in response
    && ('result' in response || 'error' in response),
  );
}

function isJsonRpcValidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === -32600 || code === -32601 || code === -32602;
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
