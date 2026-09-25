import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Regresjonstest for trimmingen av get_krav_for_gjennomgang: verktøyet skal IKKE lenger
// returnere SK-beskrivelser (verken i summary-teksten eller i det rå krav-objektet som også
// eksponeres via structuredContent) — dette var invitasjonen til batch-presentasjon som
// begin_sk_review-tokenporten skal erstatte. id, navn og behovForBegrunnelse må derimot
// beholdes, siden agenten trenger dem for å kalle begin_sk_review i det hele tatt.
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
      kravNummer: 100,
      kravVersjon: 1,
      navn: 'Testkrav',
      hensikt: 'Testhensikt',
      status: 'AKTIV',
      suksesskriterier: [
        { id: 1, navn: 'SK1', beskrivelse: 'Hemmelig lang SK-tekst som ikke skal batch-vises', behovForBegrunnelse: true },
        { id: 2, navn: 'SK2', beskrivelse: 'Enda mer SK-tekst', behovForBegrunnelse: false },
      ],
    }),
    getEtterlevelse: vi.fn().mockResolvedValue({ suksesskriterieBegrunnelser: [] }),
  };
}

function ctxWithClient(client: unknown): SessionContext {
  return {
    mcpAccessToken: 'access-token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: {
      userToken: 'user-token',
      refreshToken: null,
      azureExpiresAt: 0,
      userEmail: 'bruker@nav.no',
      userName: 'Bruker Brukersen',
      userGroups: [],
    },
  };
}

describe('get_krav_for_gjennomgang', () => {
  it('utelater SK-beskrivelse fra både summary og det rå krav-objektet', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('get_krav_for_gjennomgang', { krav: 'K100.1' })) as {
      structuredContent: {
        summary: string;
        krav: { suksesskriterier: Array<Record<string, unknown>> };
      };
    };

    const { summary, krav } = result.structuredContent;

    expect(summary).not.toContain('Hemmelig lang SK-tekst');
    expect(summary).not.toContain('Enda mer SK-tekst');
    expect(summary).toContain('begin_sk_review');

    for (const sk of krav.suksesskriterier) {
      expect(sk).not.toHaveProperty('beskrivelse');
    }
    expect(krav.suksesskriterier[0]).toMatchObject({ id: 1, navn: 'SK1', behovForBegrunnelse: true });
    expect(krav.suksesskriterier[1]).toMatchObject({ id: 2, navn: 'SK2', behovForBegrunnelse: false });
  });
});
