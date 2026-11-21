import type { Request, Response } from 'express';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { config, mcpServerInfo } from '../config.js';

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const MCP_CODE_HEADER_MISMATCH = -32020;
export const MCP_CODE_UNSUPPORTED_VERSION = -32022;
export const MCP_CODE_INVALID_REQUEST = -32600;
export const MCP_CODE_METHOD_NOT_FOUND = -32601;
export const MCP_CODE_INVALID_PARAMS = -32602;
export const MCP_CODE_PARSE_ERROR = -32700;

export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const MCP_META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
export const MCP_LEGACY_UNTIL_ENV = 'MCP_LEGACY_PROTOCOL_UNTIL';
export const MCP_DISCOVER_TTL_MS = 300_000;

export interface McpRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidJsonRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function getMeta(env: JsonRpcEnvelope): Record<string, unknown> | undefined {
  return isPlainObject(env.params) && isPlainObject(env.params._meta)
    ? env.params._meta
    : undefined;
}

function getMetaVersion(env: JsonRpcEnvelope): string {
  const meta = getMeta(env);
  return meta && typeof meta[MCP_META_PROTOCOL_VERSION] === 'string'
    ? meta[MCP_META_PROTOCOL_VERSION]
    : '';
}

function hasClientCapabilities(env: JsonRpcEnvelope): boolean {
  const meta = getMeta(env);
  return Boolean(meta && isPlainObject(meta[MCP_META_CLIENT_CAPABILITIES]));
}

export function mcpLegacyAllowed(now: Date = new Date()): boolean {
  const raw = process.env[MCP_LEGACY_UNTIL_ENV]?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return false;
  }
  const until = Date.parse(`${raw}T00:00:00.000Z`);
  return Number.isFinite(until) && now.getTime() < until;
}

export function mcpSupportedVersions(now: Date = new Date()): string[] {
  return mcpLegacyAllowed(now)
    ? [MCP_MODERN_VERSION, ...MCP_LEGACY_VERSIONS]
    : [MCP_MODERN_VERSION];
}

export function mcpNegotiateLegacyVersion(requested: unknown): string {
  if (typeof requested === 'string' && (MCP_LEGACY_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return MCP_LEGACY_VERSIONS[0];
}

export function isLegacyMcpRequest(req: Request, env: JsonRpcEnvelope): boolean {
  if (getMetaVersion(env) !== '') {
    return false;
  }
  const headerVersion = req.header('MCP-Protocol-Version') ?? '';
  if (headerVersion === '') {
    return true;
  }
  return (MCP_LEGACY_VERSIONS as readonly string[]).includes(headerVersion);
}

export function decodeMcpHeaderValue(value: string): { value: string; ok: boolean } {
  if (!value.startsWith('=?base64?')) {
    return { value, ok: true };
  }
  if (!value.endsWith('?=')) {
    return { value: '', ok: false };
  }
  const inner = value.slice('=?base64?'.length, -'?='.length);
  if (inner.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(inner)) {
    return { value: '', ok: false };
  }
  return { value: Buffer.from(inner, 'base64').toString('utf8'), ok: true };
}

function mcpUnsupportedVersionError(requested: string, now: Date): McpRpcError {
  return {
    code: MCP_CODE_UNSUPPORTED_VERSION,
    message: 'Unsupported protocol version',
    data: {
      supported: mcpSupportedVersions(now),
      requested,
    },
  };
}

export function validateModernMcpRequest(
  req: Request,
  env: JsonRpcEnvelope,
  now: Date = new Date(),
): McpRpcError | null {
  const mismatch = (message: string): McpRpcError => ({
    code: MCP_CODE_HEADER_MISMATCH,
    message,
  });
  const invalid = (message: string): McpRpcError => ({
    code: MCP_CODE_INVALID_PARAMS,
    message,
  });

  const headerVersion = req.header('MCP-Protocol-Version') ?? '';
  if (!headerVersion) {
    return mismatch('missing MCP-Protocol-Version header');
  }
  if (headerVersion !== MCP_MODERN_VERSION) {
    return mcpUnsupportedVersionError(headerVersion, now);
  }

  const metaVersion = getMetaVersion(env);
  if (!metaVersion) {
    return invalid(`missing _meta ${MCP_META_PROTOCOL_VERSION}`);
  }
  if (!hasClientCapabilities(env)) {
    return invalid(`missing _meta ${MCP_META_CLIENT_CAPABILITIES} (use {} for none)`);
  }
  if (metaVersion !== headerVersion) {
    return mismatch(`MCP-Protocol-Version header does not match _meta ${MCP_META_PROTOCOL_VERSION}`);
  }

  const method = typeof env.method === 'string' ? env.method : '';
  if ((req.header('Mcp-Method') ?? '') !== method) {
    return mismatch('Mcp-Method header does not match method');
  }

  let expectedName: string | undefined;
  if (method === 'tools/call' || method === 'prompts/get') {
    expectedName = isPlainObject(env.params) && typeof env.params.name === 'string' ? env.params.name : '';
  } else if (method === 'resources/read') {
    expectedName = isPlainObject(env.params) && typeof env.params.uri === 'string' ? env.params.uri : '';
  }

  if (expectedName !== undefined) {
    const decoded = decodeMcpHeaderValue(req.header('Mcp-Name') ?? '');
    if (!decoded.ok) {
      return mismatch('Mcp-Name header has a malformed base64 value');
    }
    if (decoded.value !== expectedName) {
      return mismatch('Mcp-Name header does not match params');
    }
  }

  return null;
}

export function mcpModernResult(
  result: unknown,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = isPlainObject(result) ? { ...result } : {};
  if (extra) {
    Object.assign(base, extra);
  }
  base.resultType = 'complete';
  const existingMeta = isPlainObject(base._meta) ? { ...base._meta } : {};
  existingMeta[MCP_META_SERVER_INFO] = {
    name: mcpServerInfo.name,
    version: mcpServerInfo.version,
  };
  base._meta = existingMeta;
  return base;
}

export function mcpDiscoverResult(now: Date = new Date()): Record<string, unknown> {
  return {
    supportedVersions: mcpSupportedVersions(now),
    capabilities: { tools: {} },
    ttlMs: MCP_DISCOVER_TTL_MS,
    cacheScope: 'private',
  };
}

function writeMcpError(res: Response, status: number, id: unknown, error: McpRpcError): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error,
  });
}

