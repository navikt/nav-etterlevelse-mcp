import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  MCP_MODERN_VERSION,
} from './mcp2026.js';

vi.mock('../unleash.js', () => ({
  isWriteEnabled: () => false,
}));

const { handleGatewayMcpRequest } = await import('./server.js');
const { config } = await import('../config.js');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildGatewayApp() {
  const app = express();
  app.use(express.json());
  app.post('/mcp/gw', (req, res, next) => {
    void handleGatewayMcpRequest(req, res, {
      userToken: 'gw-user-token',
      refreshToken: null,
      azureExpiresAt: Date.now() + 3600_000,
      userEmail: 'ola@nav.no',
      userName: 'Ola Nordmann',
      userGroups: [],
    }).catch(next);
  });
  return app;
}

async function postToolCall(app: express.Express, toolName: string, args: Record<string, unknown>) {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/gw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': MCP_MODERN_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': toolName,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
          _meta: {
            [MCP_META_PROTOCOL_VERSION]: MCP_MODERN_VERSION,
            [MCP_META_CLIENT_CAPABILITIES]: {},
          },
        },
      }),
    });
    const json = (await response.json()) as Record<string, unknown>;
    return { status: response.status, json };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('handleGatewayMcpRequest — tokenveksling per backend', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('behandlingskatalog-lesing virker når etterlevelse-OBO feiler, uten å hente Graph M2M-token', async () => {
    const tokenRequests: Array<{ url: string; target?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        if (href === config.api.texasTokenExchangeUrl) {
          const body = JSON.parse(init?.body as string) as { target?: string };
          tokenRequests.push({ url: href, target: body.target });
          if (body.target === config.azure.etterlevelseScope) {
            return jsonResponse({ error: 'etterlevelse unavailable' }, 500);
          }
          if (body.target === config.azure.behandlingskatalogScope) {
            return jsonResponse({ access_token: 'bk-obo-token' });
          }
        }
        if (href === config.api.texasTokenUrl) {
          const body = JSON.parse(init?.body as string) as { target?: string };
          tokenRequests.push({ url: href, target: body.target });
          return jsonResponse({ access_token: 'graph-token' });
        }
        if (new URL(href).origin === new URL(config.api.behandlingskatalogBaseUrl).origin) {
          return jsonResponse({
            content: [{ id: 'proc-1', number: 123, name: 'Dagpenger', purposes: [], status: 'ACTIVE' }],
          });
        }
        return originalFetch(url, init);
      }),
    );

    const res = await postToolCall(buildGatewayApp(), 'search_behandlinger', { search: 'B123' });

    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('B123');
    expect(tokenRequests).toEqual([
      { url: config.api.texasTokenExchangeUrl, target: config.azure.behandlingskatalogScope },
    ]);
  });

  it('etterlevelse-lesing henter kun etterlevelse-OBO og ikke Graph M2M-token', async () => {
    const tokenRequests: Array<{ url: string; target?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = url.toString();
        if (href === config.api.texasTokenExchangeUrl || href === config.api.texasTokenUrl) {
          const body = JSON.parse(init?.body as string) as { target?: string };
          tokenRequests.push({ url: href, target: body.target });
          return jsonResponse({ access_token: 'etterlevelse-obo-token' });
        }
        if (new URL(href).origin === new URL(config.api.etterlevelseBaseUrl).origin) {
          return jsonResponse({ content: [{ id: 'team-1', name: 'Team DAB' }] });
        }
        return originalFetch(url, init);
      }),
    );

    const res = await postToolCall(buildGatewayApp(), 'get_my_teams', {});

    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(tokenRequests).toEqual([
      { url: config.api.texasTokenExchangeUrl, target: config.azure.etterlevelseScope },
    ]);
  });
});
