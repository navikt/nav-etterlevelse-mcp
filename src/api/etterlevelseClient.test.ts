import { afterEach, describe, expect, it, vi } from 'vitest';
import { EtterlevelseClient } from './etterlevelseClient.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Regresjonstest for datatapfeilen fikset i PR #21: etterlevelse-backend
// (EtterlevelseRequest.mergeInto) erstatter hele suksesskriterieBegrunnelser-listen
// ved oppdatering — den flettes ikke sammen på serversiden. writeSuksesskriterium og
// writeKravStatus må derfor selv bevare eksisterende suksesskriterier som ikke er
// del av kallet.
describe('EtterlevelseClient.writeSuksesskriterium', () => {
  const etterlevelseDokumentasjonId = 'doc-1';
  const kravNummer = 5;
  const kravVersjon = 1;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bevarer eksisterende suksesskriterier som ikke er del av kallet ved oppdatering', async () => {
    const existingEtterlevelse = {
      id: 'etterlevelse-1',
      version: 3,
      kravNummer,
      kravVersjon,
      status: 'UNDER_REDIGERING',
      statusBegrunnelse: 'Jobber med kravet',
      etterleves: true,
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Gammel SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
        { suksesskriterieId: 2, begrunnelse: 'Gammel SK2', suksesskriterieStatus: 'UNDER_ARBEID' },
        { suksesskriterieId: 3, begrunnelse: 'Gammel SK3', suksesskriterieStatus: 'IKKE_OPPFYLT' },
      ],
    };

    let capturedPutBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        capturedPutBody = JSON.parse(init.body as string);
        return jsonResponse({ ...existingEtterlevelse, ...capturedPutBody });
      }
      // GET /etterlevelse/etterlevelseDokumentasjon/{docId}/{kravNummer}
      return jsonResponse([existingEtterlevelse]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await client.writeSuksesskriterium({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      suksesskriterieId: 2,
      begrunnelse: 'Ny SK2',
      suksesskriterieStatus: 'UNDER_ARBEID',
    });

    expect(capturedPutBody).toBeDefined();
    // Krav-nivå status/statusBegrunnelse skal videreføres uendret, ikke rørt.
    expect(capturedPutBody!.status).toBe('UNDER_REDIGERING');
    expect(capturedPutBody!.statusBegrunnelse).toBe('Jobber med kravet');
    // version sendes ikke med — backends EtterlevelseRequest-DTO har ikke et
    // version-felt, og ville uansett stille ignorert det (se writeEtterlevelseWithVersionCheck).
    expect(capturedPutBody!.version).toBeUndefined();

    const sentSKBs = capturedPutBody!.suksesskriterieBegrunnelser as Array<Record<string, unknown>>;
    expect(sentSKBs).toHaveLength(3);

    const byId = Object.fromEntries(sentSKBs.map((skb) => [skb.suksesskriterieId, skb]));
    expect(byId[1]?.begrunnelse).toBe('Gammel SK1');
    expect(byId[3]?.begrunnelse).toBe('Gammel SK3');
    expect(byId[2]?.begrunnelse).toBe('Ny SK2');
  });

  it('oppretter ny etterlevelse med kun det innsendte suksesskriteriet når det ikke finnes en eksisterende besvarelse', async () => {
    let capturedPostBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        capturedPostBody = JSON.parse(init.body as string);
        return jsonResponse({ id: 'ny-etterlevelse', ...capturedPostBody });
      }
      // Ingen eksisterende etterlevelse funnet
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await client.writeSuksesskriterium({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      suksesskriterieId: 1,
      begrunnelse: 'Første SK',
      suksesskriterieStatus: 'UNDER_ARBEID',
    });

    expect(capturedPostBody).toBeDefined();
    expect(capturedPostBody!.status).toBe('UNDER_REDIGERING');
    expect(capturedPostBody!.suksesskriterieBegrunnelser).toEqual([
      { suksesskriterieId: 1, begrunnelse: 'Første SK', suksesskriterieStatus: 'UNDER_ARBEID' },
    ]);
  });

  // Regresjonstest: optimistisk låsing gjøres på KLIENTSIDEN via expectedVersion, ikke
  // av backend (backends EtterlevelseRequest-DTO har ikke noe version-felt, og
  // EtterlevelseService.save laster/lagrer i samme transaksjon, så en versjon sendt fra
  // klienten kan aldri utløse en konflikt der). Hvis kallet oppgir expectedVersion fra en
  // tidligere lesing, og den ferskeste lesingen rett før skriving har en annen version,
  // betyr det at noen andre — f.eks. en bruker i etterlevelse-frontend — har endret
  // kravet i mellomtiden. Da skal skrivingen avbrytes FØR PUT/POST sendes, ikke overskrive
  // endringen deres stille.
  it('avbryter skriving uten å sende PUT når expectedVersion ikke matcher fersk lesing (samtidig redigering)', async () => {
    const staleEtterlevelse = {
      id: 'etterlevelse-1',
      version: 3,
      kravNummer,
      kravVersjon,
      status: 'UNDER_REDIGERING',
      statusBegrunnelse: '',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Gammel SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
      ],
    };
    // En annen bruker (f.eks. i etterlevelse-frontend) har i mellomtiden lagret en ny
    // version med en endret SK2 vi ikke visste om, da vi leste inn version 3.
    const freshEtterlevelse = {
      ...staleEtterlevelse,
      version: 4,
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Gammel SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
        { suksesskriterieId: 2, begrunnelse: 'Fra frontend', suksesskriterieStatus: 'UNDER_ARBEID' },
      ],
    };

    let putCallCount = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        putCallCount += 1;
        return jsonResponse(freshEtterlevelse);
      }
      return jsonResponse([freshEtterlevelse]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await expect(
      client.writeSuksesskriterium({
        etterlevelseDokumentasjonId,
        kravNummer,
        kravVersjon,
        suksesskriterieId: 3,
        begrunnelse: 'Ny SK3',
        suksesskriterieStatus: 'UNDER_ARBEID',
        expectedVersion: 3,
      }),
    ).rejects.toThrow(/endret av noen andre/i);

    expect(putCallCount).toBe(0);
  });

  it('skriver uten sjekk når expectedVersion ikke er oppgitt, selv om kravet er endret siden sist', async () => {
    const freshEtterlevelse = {
      id: 'etterlevelse-1',
      version: 4,
      kravNummer,
      kravVersjon,
      status: 'UNDER_REDIGERING',
      statusBegrunnelse: '',
      suksesskriterieBegrunnelser: [],
    };

    let capturedPutBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        capturedPutBody = JSON.parse(init.body as string);
        return jsonResponse({ ...freshEtterlevelse, ...capturedPutBody });
      }
      return jsonResponse([freshEtterlevelse]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await client.writeSuksesskriterium({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      suksesskriterieId: 1,
      begrunnelse: 'Ny SK1',
      suksesskriterieStatus: 'UNDER_ARBEID',
    });

    expect(capturedPutBody).toBeDefined();
  });

  // Regresjonstest for brukerens innsigelse: 403 fra dette endepunktet er bekreftet
  // (via backendens kildekode) KUN manglende team/ressurser på etterlevelsesdokumentasjonen
  // — ikke en versjonskonflikt. Feilen skal derfor videreføres uendret, ikke omtolkes.
  it('videresender backends 403-feilmelding uendret (manglende team/ressurser), uten å anta konflikt', async () => {
    const existingEtterlevelse = {
      id: 'etterlevelse-1',
      version: 3,
      kravNummer,
      kravVersjon,
      status: 'UNDER_REDIGERING',
      statusBegrunnelse: '',
      suksesskriterieBegrunnelser: [],
    };

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return jsonResponse(
          { message: 'Har du lagt til team og eller person i dokument egenskaper?' },
          403,
        );
      }
      return jsonResponse([existingEtterlevelse]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await expect(
      client.writeSuksesskriterium({
        etterlevelseDokumentasjonId,
        kravNummer,
        kravVersjon,
        suksesskriterieId: 1,
        begrunnelse: 'Tekst',
        suksesskriterieStatus: 'UNDER_ARBEID',
      }),
    ).rejects.toThrow(/team og eller person/i);
  });
});

