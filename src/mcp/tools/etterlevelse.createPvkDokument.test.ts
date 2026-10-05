import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Dekker guardrailen fra issue #47: create_pvk_dokument må sette behovsvurderingen
// (pvkVurdering) ved opprettelse, og sende den videre til klienten, slik at et PVK-dokument
// aldri fødes som UNDEFINED (som ville låst dokumentet i UI-et). Den påkrevde pvkVurdering-enumen
// håndheves av zod-skjemaet i den ekte MCP-serveren; her testes handler-guardrailen (begrunnelse)
// og at vurderingen videreformidles til createPvkDokument.
const isWriteEnabledMock = vi.fn();
vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => isWriteEnabledMock(),
}));

const { registerEtterlevelseTools } = await import('./etterlevelse.js');

function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, _config: unknown, handler: any) => {
      handlers.set(name, handler);
    },
    invoke: (name: string, args: unknown) => {
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
    createPvkDokument: vi.fn().mockResolvedValue({ id: 'pvk-1', status: 'UNDERARBEID' }),
  };
}

function ctxWithClient(client: unknown, withLock = true): SessionContext {
  return {
    mcpAccessToken: 'access-token-pvk-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: {
      userToken: 'user-token',
      refreshToken: null,
      azureExpiresAt: 0,
      userEmail: 'bruker@nav.no',
      userName: 'Bruker Brukersen',
      userGroups: [],
      ...(withLock ? { lockedDocumentId: 'doc-1', lockedDocumentTitle: 'Testdokument' } : {}),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function setup(client: unknown, withLock = true) {
  const ctx = ctxWithClient(client, withLock);
  const server = fakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  return server;
}

describe('create_pvk_dokument', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('feiler når write-enabled-toggle er av', async () => {
    isWriteEnabledMock.mockReturnValue(false);
    const client = fakeClient();
    const server = setup(client);

    const result = (await server.invoke('create_pvk_dokument', {
      pvkVurdering: 'SKAL_UTFORE',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.createPvkDokument).not.toHaveBeenCalled();
  });

  it('feiler når det ikke finnes en dokumentlås', async () => {
    const client = fakeClient();
    const server = setup(client, false);

    const result = (await server.invoke('create_pvk_dokument', {
      pvkVurdering: 'SKAL_UTFORE',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.createPvkDokument).not.toHaveBeenCalled();
  });

  it('oppretter med SKAL_UTFORE og sender pvkVurdering i body', async () => {
    const client = fakeClient();
    const server = setup(client);

    const result = (await server.invoke('create_pvk_dokument', {
      pvkVurdering: 'SKAL_UTFORE',
    })) as { structuredContent: { pvkDokumentId: string; pvkVurdering: string } };

    expect(client.createPvkDokument).toHaveBeenCalledWith('doc-1', { pvkVurdering: 'SKAL_UTFORE' });
    expect(result.structuredContent.pvkDokumentId).toBe('pvk-1');
    expect(result.structuredContent.pvkVurdering).toBe('SKAL_UTFORE');
  });

  it('krever begrunnelse når pvkVurdering er SKAL_IKKE_UTFORE', async () => {
    const client = fakeClient();
    const server = setup(client);

    const result = (await server.invoke('create_pvk_dokument', {
      pvkVurdering: 'SKAL_IKKE_UTFORE',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.createPvkDokument).not.toHaveBeenCalled();
  });

  it('oppretter SKAL_IKKE_UTFORE med begrunnelse og sender begrunnelsen videre', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('create_pvk_dokument', {
      pvkVurdering: 'SKAL_IKKE_UTFORE',
      pvkVurderingsBegrunnelse: 'Behandler ikke personopplysninger.',
    });

    expect(client.createPvkDokument).toHaveBeenCalledWith('doc-1', {
      pvkVurdering: 'SKAL_IKKE_UTFORE',
      pvkVurderingsBegrunnelse: 'Behandler ikke personopplysninger.',
    });
  });
});
