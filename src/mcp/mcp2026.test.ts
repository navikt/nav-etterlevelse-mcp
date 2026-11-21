import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleStatelessMcpRequest,
  MCP_CODE_HEADER_MISMATCH,
  MCP_CODE_INVALID_PARAMS,
  MCP_CODE_INVALID_REQUEST,
  MCP_CODE_METHOD_NOT_FOUND,
  MCP_CODE_PARSE_ERROR,
  MCP_CODE_UNSUPPORTED_VERSION,
  MCP_LEGACY_UNTIL_ENV,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_MODERN_VERSION,
} from './mcp2026.js';
import type { SessionContext } from './server.js';

vi.mock('../unleash.js', () => ({
  isWriteEnabled: () => true,
}));

const { createGatewayMcpServer } = await import('./server.js');

const TEST_TOOL = 'get_my_teams';

function modernBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        [MCP_META_PROTOCOL_VERSION]: MCP_MODERN_VERSION,
        [MCP_META_CLIENT_CAPABILITIES]: {},
        'io.modelcontextprotocol/clientInfo': { name: 'compliance-test', version: '0' },
      },
    },
  };
}

function withoutMeta(body: ReturnType<typeof modernBody>, key: string) {
  const meta = { ...(body.params._meta as Record<string, unknown>) };
  delete meta[key];
  return { ...body, params: { ...body.params, _meta: meta } };
}

function modernHeaders(method: string, name = ''): Record<string, string> {
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': MCP_MODERN_VERSION,
    'Mcp-Method': method,
  };
  if (name) {
    headers['Mcp-Name'] = name;
  }
  return headers;
}

function buildTestApp() {
  const app = express();
  app.use(express.json());

  const fakeEtterlevelseClient = {
    getMyTeams: vi.fn().mockResolvedValue([{ id: 'team-1', name: 'Team DAB' }]),
  };

  app.post('/mcp/gw', (req, res, next) => {
    const ctx = {
      mcpAccessToken: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      etterlevelseClient: fakeEtterlevelseClient as any,
      tokenData: {
        userToken: 'obo-token',
        refreshToken: null,
        azureExpiresAt: Date.now() + 3600_000,
        userEmail: 'ola@nav.no',
        userName: 'Ola Nordmann',
        userGroups: [],
      },
    } as SessionContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bundle = createGatewayMcpServer(ctx, {} as any, null);
    void handleStatelessMcpRequest(req, res, bundle).catch(next);
  });

  app.get('/mcp/gw', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
  });

  app.delete('/mcp/gw', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError && 'status' in error && (error as { status?: number }).status === 400) {
      if (req.path === '/mcp/gw') {
        res.status(400).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: MCP_CODE_PARSE_ERROR, message: 'Parse error' },
        });
        return;
      }
    }
    next(error);
  });

  return app;
}

