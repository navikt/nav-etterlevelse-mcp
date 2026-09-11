import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// buildBatchWarning/consumePendingReviews er allerede enhetstestet som rene
// funksjoner (etterlevelse.batchWarning.test.ts), men selve kablingen inn i
// write_etterlevelse-handleren — at advarselen faktisk havner i summary-teksten
// OG det strukturerte batchWarning-feltet, beregnet fra riktig payload — er
// ikke dekket uten å faktisk registrere og kalle den ekte tool-handleren.
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
    getKrav: vi.fn().mockResolvedValue({
      status: 'AKTIV',
      navn: 'Testkrav',
      hensikt: 'Testhensikt',
      suksesskriterier: [
        { id: 1, navn: 'SK1', behovForBegrunnelse: true },
        { id: 2, navn: 'SK2', behovForBegrunnelse: true },
      ],
    }),
    getEtterlevelse: vi.fn().mockResolvedValue(null),
    upsertEtterlevelse: vi.fn().mockResolvedValue({ id: 'etterlevelse-1' }),
  };
}

function ctxWithClient(client: ReturnType<typeof fakeClient>): SessionContext {
  return {
    mcpAccessToken: 'access-token-write-etterlevelse-test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: {
      userToken: 'user-token',
      refreshToken: null,
      azureExpiresAt: 0,
      userEmail: 'bruker@nav.no',
      userName: 'Bruker Brukersen',
      userGroups: [],
      lockedDocumentId: 'doc-1',
    },
  };
}

interface WriteEtterlevelseResponse {
  structuredContent: {
    summary: string;
    batchWarning: string | null;
  };
}

describe('write_etterlevelse — batchWarning i faktisk tool-respons', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('flagger advarsel i både summary og strukturert felt for et ikke-unntatt to-SK-kall', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_etterlevelse', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'UNDER_ARBEID',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Begrunnelse for SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
        { suksesskriterieId: 2, begrunnelse: 'Begrunnelse for SK2', suksesskriterieStatus: 'IKKE_RELEVANT' },
      ],
    })) as WriteEtterlevelseResponse;

    expect(result.structuredContent.batchWarning).not.toBeNull();
    expect(result.structuredContent.batchWarning).toContain('2 suksesskriterie-begrunnelser');
    expect(result.structuredContent.batchWarning).toContain('kun 0');
    expect(result.structuredContent.summary).toContain('⚠  Denne skrivingen');
  });

  it('flagger ingen advarsel for det sanksjonerte IKKE_RELEVANT-unntaket', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_etterlevelse', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'IKKE_RELEVANT',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Gjelder ikke', suksesskriterieStatus: 'IKKE_RELEVANT' },
        { suksesskriterieId: 2, begrunnelse: 'Gjelder ikke', suksesskriterieStatus: 'IKKE_RELEVANT' },
      ],
    })) as WriteEtterlevelseResponse;

    expect(result.structuredContent.batchWarning).toBeNull();
    expect(result.structuredContent.summary).not.toContain('⚠  Denne skrivingen');
  });

  it('flagger ingen advarsel for et enkeltstående SK-kall', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_etterlevelse', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'UNDER_ARBEID',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Begrunnelse for SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
      ],
    })) as WriteEtterlevelseResponse;

    expect(result.structuredContent.batchWarning).toBeNull();
  });
});
