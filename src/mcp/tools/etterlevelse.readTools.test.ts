import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionContext } from '../server.js';

vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => false,
}));

const { registerEtterlevelseTools } = await import('./etterlevelse.js');

function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, _config: unknown, handler: any) => {
      handlers.set(name, handler);
    },
    invoke: (name: string, args: unknown = {}) => {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`Tool "${name}" ble aldri registrert`);
      }
      return handler(args);
    },
  };
}

function fakeClient() {
  return {
    getPvkDokument: vi.fn().mockResolvedValue({ id: 'pvk-1', status: 'UNDERARBEID' }),
    getBehandlingensLivsloep: vi.fn().mockResolvedValue({ id: 'lv-1', beskrivelse: 'Dataflyt', filer: [] }),
    getRisikoscenarioer: vi.fn().mockResolvedValue([{ id: 'rs-1', navn: 'Scenario 1', beskrivelse: 'Desc' }]),
    getTiltakForPvkDokument: vi.fn().mockResolvedValue([{ id: 't-1', navn: 'Tiltak 1', beskrivelse: 'Desc' }]),
  };
}

function setup(
  client: ReturnType<typeof fakeClient>,
  lock: { lockedDocumentId?: string; lockedPvkDokumentId?: string; lockedDocumentTitle?: string } = {},
) {
  const ctx: SessionContext = {
    mcpAccessToken: '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: {
      userToken: 'user-token',
      refreshToken: null,
      azureExpiresAt: 0,
      userEmail: 'bruker@nav.no',
      userName: 'Bruker',
      userGroups: [],
      ...lock,
    },
  };
  const server = fakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  return server;
}

