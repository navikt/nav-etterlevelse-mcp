import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Dekker dynamisk codelist-validering (issue #43 Problem 1): write_pvk_egenskaper validerer
// ytterligereEgenskaper mot backend-codelisten YTTERLIGERE_EGENSKAPER i stedet for en hardkodet
// enum, slik at verktøyet ikke driver fra backend. Henter codelisten kun når feltet settes.
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
      if (!handler) throw new Error(`Tool "${name}" ble aldri registrert`);
      return handler(args);
    },
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getCodelist: vi.fn().mockResolvedValue([
      { code: 'PROFILERING', navn: 'Profilering', beskrivelse: null },
      { code: 'TEKNOLOGI', navn: 'Bruk av teknologi', beskrivelse: null },
      { code: 'SAARBARE_PERSONOPPLYSNING', navn: 'Sårbare registrerte', beskrivelse: null },
    ]),
    patchPvkDokument: vi.fn().mockResolvedValue({ id: 'pvk-1', ytterligereEgenskaper: [] }),
    ...overrides,
  };
}

function setup(client: unknown) {
  const ctx = {
    mcpAccessToken: 'token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: { lockedDocumentId: 'doc-1', lockedPvkDokumentId: 'pvk-1' },
  } as unknown as SessionContext;
  const server = fakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  return server;
}

describe('write_pvk_egenskaper — ytterligereEgenskaper mot codelist', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('godtar gyldige koder og sender normaliserte (trimmet/uppercase) koder i patch', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_pvk_egenskaper', {
      ytterligereEgenskaper: ['profilering', ' teknologi '],
    });

    expect(client.getCodelist).toHaveBeenCalledWith('YTTERLIGERE_EGENSKAPER');
    expect(client.patchPvkDokument).toHaveBeenCalledWith(
      'pvk-1',
      expect.objectContaining({ ytterligereEgenskaper: ['PROFILERING', 'TEKNOLOGI'] }),
    );
  });

  it('avviser ugyldig kode og sender ingen patch', async () => {
    const client = fakeClient();
    const server = setup(client);

    const result = (await server.invoke('write_pvk_egenskaper', {
      ytterligereEgenskaper: ['FINNES_IKKE'],
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.patchPvkDokument).not.toHaveBeenCalled();
  });

  it('feiler tydelig hvis codelist-hentingen feiler', async () => {
    const client = fakeClient({
      getCodelist: vi.fn().mockRejectedValue(new Error('backend nede')),
    });
    const server = setup(client);

    const result = (await server.invoke('write_pvk_egenskaper', {
      ytterligereEgenskaper: ['PROFILERING'],
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.patchPvkDokument).not.toHaveBeenCalled();
  });

  it('henter ikke codelist når ytterligereEgenskaper ikke settes', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_pvk_egenskaper', { dpProcessProfilering: true });

    expect(client.getCodelist).not.toHaveBeenCalled();
    expect(client.patchPvkDokument).toHaveBeenCalled();
  });

  it('get_ytterligere_egenskaper_koder returnerer kodene med etikett fra codelisten', async () => {
    const client = fakeClient();
    const server = setup(client);

    const result = (await server.invoke('get_ytterligere_egenskaper_koder', {})) as {
      structuredContent: { koder: Array<{ code: string; navn: string | null }> };
    };

    expect(client.getCodelist).toHaveBeenCalledWith('YTTERLIGERE_EGENSKAPER');
    expect(result.structuredContent.koder).toEqual([
      { code: 'PROFILERING', navn: 'Profilering', beskrivelse: null },
      { code: 'TEKNOLOGI', navn: 'Bruk av teknologi', beskrivelse: null },
      { code: 'SAARBARE_PERSONOPPLYSNING', navn: 'Sårbare registrerte', beskrivelse: null },
    ]);
  });
});
