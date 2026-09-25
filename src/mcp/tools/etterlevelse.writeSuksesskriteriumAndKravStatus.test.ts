import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Dekker den faktiske kablingen for write_suksesskriterium og write_krav_status:
// guards (write-enabled, dokumentlås, UTGAATT-krav), behovForBegrunnelse-sanering,
// og at write_krav_status ikke rører suksesskriterie-listen. Selve
// flette-/optimistisk-låsing-logikken er allerede enhetstestet direkte mot
// EtterlevelseClient i api/etterlevelseClient.test.ts.
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

function fakeClient(overrides: Partial<ReturnType<typeof baseFakeClient>> = {}) {
  return { ...baseFakeClient(), ...overrides };
}

function baseFakeClient() {
  return {
    getKrav: vi.fn().mockResolvedValue({
      status: 'AKTIV',
      navn: 'Testkrav',
      hensikt: 'Testhensikt',
      suksesskriterier: [
        { id: 1, navn: 'SK1', behovForBegrunnelse: true },
        { id: 2, navn: 'SK2', behovForBegrunnelse: false },
      ],
    }),
    getEtterlevelse: vi.fn().mockResolvedValue({
      suksesskriterieBegrunnelser: [{ suksesskriterieId: 1, begrunnelse: 'Gammel tekst' }],
    }),
    writeSuksesskriterium: vi.fn().mockResolvedValue({ id: 'etterlevelse-1' }),
    writeKravStatus: vi.fn().mockResolvedValue({ id: 'etterlevelse-1' }),
  };
}

function ctxWithClient(client: unknown): SessionContext {
  return {
    mcpAccessToken: 'access-token-write-test',
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

// Henter et gyldig reviewToken via begin_sk_review, som write_suksesskriterium nå krever.
async function beginReview(
  server: ReturnType<typeof fakeServer>,
  overrides: { suksesskriterieId: number } & Record<string, unknown> = { suksesskriterieId: 1 },
): Promise<string> {
  const result = (await server.invoke('begin_sk_review', {
    etterlevelseDokumentasjonId: 'doc-1',
    kravNummer: 100,
    kravVersjon: 1,
    ...overrides,
  })) as { structuredContent: { reviewToken: string } };
  return result.structuredContent.reviewToken;
}

describe('write_suksesskriterium', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('feiler når write-enabled-toggle er av', async () => {
    isWriteEnabledMock.mockReturnValue(false);
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.writeSuksesskriterium).not.toHaveBeenCalled();
  });

  it('feiler når dokumentlåsen ikke matcher', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'annet-doc',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.writeSuksesskriterium).not.toHaveBeenCalled();
  });

  it('blokkerer skriving mot et UTGAATT-krav', async () => {
    const client = fakeClient({
      getKrav: vi.fn().mockResolvedValue({ status: 'UTGAATT' }),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.writeSuksesskriterium).not.toHaveBeenCalled();
  });

  it('fjerner begrunnelsestekst når behovForBegrunnelse er false for suksesskriteriet', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    const reviewToken = await beginReview(server, { suksesskriterieId: 2 });

    await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 2, // behovForBegrunnelse: false
      begrunnelse: 'Denne skal ikke sendes',
      suksesskriterieStatus: 'IKKE_RELEVANT',
      reviewToken,
      brukerGodkjenning: 'G',
    });

    expect(client.writeSuksesskriterium).toHaveBeenCalledWith(
      expect.objectContaining({ suksesskriterieId: 2, begrunnelse: '' }),
    );
  });

  it('sender begrunnelsen uendret når behovForBegrunnelse er true', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    const reviewToken = await beginReview(server, { suksesskriterieId: 1 });

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny begrunnelse for SK1',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    })) as { structuredContent: { summary: string } };

    expect(client.writeSuksesskriterium).toHaveBeenCalledWith(
      expect.objectContaining({ suksesskriterieId: 1, begrunnelse: 'Ny begrunnelse for SK1' }),
    );
    // Summary skal vise både gammel og ny begrunnelse for menneskelig gjennomgang
    expect(result.structuredContent.summary).toContain('Gammel tekst');
    expect(result.structuredContent.summary).toContain('Ny begrunnelse for SK1');
  });
});