async function dispatchToMcpServer(
  server: McpServer,
  request: { jsonrpc: '2.0'; id: string | number; method: string; params?: Record<string, unknown> },
): Promise<{ result?: unknown; error?: McpRpcError }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    return await new Promise((resolve, reject) => {
      clientTransport.onmessage = (message) => {
        if ('result' in message) {
          resolve({ result: message.result });
        } else if ('error' in message) {
          resolve({ error: message.error as McpRpcError });
        }
      };
      clientTransport.onerror = reject;
      void clientTransport.send(request as JSONRPCMessage).catch(reject);
    });
  } finally {
    await Promise.allSettled([clientTransport.close(), serverTransport.close(), server.close()]);
  }
}

export interface StatelessMcpServerBundle {
  server: McpServer;
  allowedToolNames: ReadonlySet<string>;
  blockedWriteToolNames: ReadonlySet<string>;
  /**
   * Valgfri krok som kjøres kun når et gyldig, tillatt tools/call faktisk skal utføres
   * (etter header- og verktøyvalidering), slik at server/discover og tools/list slipper
   * unødvendig Texas OBO-veksling.
   */
  resolveServerForToolCall?: (
    toolName: string,
  ) => Promise<{ ok: true; server: McpServer } | { ok: false; status: number; message: string }>;
}

/**
 * Håndterer en stateless MCP-forespørsel (2026-07-28 + tidsbegrenset legacy-vindu via
 * MCP_LEGACY_PROTOCOL_UNTIL) mot en ferdig opprettet McpServer.
 */
