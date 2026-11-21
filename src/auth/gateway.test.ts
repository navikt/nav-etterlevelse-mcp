import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayAuthMiddleware, getGatewayClientId, type GatewayLocals } from './gateway.js';

const TEST_GATEWAY_CLIENT_ID = 'gw-client-id';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runRequest(
  app: express.Express,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/mcp/gw`, {
      method: 'POST',
      headers,
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('getGatewayClientId', () => {
  const raw = JSON.stringify([
    { name: 'dev-gcp:copilot:fleet-gateway', clientId: 'dev-gw' },
    { name: 'prod-gcp:copilot:fleet-gateway', clientId: 'prod-gw' },
    { name: 'dev-gcp:other:fleet-gateway', clientId: 'other-gw' },
  ]);

  it('velger fleet-gateway for riktig cluster og namespace', () => {
    expect(getGatewayClientId(raw, 'dev-gcp')).toBe('dev-gw');
    expect(getGatewayClientId(raw, 'prod-gcp')).toBe('prod-gw');
    expect(getGatewayClientId(raw, '')).toBeNull();
  });

  it('avviser dev-gateway i prod og fremmed namespace', () => {
    const devOnly = JSON.stringify([{ name: 'dev-gcp:copilot:fleet-gateway', clientId: 'dev-gw' }]);
    expect(getGatewayClientId(devOnly, 'prod-gcp')).toBeNull();

    const wrongNs = JSON.stringify([{ name: 'dev-gcp:other:fleet-gateway', clientId: 'x' }]);
    expect(getGatewayClientId(wrongNs, 'dev-gcp')).toBeNull();
  });

  it('feiler lukket ved flere treff eller ugyldig JSON', () => {
    const dupes = JSON.stringify([
      { name: 'prod-gcp:copilot:fleet-gateway', clientId: 'a' },
      { name: 'prod-gcp:copilot:fleet-gateway', clientId: 'b' },
    ]);
    expect(getGatewayClientId(dupes, 'prod-gcp')).toBeNull();
    expect(() => getGatewayClientId('{', 'prod-gcp')).toThrow();
  });
});

describe('createGatewayAuthMiddleware', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function buildApp(options = { introspectionEndpoint: 'http://texas.local/introspect', gatewayClientId: TEST_GATEWAY_CLIENT_ID }) {
    const app = express();
    app.post('/mcp/gw', createGatewayAuthMiddleware(options), (_req, res) => {
      const locals = res.locals as GatewayLocals;
      res.json({ ok: true, navIdent: locals.navIdent, userEmail: locals.tokenData.userEmail });
    });
    return app;
  }

  function mockTexas(claims: Record<string, unknown>, status = 200) {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsedUrl = url instanceof URL ? url : new URL(url);
      if (parsedUrl.hostname === 'texas.local') {
        const parsed = JSON.parse(init?.body as string) as Record<string, string>;
        expect(parsed.identity_provider).toBe('entra_id');
        expect(parsed.token).toBe('tok');
        return jsonResponse(claims, status);
      }
      return originalFetch(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const originalFetch = globalThis.fetch;

  const cases: Array<{
    name: string;
    mutate: (claims: Record<string, unknown>) => void;
    wantStatus: number;
  }> = [
    { name: 'gyldig brukertoken slipper gjennom', mutate: () => {}, wantStatus: 200 },
    { name: 'inaktivt token avvises med 401', mutate: (c) => { c.active = false; }, wantStatus: 401 },
    { name: 'app-token (idtyp=app) avvises med 403', mutate: (c) => { c.idtyp = 'app'; }, wantStatus: 403 },
    { name: 'app-token (access_as_application) avvises med 403', mutate: (c) => { c.roles = ['access_as_application']; }, wantStatus: 403 },
    { name: 'manglende NAVident avvises med 403', mutate: (c) => { delete c.NAVident; }, wantStatus: 403 },
    { name: 'feil azp avvises med 403', mutate: (c) => { c.azp = 'other-app'; }, wantStatus: 403 },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      const claims: Record<string, unknown> = {
        active: true,
        NAVident: 'Z123456',
        azp: TEST_GATEWAY_CLIENT_ID,
        preferred_username: 'ola@nav.no',
        name: 'Ola Nordmann',
      };
      tc.mutate(claims);
      mockTexas(claims);

      const res = await runRequest(buildApp(), { Authorization: 'Bearer tok' });
      expect(res.status).toBe(tc.wantStatus);
      if (tc.wantStatus === 200) {
        expect(res.body.navIdent).toBe('Z123456');
        expect(res.body.userEmail).toBe('ola@nav.no');
      }
    });
  }

  it('avviser manglende Bearer-header med 401', async () => {
    const res = await runRequest(buildApp());
    expect(res.status).toBe(401);
  });

  it('returnerer 502 når Texas-introspeksjon svarer med feilstatus', async () => {
    mockTexas({ error: 'boom' }, 500);
    const res = await runRequest(buildApp(), { Authorization: 'Bearer tok' });
    expect(res.status).toBe(502);
  });

  it('feiler lukket med 503 når gatewayClientId mangler', async () => {
    const app = buildApp({ introspectionEndpoint: 'http://texas.local/introspect', gatewayClientId: null });
    const res = await runRequest(app, { Authorization: 'Bearer tok' });
    expect(res.status).toBe(503);
  });
});