describe('begin_sk_review / write_suksesskriterium — reviewToken-gate', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('avviser skriving uten reviewToken med en lærende feilmelding', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken: 'ikke-utstedt-token',
      brukerGodkjenning: 'G',
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('begin_sk_review');
    expect(client.writeSuksesskriterium).not.toHaveBeenCalled();
  });

  it('avviser skriving når reviewToken gjelder et annet suksesskriterium', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    const reviewToken = await beginReview(server, { suksesskriterieId: 2 });

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1, // token gjelder SK2, ikke SK1
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Tokenet gjelder');
    expect(client.writeSuksesskriterium).not.toHaveBeenCalled();
  });

  it('avviser gjenbruk av et allerede konsumert reviewToken', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    const reviewToken = await beginReview(server, { suksesskriterieId: 1 });

    await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Første skriving',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    });

    const secondResult = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Forsøk på gjenbruk av samme token',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    })) as { isError?: boolean };

    expect(secondResult.isError).toBe(true);
    expect(client.writeSuksesskriterium).toHaveBeenCalledTimes(1);
  });

  it('gjenoppretter reviewToken hvis skrivingen feiler, slik at samme token kan brukes på nytt', async () => {
    const client = fakeClient({
      writeSuksesskriterium: vi
        .fn()
        .mockRejectedValueOnce(new Error('Midlertidig backend-feil'))
        .mockResolvedValueOnce({ id: 'etterlevelse-1' }),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    const reviewToken = await beginReview(server, { suksesskriterieId: 1 });

    const failedResult = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Første forsøk',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    })) as { isError?: boolean };
    expect(failedResult.isError).toBe(true);

    // Tokenet skal fortsatt være gyldig — det ble reservert før skrivingen, men gjenopprettet
    // fordi skrivingen kastet en feil.
    const retryResult = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Andre forsøk',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken,
      brukerGodkjenning: 'G',
    })) as { isError?: boolean };

    expect(retryResult.isError).toBeFalsy();
    expect(client.writeSuksesskriterium).toHaveBeenCalledTimes(2);
  });
});

describe('begin_sk_review — presentasjon av eksisterende besvarelse', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('viser eksisterende status selv når begrunnelsen er tom', async () => {
    const client = fakeClient({
      getEtterlevelse: vi.fn().mockResolvedValue({
        suksesskriterieBegrunnelser: [{ suksesskriterieId: 2, suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: '' }],
      }),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('begin_sk_review', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 2,
    })) as { structuredContent: { presentasjon: string } };

    expect(result.structuredContent.presentasjon).toContain('IKKE_RELEVANT');
    expect(result.structuredContent.presentasjon).not.toContain('Ingen eksisterende besvarelse');
  });
});