async function callGateway(
  app: express.Express,
  httpMethod: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; allow: string | null; json: Record<string, unknown> }> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const reqHeaders: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      ...headers,
    };
    if (httpMethod === 'POST') {
      reqHeaders['Content-Type'] = 'application/json';
    }
    const response = await fetch(`http://127.0.0.1:${port}/mcp/gw`, {
      method: httpMethod,
      headers: reqHeaders,
      body: httpMethod === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = {};
      }
    }
    return { status: response.status, allow: response.headers.get('allow'), json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('MCP 2026-07-28 compliance på /mcp/gw', () => {
  const originalLegacyUntil = process.env[MCP_LEGACY_UNTIL_ENV];

  beforeEach(() => {
    delete process.env[MCP_LEGACY_UNTIL_ENV];
  });

  afterEach(() => {
    if (originalLegacyUntil === undefined) {
      delete process.env[MCP_LEGACY_UNTIL_ENV];
    } else {
      process.env[MCP_LEGACY_UNTIL_ENV] = originalLegacyUntil;
    }
  });

  const app = buildTestApp();

  it('server/discover svarer med supportedVersions, capabilities, ttlMs, cacheScope og serverInfo', async () => {
    const { status, json } = await callGateway(
      app,
      'POST',
      modernBody('server/discover'),
      modernHeaders('server/discover'),
    );
    expect(status).toBe(200);
    const result = json.result as Record<string, unknown>;
    expect(result.supportedVersions).toEqual([MCP_MODERN_VERSION]);
    expect(result.capabilities).toBeDefined();
    expect(result.ttlMs).toBeDefined();
    expect(result.cacheScope).toBe('private');
    expect(result.resultType).toBe('complete');
    expect((result._meta as Record<string, unknown>)[MCP_META_SERVER_INFO]).toBeDefined();
  });

  it('legacy-vindu inkluderer legacy-versjoner i server/discover', async () => {
    process.env[MCP_LEGACY_UNTIL_ENV] = '2999-01-01';
    const { status, json } = await callGateway(
      app,
      'POST',
      modernBody('server/discover'),
      modernHeaders('server/discover'),
    );
    expect(status).toBe(200);
    const result = json.result as { supportedVersions: string[] };
    expect(result.supportedVersions.length).toBeGreaterThan(1);
    expect(result.supportedVersions[0]).toBe(MCP_MODERN_VERSION);
  });

  it('tools/list returnerer kun leseverktøy med annotations, ttlMs og cacheScope', async () => {
    const { status, json } = await callGateway(
      app,
      'POST',
      modernBody('tools/list'),
      modernHeaders('tools/list'),
    );
    expect(status).toBe(200);
    const result = json.result as {
      tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
      ttlMs: number;
      cacheScope: string;
      resultType: string;
    };
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.ttlMs).toBeDefined();
    expect(result.cacheScope).toBe('private');
    expect(result.resultType).toBe('complete');
    for (const tool of result.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(result.tools.some((t) => t.name === 'lock_document')).toBe(false);
    expect(result.tools.some((t) => t.name === 'write_suksesskriterium')).toBe(false);
  });

  it('tools/call med matchende Mcp-Name utfører leseverktøy', async () => {
    const { status, json } = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: TEST_TOOL, arguments: {} }),
      modernHeaders('tools/call', TEST_TOOL),
    );
    expect(status).toBe(200);
    const result = json.result as Record<string, unknown>;
    expect(result.resultType).toBe('complete');
    expect((result._meta as Record<string, unknown>)[MCP_META_SERVER_INFO]).toBeDefined();
  });

  it('tools/call med base64-kodet Mcp-Name godtas og avviser feil/ugyldig base64', async () => {
    const encoded = `=?base64?${Buffer.from(TEST_TOOL).toString('base64')}?=`;
    const ok = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: TEST_TOOL, arguments: {} }),
      modernHeaders('tools/call', encoded),
    );
    expect(ok.status).toBe(200);

    const wrongEncoded = `=?base64?${Buffer.from('other_tool').toString('base64')}?=`;
    const mismatch = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: TEST_TOOL, arguments: {} }),
      modernHeaders('tools/call', wrongEncoded),
    );
    expect(mismatch.status).toBe(400);
    expect((mismatch.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);

    const malformed = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: TEST_TOOL, arguments: {} }),
      modernHeaders('tools/call', '=?base64?!!!?='),
    );
    expect(malformed.status).toBe(400);
    expect((malformed.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);
  });

  it('ignorerer Mcp-Session-Id', async () => {
    const { status } = await callGateway(
      app,
      'POST',
      modernBody('server/discover'),
      { ...modernHeaders('server/discover'), 'Mcp-Session-Id': 'stale' },
    );
    expect(status).toBe(200);
  });

  it('avviser manglende og ustøttet MCP-Protocol-Version, _meta-feil og header-avvik', async () => {
    // Manglende MCP-Protocol-Version med modern _meta
    const missingHdr = await callGateway(
      app,
      'POST',
      modernBody('tools/list'),
      { 'Mcp-Method': 'tools/list' },
    );
    expect(missingHdr.status).toBe(400);
    expect((missingHdr.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);

    // Ustøttet MCP-Protocol-Version
    const unsupported = await callGateway(
      app,
      'POST',
      modernBody('tools/list'),
      { ...modernHeaders('tools/list'), 'MCP-Protocol-Version': '2099-01-01' },
    );
    expect(unsupported.status).toBe(400);
    expect((unsupported.json.error as { code: number; data: { supported: string[] } }).code).toBe(
      MCP_CODE_UNSUPPORTED_VERSION,
    );
    expect((unsupported.json.error as { data: { supported: string[] } }).data.supported).toBeDefined();

    // Header uten _meta -> -32602
    const noMeta = await callGateway(
      app,
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      modernHeaders('tools/list'),
    );
    expect(noMeta.status).toBe(400);
    expect((noMeta.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_PARAMS);

    // Manglende _meta protocolVersion -> -32602
    const noMetaVer = await callGateway(
      app,
      'POST',
      withoutMeta(modernBody('tools/list'), MCP_META_PROTOCOL_VERSION),
      modernHeaders('tools/list'),
    );
    expect(noMetaVer.status).toBe(400);
    expect((noMetaVer.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_PARAMS);

    // Manglende og ikke-objekt clientCapabilities -> -32602
    const noCaps = await callGateway(
      app,
      'POST',
      withoutMeta(modernBody('tools/list'), MCP_META_CLIENT_CAPABILITIES),
      modernHeaders('tools/list'),
    );
    expect(noCaps.status).toBe(400);
    expect((noCaps.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_PARAMS);

    const badCapsBody = modernBody('tools/list');
    (badCapsBody.params._meta as Record<string, unknown>)[MCP_META_CLIENT_CAPABILITIES] = 'none';
    const badCaps = await callGateway(app, 'POST', badCapsBody, modernHeaders('tools/list'));
    expect(badCaps.status).toBe(400);
    expect((badCaps.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_PARAMS);

    // _meta protocolVersion != header -> -32020
    const diffMetaBody = modernBody('tools/list');
    (diffMetaBody.params._meta as Record<string, unknown>)[MCP_META_PROTOCOL_VERSION] = '2025-06-18';
    const diffMeta = await callGateway(app, 'POST', diffMetaBody, modernHeaders('tools/list'));
    expect(diffMeta.status).toBe(400);
    expect((diffMeta.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);

    // Mcp-Method mismatch og manglende
    const badMethod = await callGateway(
      app,
      'POST',
      modernBody('tools/list'),
      modernHeaders('server/discover'),
    );
    expect(badMethod.status).toBe(400);
    expect((badMethod.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);

    // Mcp-Name mangler ved tools/call
    const missingName = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: TEST_TOOL, arguments: {} }),
      modernHeaders('tools/call'),
    );
    expect(missingName.status).toBe(400);
    expect((missingName.json.error as { code: number }).code).toBe(MCP_CODE_HEADER_MISMATCH);
  });

  it('ukjent metode, ping og notifications/* med id gir 404 (-32601); uten id gir 202', async () => {
    for (const method of ['nope/nope', 'ping', 'notifications/initialized']) {
      const res = await callGateway(app, 'POST', modernBody(method), modernHeaders(method));
      expect(res.status).toBe(404);
      expect((res.json.error as { code: number }).code).toBe(MCP_CODE_METHOD_NOT_FOUND);
    }

    const notif = modernBody('notifications/initialized');
    const { id: _id, ...withoutId } = notif;
    const notifRes = await callGateway(
      app,
      'POST',
      withoutId,
      modernHeaders('notifications/initialized'),
    );
    expect(notifRes.status).toBe(202);
  });

  it('legacy initialize avvises utenfor vinduet og fungerer innenfor vinduet', async () => {
    const legacyInit = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    };

    const closedUnset = await callGateway(app, 'POST', legacyInit);
    expect(closedUnset.status).toBe(400);
    expect((closedUnset.json.error as { code: number }).code).toBe(MCP_CODE_UNSUPPORTED_VERSION);

    process.env[MCP_LEGACY_UNTIL_ENV] = '2000-01-01';
    const closedPast = await callGateway(app, 'POST', legacyInit);
    expect(closedPast.status).toBe(400);
    expect((closedPast.json.error as { code: number }).code).toBe(MCP_CODE_UNSUPPORTED_VERSION);

    process.env[MCP_LEGACY_UNTIL_ENV] = '2999-01-01';
    const echoed = await callGateway(app, 'POST', legacyInit, { Accept: 'application/json' });
    expect(echoed.status).toBe(200);
    expect((echoed.json.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');

    const fallback = await callGateway(
      app,
      'POST',
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      { Accept: 'application/json' },
    );
    expect(fallback.status).toBe(200);
    expect((fallback.json.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('blokkerer skriveverktøy og ukjente verktøy på /mcp/gw', async () => {
    const writeAttempt = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: 'write_suksesskriterium', arguments: {} }),
      modernHeaders('tools/call', 'write_suksesskriterium'),
    );
    expect(writeAttempt.status).toBe(200);
    const writeResult = writeAttempt.json.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content[0]?.text).toContain('/mcp');

    const unknownAttempt = await callGateway(
      app,
      'POST',
      modernBody('tools/call', { name: 'finnes_ikke', arguments: {} }),
      modernHeaders('tools/call', 'finnes_ikke'),
    );
    expect(unknownAttempt.status).toBe(200);
    expect((unknownAttempt.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_PARAMS);
  });

  it('GET og DELETE på /mcp/gw svarer 405 med Allow: POST', async () => {
    const getRes = await callGateway(app, 'GET');
    expect(getRes.status).toBe(405);
    expect(getRes.allow).toBe('POST');

    const delRes = await callGateway(app, 'DELETE');
    expect(delRes.status).toBe(405);
    expect(delRes.allow).toBe('POST');
  });

  it('validerer JSON-RPC 2.0-konvolutt og id-type med -32600, og reserverer -32700 for ugyldig JSON', async () => {
    const wrongVersion = await callGateway(
      app,
      'POST',
      { ...modernBody('server/discover'), jsonrpc: '1.0' },
      modernHeaders('server/discover'),
    );
    expect(wrongVersion.status).toBe(400);
    expect((wrongVersion.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_REQUEST);

    for (const badId of [null, {}, true, [1]]) {
      const res = await callGateway(
        app,
        'POST',
        { ...modernBody('server/discover'), id: badId },
        modernHeaders('server/discover'),
      );
      expect(res.status).toBe(400);
      expect(res.json.id).toBeNull();
      expect((res.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_REQUEST);
    }

    // ID-løse ikke-notifikasjoner skal gi -32600, ikke 200 eller 202
    const { id: _listId, ...toolsListWithoutId } = modernBody('tools/list');
    const idlessList = await callGateway(app, 'POST', toolsListWithoutId, modernHeaders('tools/list'));
    expect(idlessList.status).toBe(400);
    expect((idlessList.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_REQUEST);

    // notifications/* med id: null er ugyldig i både moderne og legacy-modus (ikke 202)
    const nullIdNotifModern = await callGateway(
      app,
      'POST',
      { ...modernBody('notifications/initialized'), id: null },
      modernHeaders('notifications/initialized'),
    );
    expect(nullIdNotifModern.status).toBe(400);
    expect((nullIdNotifModern.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_REQUEST);

    process.env[MCP_LEGACY_UNTIL_ENV] = '2999-01-01';
    const nullIdNotifLegacy = await callGateway(
      app,
      'POST',
      { jsonrpc: '2.0', id: null, method: 'notifications/initialized' },
    );
    expect(nullIdNotifLegacy.status).toBe(400);
    expect((nullIdNotifLegacy.json.error as { code: number }).code).toBe(MCP_CODE_INVALID_REQUEST);

    const legacyNotif = await callGateway(
      app,
      'POST',
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect(legacyNotif.status).toBe(202);
    expect(legacyNotif.json).toEqual({});

    // Ugyldig JSON-tekst skal gi -32700 Parse error
    const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const rawRes = await fetch(`http://127.0.0.1:${port}/mcp/gw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid-json',
      });
      const parsed = (await rawRes.json()) as { error: { code: number } };
      expect(rawRes.status).toBe(400);
      expect(parsed.error.code).toBe(MCP_CODE_PARSE_ERROR);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
