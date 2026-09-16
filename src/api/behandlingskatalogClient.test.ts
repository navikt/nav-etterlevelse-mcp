import { afterEach, describe, expect, it, vi } from 'vitest';
import { BehandlingskatalogClient } from './behandlingskatalogClient.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Regresjonstest for issue #32: D-nummer (DpProcess, «Nav som databehandler») må håndteres
// parallelt med, men adskilt fra, B-nummer (Process). Testene sikrer at søk/oppslag treffer
// riktig polly-endepunkt (/dpprocess/* vs. /process/*) og at feltmappingen bruker
// DpProcessResponse-feltnavn (f.eks. dpProcessNumber, purposeDescription), ikke Process-feltene.
describe('BehandlingskatalogClient — D-nummer (DpBehandling)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('searchDpBehandlinger kaller dpprocess-søkeendepunktet og mapper felter', async () => {
    let capturedUrl: string | undefined;
    const fetchMock = vi.fn(async (url: string | URL) => {
      capturedUrl = url.toString();
      return jsonResponse([
        { id: 'dp-uuid-1', dpProcessNumber: '123', name: 'Utsendelse av vedtaksbrev', purposeDescription: 'Sende brev på vegne av annen etat' },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');
    const result = await client.searchDpBehandlinger('D123');

    expect(capturedUrl).toContain('/dpprocess/search/D123');
    expect(result).toEqual([
      {
        id: 'dp-uuid-1',
        number: 'D123',
        name: 'Utsendelse av vedtaksbrev',
        purposeDescription: 'Sende brev på vegne av annen etat',
      },
    ]);
  });

  it('getDpBehandling slår opp UUID via søk når kallet gjøres med D-nummer, deretter henter full post', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlString = url.toString();
      calledUrls.push(urlString);
      if (urlString.includes('/dpprocess/search/')) {
        return jsonResponse([{ id: 'dp-uuid-1', dpProcessNumber: '123', name: 'Utsendelse av vedtaksbrev' }]);
      }
      return jsonResponse({
        id: 'dp-uuid-1',
        dpProcessNumber: 123,
        name: 'Utsendelse av vedtaksbrev',
        description: 'Fullstendig beskrivelse',
        purposeDescription: 'Sende brev på vegne av annen etat',
        art9: false,
        art10: false,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');
    const result = await client.getDpBehandling('D123');

    expect(calledUrls[0]).toContain('/dpprocess/search/D123');
    expect(calledUrls[1]).toContain('/dpprocess/dp-uuid-1');
    expect(result).toMatchObject({
      id: 'dp-uuid-1',
      number: 'D123',
      name: 'Utsendelse av vedtaksbrev',
      description: 'Fullstendig beskrivelse',
      purposeDescription: 'Sende brev på vegne av annen etat',
    });
  });

  it('getDpBehandling trimmer whitespace før D-nummer-matching', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlString = url.toString();
      calledUrls.push(urlString);
      if (urlString.includes('/dpprocess/search/')) {
        return jsonResponse([{ id: 'dp-uuid-1', dpProcessNumber: '123', name: 'Utsendelse av vedtaksbrev' }]);
      }
      return jsonResponse({ id: 'dp-uuid-1', dpProcessNumber: 123, name: 'Utsendelse av vedtaksbrev' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');
    const result = await client.getDpBehandling('  D123  ');

    expect(calledUrls[0]).toContain('/dpprocess/search/D123');
    expect(calledUrls[1]).toContain('/dpprocess/dp-uuid-1');
    expect(result).toMatchObject({ id: 'dp-uuid-1', number: 'D123' });
  });

  it('getDpBehandling henter direkte på UUID uten søkeoppslag', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      calledUrls.push(url.toString());
      return jsonResponse({ id: 'dp-uuid-1', dpProcessNumber: 123, name: 'Utsendelse av vedtaksbrev' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');
    await client.getDpBehandling('dp-uuid-1');

    expect(calledUrls).toHaveLength(1);
    expect(calledUrls[0]).toContain('/dpprocess/dp-uuid-1');
  });

  it('kaster tydelig feil når D-nummeret ikke finnes i søkeresultatet', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');

    await expect(client.getDpBehandling('D999')).rejects.toThrow('Fant ikke behandling med nummer D999');
  });

  it('B-nummer-oppslag (getBehandling) bruker fortsatt /process/*, ikke /dpprocess/*', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlString = url.toString();
      calledUrls.push(urlString);
      if (urlString.includes('/process/search/')) {
        return jsonResponse([{ id: 'proc-uuid-1', number: '580', name: 'Behandling B580' }]);
      }
      return jsonResponse({ id: 'proc-uuid-1', number: '580', name: 'Behandling B580' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BehandlingskatalogClient('fake-token', 'https://test.local/api');
    await client.getBehandling('B580');

    expect(calledUrls.some((url) => url.includes('/dpprocess'))).toBe(false);
    expect(calledUrls[0]).toContain('/process/search/B580');
  });
});