describe('stateless leseverktøy uten dokumentlås (issue #59)', () => {
  it('get_pvk_dokument virker med eksplisitt etterlevelseDokumentasjonId uten lås', async () => {
    const client = fakeClient();
    const server = setup(client);

    const res = (await server.invoke('get_pvk_dokument', {
      etterlevelseDokumentasjonId: 'doc-42',
    })) as { isError?: boolean; structuredContent: { found: boolean; pvkDokumentId: string } };

    expect(res.isError).toBeFalsy();
    expect(client.getPvkDokument).toHaveBeenCalledWith('doc-42');
    expect(res.structuredContent.found).toBe(true);
    expect(res.structuredContent.pvkDokumentId).toBe('pvk-1');
  });

  it('get_behandlingens_livsloep virker med eksplisitt etterlevelseDokumentasjonId uten lås', async () => {
    const client = fakeClient();
    const server = setup(client);

    const res = (await server.invoke('get_behandlingens_livsloep', {
      etterlevelseDokumentasjonId: 'doc-42',
    })) as { isError?: boolean; structuredContent: { found: boolean } };

    expect(res.isError).toBeFalsy();
    expect(client.getBehandlingensLivsloep).toHaveBeenCalledWith('doc-42');
    expect(res.structuredContent.found).toBe(true);
  });

  it('list_risikoscenarioer virker med pvkDokumentId eller etterlevelseDokumentasjonId uten lås', async () => {
    const client = fakeClient();
    const server = setup(client);

    const byPvk = (await server.invoke('list_risikoscenarioer', {
      pvkDokumentId: 'pvk-99',
    })) as { isError?: boolean; structuredContent: { count: number; pvkDokumentId: string } };

    expect(byPvk.isError).toBeFalsy();
    expect(client.getRisikoscenarioer).toHaveBeenCalledWith('pvk-99');
    expect(byPvk.structuredContent.count).toBe(1);

    const byDoc = (await server.invoke('list_risikoscenarioer', {
      etterlevelseDokumentasjonId: 'doc-42',
    })) as { isError?: boolean; structuredContent: { pvkDokumentId: string } };

    expect(byDoc.isError).toBeFalsy();
    expect(client.getPvkDokument).toHaveBeenCalledWith('doc-42');
    expect(client.getRisikoscenarioer).toHaveBeenCalledWith('pvk-1');
    expect(byDoc.structuredContent.pvkDokumentId).toBe('pvk-1');
  });

  it('list_tiltak virker med pvkDokumentId uten lås', async () => {
    const client = fakeClient();
    const server = setup(client);

    const res = (await server.invoke('list_tiltak', {
      pvkDokumentId: 'pvk-99',
    })) as { isError?: boolean; structuredContent: { count: number; pvkDokumentId: string } };

    expect(res.isError).toBeFalsy();
    expect(client.getTiltakForPvkDokument).toHaveBeenCalledWith('pvk-99');
    expect(res.structuredContent.count).toBe(1);
  });

  it('faller tilbake til låst dokument når argument utelates (direkte OAuth-flyt)', async () => {
    const client = fakeClient();
    const server = setup(client, {
      lockedDocumentId: 'doc-locked',
      lockedPvkDokumentId: 'pvk-locked',
      lockedDocumentTitle: 'Låst dok',
    });

    await server.invoke('get_pvk_dokument', {});
    await server.invoke('get_behandlingens_livsloep', {});
    await server.invoke('list_risikoscenarioer', {});
    await server.invoke('list_tiltak', {});

    expect(client.getPvkDokument).toHaveBeenCalledWith('doc-locked');
    expect(client.getBehandlingensLivsloep).toHaveBeenCalledWith('doc-locked');
    expect(client.getRisikoscenarioer).toHaveBeenCalledWith('pvk-locked');
    expect(client.getTiltakForPvkDokument).toHaveBeenCalledWith('pvk-locked');
  });

  it('gir tydelig feilmelding når verken ID eller lås er tilgjengelig', async () => {
    const client = fakeClient();
    const server = setup(client);

    for (const tool of ['get_pvk_dokument', 'get_behandlingens_livsloep', 'list_risikoscenarioer', 'list_tiltak']) {
      const res = (await server.invoke(tool, {})) as { isError?: boolean };
      expect(res.isError).toBe(true);
    }
  });

  it('avviser ../ og %2e%2e som ugyldige UUID-er i inputSchema uten å kalle backend', async () => {
    const client = fakeClient();
    const ctx: SessionContext = {
      mcpAccessToken: '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      etterlevelseClient: client as any,
      tokenData: {
        userToken: 'user-token',
        refreshToken: null,
        azureExpiresAt: 0,
        userEmail: 'bruker@nav.no',
        userName: 'Bruker',
        userGroups: [],
      },
    };
    const mcpServer = new McpServer({ name: 'test', version: '0.0.0' });
    registerEtterlevelseTools(mcpServer, ctx);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    try {
      const payloads = ['../admin', '%2e%2e/admin', '%2e%2e'];
      const cases: Array<{ name: string; key: string }> = [
        { name: 'get_pvk_dokument', key: 'etterlevelseDokumentasjonId' },
        { name: 'get_behandlingens_livsloep', key: 'etterlevelseDokumentasjonId' },
        { name: 'list_risikoscenarioer', key: 'pvkDokumentId' },
        { name: 'list_risikoscenarioer', key: 'etterlevelseDokumentasjonId' },
        { name: 'list_tiltak', key: 'pvkDokumentId' },
        { name: 'list_tiltak', key: 'etterlevelseDokumentasjonId' },
      ];

      for (const { name, key } of cases) {
        for (const payload of payloads) {
          const result = await mcpClient.callTool({ name, arguments: { [key]: payload } });
          expect(result.isError).toBe(true);
        }
      }

      expect(client.getPvkDokument).not.toHaveBeenCalled();
      expect(client.getBehandlingensLivsloep).not.toHaveBeenCalled();
      expect(client.getRisikoscenarioer).not.toHaveBeenCalled();
      expect(client.getTiltakForPvkDokument).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled([mcpClient.close(), mcpServer.close()]);
    }
  });
});
