import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuthStore } from './store.js';
import type { McpTokenData } from './store.js';

// InMemoryAuthStore er hele sesjonsgrensen for OAuth-tokens, dokumentlåser og
// device code-flyt. Siden store.ts eksporterer kun singletonen `authStore`,
// bruker denne testen den eksporterte klassen for å få en isolert instans per test.
function tokenData(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    userToken: 'user-token',
    refreshToken: null,
    azureExpiresAt: 0,
    userEmail: 'bruker@nav.no',
    userName: 'Bruker Brukersen',
    userGroups: [],
    ...overrides,
  };
}

describe('InMemoryAuthStore', () => {
  let store: InMemoryAuthStore;

  beforeEach(() => {
    // Aktiver fake timers før store opprettes, slik at konstruktørens
    // setInterval-cleanup fanges opp av fake timers og aldri kjører på ekte
    // wall-clock-tid i bakgrunnen under testkjøringen.
    vi.useFakeTimers();
    store = new InMemoryAuthStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lagrer og henter en MCP-sesjon på access- og refresh-token', () => {
    const data = tokenData();
    store.saveMcpSession('access-1', 'refresh-1', 'client-1', data);

    expect(store.getMcpToken('access-1')).toEqual(data);
    expect(store.getRefreshToken('refresh-1')).toEqual({ clientId: 'client-1', tokenData: data });
  });

  it('updateMcpToken fletter inn partial oppdateringer på et gyldig token', () => {
    store.saveMcpSession('access-1', 'refresh-1', 'client-1', tokenData());

    const updated = store.updateMcpToken('access-1', {
      lockedDocumentId: 'doc-1',
      lockedDocumentTitle: 'Mitt dokument',
    });

    expect(updated).toBe(true);
    expect(store.getMcpToken('access-1')).toMatchObject({
      lockedDocumentId: 'doc-1',
      lockedDocumentTitle: 'Mitt dokument',
      userEmail: 'bruker@nav.no',
    });
  });

  it('updateMcpToken returnerer false for et token som ikke finnes', () => {
    expect(store.updateMcpToken('finnes-ikke', { lockedDocumentId: 'doc-1' })).toBe(false);
  });

  it('mcp-tokens slutter å være gyldige etter TTL-en utløper', () => {
    store.saveMcpSession('access-1', 'refresh-1', 'client-1', tokenData());

    expect(store.getMcpToken('access-1')).toBeDefined();

    // mcpAccessTokenTtlSeconds er 3600s (config.ts) — hopp forbi den
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);

    expect(store.getMcpToken('access-1')).toBeUndefined();
    // updateMcpToken skal heller ikke kunne "gjenopplive" et utløpt token
    expect(store.updateMcpToken('access-1', { lockedDocumentId: 'doc-1' })).toBe(false);
  });

  it('auth-koder kan kun konsumeres én gang (engangsbruk)', () => {
    store.saveAuthCode('code-1', {
      clientId: 'client-1',
      redirectUri: 'https://example.no/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      mcpAccessToken: 'access-1',
      mcpRefreshToken: 'refresh-1',
    });

    expect(store.consumeAuthCode('code-1')).toBeDefined();
    expect(store.consumeAuthCode('code-1')).toBeUndefined();
  });

  it('isRedirectUriAllowed validerer kun redirect-URI-er registrert for riktig klient', () => {
    const client = store.registerClient({ redirectUris: ['https://example.no/callback'] });

    expect(store.isRedirectUriAllowed(client.clientId, 'https://example.no/callback')).toBe(true);
    expect(store.isRedirectUriAllowed(client.clientId, 'https://ondsinnet.no/callback')).toBe(false);
    expect(store.isRedirectUriAllowed('ukjent-klient-id', 'https://example.no/callback')).toBe(false);
  });

  it('device-kobling: user_code peker til device_code, og indeksen ryddes ved konsumering', () => {
    store.saveDeviceAuthSession('device-1', {
      clientId: 'client-1',
      userCode: 'USER-CODE-1',
      status: 'pending',
    });

    expect(store.getDeviceCodeByUserCode('USER-CODE-1')).toBe('device-1');

    store.completeDeviceAuth('device-1', 'access-1', 'refresh-1');
    const session = store.getDeviceAuthSession('device-1');
    expect(session?.status).toBe('complete');
    expect(session?.mcpAccessToken).toBe('access-1');

    store.consumeDeviceAuth('device-1');
    expect(store.getDeviceAuthSession('device-1')).toBeUndefined();
    // Uten opprydding av user-code-indeksen ville en gjenbrukt kode pekt på en slettet sesjon
    expect(store.getDeviceCodeByUserCode('USER-CODE-1')).toBeUndefined();
  });
});