describe('write_suksesskriterium — sesjonssporet optimistisk låsing (expectedVersion)', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  // Regresjonstest for brukerens innsigelse: hvis agenten leser kravet én gang
  // (get_krav_for_gjennomgang/get_etterlevelse) og deretter skriver FLERE
  // suksesskriterier etter hverandre i samme sesjon, må IKKE den andre skrivingen
  // avvises fordi backend har inkrementert version etter den FØRSTE skrivingen. MCP-
  // serveren må selv oppdatere sesjonens kjente version etter hver vellykket skriving,
  // slik at neste kall sammenlignes mot den ferske versjonen — ikke den opprinnelige
  // lesingen.
  it('bruker oppdatert version fra forrige skriveresultat ved påfølgende skriving mot samme krav', async () => {
    // currentVersion simulerer backendens fasit — inkrementeres av writeSuksesskriterium,
    // og enhver getEtterlevelse-lesing (inkl. den begin_sk_review nå også gjør) reflekterer
    // alltid nåværende backend-version, akkurat som i produksjon.
    let currentVersion = 5;
    const client = fakeClient({
      getEtterlevelse: vi.fn().mockImplementation(() =>
        Promise.resolve({
          version: currentVersion,
          suksesskriterieBegrunnelser: [
            { suksesskriterieId: 1, begrunnelse: 'Gammel tekst' },
            { suksesskriterieId: 2, begrunnelse: 'Gammel SK2' },
          ],
        }),
      ),
      writeSuksesskriterium: vi.fn().mockImplementation(() => {
        currentVersion += 1;
        return Promise.resolve({ id: 'etterlevelse-1', version: currentVersion });
      }),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    // Simulerer en tidligere lesing av kravet (f.eks. get_krav_for_gjennomgang eller
    // get_etterlevelse), som setter den første kjente versjonen (5) i sesjonen.
    await server.invoke('get_etterlevelse', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
    });

    await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny SK1',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken: await beginReview(server, { suksesskriterieId: 1 }),
      brukerGodkjenning: 'G',
    });
    // Backend har nå inkrementert version til 6 (returnert i writeResult over).
    expect(client.writeSuksesskriterium).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedVersion: 5 }),
    );

    await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 2,
      begrunnelse: 'Ny SK2',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken: await beginReview(server, { suksesskriterieId: 2 }),
      brukerGodkjenning: 'G',
    });
    // Andre skriving skal bruke version 6 (fra FØRSTE skriveresultat), ikke den
    // opprinnelige lesingen (5) — ellers ville dette blitt avvist som falsk konflikt.
    expect(client.writeSuksesskriterium).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expectedVersion: 6 }),
    );
  });

  // Regresjonstest: hvis expectedVersion IKKE matcher backends klient-uavhengige
  // fasit (fordi en ekte ekstern bruker — f.eks. i etterlevelse-frontend — har endret
  // kravet), skal klientlaget avvise skrivingen. Dekkes i detalj i
  // api/etterlevelseClient.test.ts; her bekrefter vi at feilen når helt frem til
  // tool-svaret (isError) uten å bli slukt.
  it('avviser skriving når backend rapporterer versjonskonflikt', async () => {
    const client = fakeClient({
      writeSuksesskriterium: vi.fn().mockRejectedValue(
        new Error('Kravet er endret av noen andre siden du sist leste det'),
      ),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_suksesskriterium', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      suksesskriterieId: 1,
      begrunnelse: 'Ny tekst',
      suksesskriterieStatus: 'UNDER_ARBEID',
      reviewToken: await beginReview(server, { suksesskriterieId: 1 }),
      brukerGodkjenning: 'G',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('write_krav_status', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('feiler når write-enabled-toggle er av', async () => {
    isWriteEnabledMock.mockReturnValue(false);
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_krav_status', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'IKKE_RELEVANT',
      statusBegrunnelse: 'Gjelder ikke oss',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.writeKravStatus).not.toHaveBeenCalled();
  });

  it('blokkerer skriving mot et UTGAATT-krav', async () => {
    const client = fakeClient({
      getKrav: vi.fn().mockResolvedValue({ status: 'UTGAATT' }),
    });
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_krav_status', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'IKKE_RELEVANT',
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(client.writeKravStatus).not.toHaveBeenCalled();
  });

  it('sender kun krav-nivå status/statusBegrunnelse til klienten, uten suksesskriterie-data', async () => {
    const client = fakeClient();
    const ctx = ctxWithClient(client);
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);

    const result = (await server.invoke('write_krav_status', {
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'IKKE_RELEVANT',
      statusBegrunnelse: 'Gjelder ikke oss',
    })) as { structuredContent: { summary: string } };

    expect(client.writeKravStatus).toHaveBeenCalledWith({
      etterlevelseDokumentasjonId: 'doc-1',
      kravNummer: 100,
      kravVersjon: 1,
      status: 'IKKE_RELEVANT',
      statusBegrunnelse: 'Gjelder ikke oss',
    });
    expect(result.structuredContent.summary).toContain('IKKE_RELEVANT');
    expect(result.structuredContent.summary).toContain('Gjelder ikke oss');
  });
});