export async function handleStatelessMcpRequest(
  req: Request,
  res: Response,
  bundle: StatelessMcpServerBundle,
  now: Date = new Date(),
): Promise<void> {
  const body = req.body as unknown;
  if (!isPlainObject(body)) {
    writeMcpError(res, 400, null, { code: MCP_CODE_INVALID_REQUEST, message: 'Invalid Request' });
    return;
  }

  const env = body as JsonRpcEnvelope;
  const hasId = 'id' in env && env.id !== undefined;
  const validId = hasId && isValidJsonRpcId(env.id);
  const responseId = validId ? (env.id as string | number) : null;

  if (
    env.jsonrpc !== '2.0' ||
    typeof env.method !== 'string' ||
    !env.method ||
    ('params' in env && env.params !== undefined && !isPlainObject(env.params))
  ) {
    writeMcpError(res, 400, responseId, { code: MCP_CODE_INVALID_REQUEST, message: 'Invalid Request' });
    return;
  }

  if (hasId && !validId) {
    writeMcpError(res, 400, null, { code: MCP_CODE_INVALID_REQUEST, message: 'Invalid Request' });
    return;
  }

  const method = env.method;
  if (!hasId && !method.startsWith('notifications/')) {
    writeMcpError(res, 400, null, { code: MCP_CODE_INVALID_REQUEST, message: 'Invalid Request' });
    return;
  }

  const id = validId ? (env.id as string | number) : undefined;

  if (!isLegacyMcpRequest(req, env)) {
    const validationError = validateModernMcpRequest(req, env, now);
    if (validationError) {
      writeMcpError(res, 400, id, validationError);
      return;
    }

    // Transportregel 5: kun meldinger uten id er notifikasjoner (202).
    if (method.startsWith('notifications/') && !hasId) {
      res.status(202).end();
      return;
    }

    if (method === 'server/discover') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        jsonrpc: '2.0',
        id,
        result: mcpModernResult(mcpDiscoverResult(now)),
      });
      return;
    }

    if (method === 'tools/list') {
      const reply = await dispatchToMcpServer(bundle.server, {
        jsonrpc: '2.0',
        id: (id as string | number) ?? 1,
        method: 'tools/list',
        params: {},
      });
      if (reply.error) {
        writeMcpError(res, 200, id, reply.error);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        jsonrpc: '2.0',
        id,
        result: mcpModernResult(reply.result, {
          ttlMs: MCP_DISCOVER_TTL_MS,
          cacheScope: 'private',
        }),
      });
      return;
    }

    if (method === 'tools/call') {
      await handleToolCall(res, id, env.params, bundle, true);
      return;
    }

    writeMcpError(res, 404, id, { code: MCP_CODE_METHOD_NOT_FOUND, message: 'Method not found' });
    return;
  }

  // Legacy initialize-era request
  if (!mcpLegacyAllowed(now)) {
    writeMcpError(
      res,
      400,
      id,
      mcpUnsupportedVersionError(req.header('MCP-Protocol-Version') ?? '', now),
    );
    return;
  }

  if (method.startsWith('notifications/') && !hasId) {
    res.status(202).end();
    return;
  }

  if (method === 'initialize') {
    const requestedVersion = isPlainObject(env.params) ? env.params.protocolVersion : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: mcpNegotiateLegacyVersion(requestedVersion),
        capabilities: { tools: {} },
        serverInfo: mcpServerInfo,
      },
    });
    return;
  }

  if (method === 'ping') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    const reply = await dispatchToMcpServer(bundle.server, {
      jsonrpc: '2.0',
      id: (id as string | number) ?? 1,
      method: 'tools/list',
      params: {},
    });
    if (reply.error) {
      writeMcpError(res, 200, id, reply.error);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ jsonrpc: '2.0', id, result: reply.result });
    return;
  }

  if (method === 'tools/call') {
    await handleToolCall(res, id, env.params, bundle, false);
    return;
  }

  writeMcpError(res, 404, id, { code: MCP_CODE_METHOD_NOT_FOUND, message: 'Method not found' });
}

async function handleToolCall(
  res: Response,
  id: unknown,
  params: Record<string, unknown> | undefined,
  bundle: StatelessMcpServerBundle,
  modern: boolean,
): Promise<void> {
  const toolName = isPlainObject(params) && typeof params.name === 'string' ? params.name : '';
  if (!toolName) {
    writeMcpError(res, 200, id, { code: MCP_CODE_INVALID_PARAMS, message: 'Missing tool name' });
    return;
  }

  if (bundle.blockedWriteToolNames.has(toolName)) {
    const blockedResult = {
      content: [
        {
          type: 'text',
          text: `Feil: Verktøyet "${toolName}" er ikke tilgjengelig via gatewayen (kun lesing). Bruk det direkte endepunktet ${config.baseUrl}/mcp.`,
        },
      ],
      isError: true,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      jsonrpc: '2.0',
      id,
      result: modern ? mcpModernResult(blockedResult) : blockedResult,
    });
    return;
  }

  if (!bundle.allowedToolNames.has(toolName)) {
    writeMcpError(res, 200, id, { code: MCP_CODE_INVALID_PARAMS, message: `Unknown tool: ${toolName}` });
    return;
  }

  let targetServer = bundle.server;
  if (bundle.resolveServerForToolCall) {
    const resolved = await bundle.resolveServerForToolCall(toolName);
    if (!resolved.ok) {
      writeMcpError(res, resolved.status, id, { code: -32603, message: resolved.message });
      return;
    }
    targetServer = resolved.server;
  }

  const args = isPlainObject(params?.arguments) ? params.arguments : {};
  const reply = await dispatchToMcpServer(targetServer, {
    jsonrpc: '2.0',
    id: (id as string | number) ?? 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  if (reply.error) {
    writeMcpError(res, 200, id, reply.error);
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    jsonrpc: '2.0',
    id,
    result: modern ? mcpModernResult(reply.result) : reply.result,
  });
}