describe('EtterlevelseClient.writeKravStatus', () => {
  const etterlevelseDokumentasjonId = 'doc-1';
  const kravNummer = 5;
  const kravVersjon = 1;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('oppdaterer kun krav-nivå status/statusBegrunnelse og lar suksesskriterielisten stå urørt', async () => {
    const existingEtterlevelse = {
      id: 'etterlevelse-1',
      version: 4,
      kravNummer,
      kravVersjon,
      status: 'UNDER_REDIGERING',
      statusBegrunnelse: 'Gammel begrunnelse',
      etterleves: true,
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'SK1', suksesskriterieStatus: 'UNDER_ARBEID' },
        { suksesskriterieId: 2, begrunnelse: 'SK2', suksesskriterieStatus: 'IKKE_OPPFYLT' },
      ],
    };

    let capturedPutBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        capturedPutBody = JSON.parse(init.body as string);
        return jsonResponse({ ...existingEtterlevelse, ...capturedPutBody });
      }
      return jsonResponse([existingEtterlevelse]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await client.writeKravStatus({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      status: 'IKKE_RELEVANT',
      statusBegrunnelse: 'Gjelder ikke oss',
    });

    expect(capturedPutBody).toBeDefined();
    expect(capturedPutBody!.status).toBe('IKKE_RELEVANT');
    expect(capturedPutBody!.statusBegrunnelse).toBe('Gjelder ikke oss');
    expect(capturedPutBody!.etterleves).toBe(false);
    // version sendes ikke med — se writeEtterlevelseWithVersionCheck.
    expect(capturedPutBody!.version).toBeUndefined();

    const sentSKBs = capturedPutBody!.suksesskriterieBegrunnelser as Array<Record<string, unknown>>;
    expect(sentSKBs).toHaveLength(2);
    expect(sentSKBs.find((skb) => skb.suksesskriterieId === 1)?.begrunnelse).toBe('SK1');
    expect(sentSKBs.find((skb) => skb.suksesskriterieId === 2)?.begrunnelse).toBe('SK2');
  });

  it('setter UNDER_ARBEID-status til UNDER_REDIGERING på krav-nivå', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    let capturedPostBody: Record<string, unknown> | undefined;
    const fetchMockPost = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        capturedPostBody = JSON.parse(init.body as string);
        return jsonResponse({ id: 'ny-etterlevelse', ...capturedPostBody });
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMockPost);

    const client = new EtterlevelseClient('fake-token', 'https://test.local/api');

    await client.writeKravStatus({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      status: 'UNDER_ARBEID',
    });

    expect(capturedPostBody).toBeDefined();
    expect(capturedPostBody!.status).toBe('UNDER_REDIGERING');
    expect(capturedPostBody!.etterleves).toBe(true);
    expect(capturedPostBody!.statusBegrunnelse).toBe('');
  });
});
