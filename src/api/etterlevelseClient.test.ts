import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EtterlevelseClient } from './etterlevelseClient.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Regresjonstest for datatapfeilen fikset i PR #21: etterlevelse-backend
// (EtterlevelseRequest.mergeInto) erstatter hele suksesskriterieBegrunnelser-listen
// ved oppdatering — den flettes ikke sammen på serversiden. upsertEtterlevelse må
// derfor selv bevare eksisterende suksesskriterier som ikke er del av kallet.
describe('EtterlevelseClient.upsertEtterlevelse', () => {
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

    await client.upsertEtterlevelse({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      status: 'UNDER_ARBEID',
      statusBegrunnelse: 'Jobber med kravet',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 2, begrunnelse: 'Ny SK2', suksesskriterieStatus: 'UNDER_ARBEID' },
      ],
    });

    expect(capturedPutBody).toBeDefined();
    const sentSKBs = capturedPutBody!.suksesskriterieBegrunnelser as Array<Record<string, unknown>>;
    expect(sentSKBs).toHaveLength(3);

    const byId = Object.fromEntries(sentSKBs.map((skb) => [skb.suksesskriterieId, skb]));
    expect(byId[1]?.begrunnelse).toBe('Gammel SK1');
    expect(byId[3]?.begrunnelse).toBe('Gammel SK3');
    expect(byId[2]?.begrunnelse).toBe('Ny SK2');
  });

  it('sender kun de innsendte suksesskriteriene når det ikke finnes en eksisterende besvarelse', async () => {
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

    await client.upsertEtterlevelse({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      status: 'UNDER_ARBEID',
      suksesskriterieBegrunnelser: [
        { suksesskriterieId: 1, begrunnelse: 'Første SK', suksesskriterieStatus: 'UNDER_ARBEID' },
      ],
    });

    expect(capturedPostBody).toBeDefined();
    expect(capturedPostBody!.suksesskriterieBegrunnelser).toEqual([
      { suksesskriterieId: 1, begrunnelse: 'Første SK', suksesskriterieStatus: 'UNDER_ARBEID' },
    ]);
  });
});
