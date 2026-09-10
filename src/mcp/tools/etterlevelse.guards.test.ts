import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// requireDocumentLock og requireWriteEnabled er portvaktene som står foran
// *alle* skriveoperasjoner i etterlevelse- og PVK-verktøyene. En feil her
// (f.eks. feil sammenligning av dokument-id) ville åpnet for å skrive til
// feil dokument, eller omgå feature-toggle-sperren.
const isWriteEnabledMock = vi.fn();
vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => isWriteEnabledMock(),
}));

const { requireDocumentLock, requireWriteEnabled } = await import('./etterlevelse.js');

function ctxWithLock(overrides: Partial<SessionContext['tokenData']> = {}): SessionContext {
  return {
    mcpAccessToken: 'access-token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: {} as any,
    tokenData: {
      userToken: 'user-token',
      refreshToken: null,
      azureExpiresAt: 0,
      userEmail: 'bruker@nav.no',
      userName: 'Bruker Brukersen',
      userGroups: [],
      ...overrides,
    },
  };
}

describe('requireDocumentLock', () => {
  it('avviser når ingen dokumentlås er aktiv', () => {
    const ctx = ctxWithLock();

    const result = requireDocumentLock(ctx);

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Ingen dokumentlås aktiv');
  });

  it('godtar ethvert låst dokument når targetDocumentId ikke er oppgitt', () => {
    const ctx = ctxWithLock({ lockedDocumentId: 'doc-1', lockedDocumentTitle: 'Mitt dokument' });

    expect(requireDocumentLock(ctx)).toBeNull();
  });

  it('avviser når låst dokument ikke matcher targetDocumentId', () => {
    const ctx = ctxWithLock({ lockedDocumentId: 'doc-1', lockedDocumentTitle: 'Mitt dokument' });

    const result = requireDocumentLock(ctx, 'doc-2');

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('Mitt dokument');
  });

  it('godtar når låst dokument matcher targetDocumentId', () => {
    const ctx = ctxWithLock({ lockedDocumentId: 'doc-1' });

    expect(requireDocumentLock(ctx, 'doc-1')).toBeNull();
  });
});

describe('requireWriteEnabled', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReset();
  });

  it('avviser skriving når feature-toggle er av', () => {
    isWriteEnabledMock.mockReturnValue(false);

    const result = requireWriteEnabled();

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain('deaktivert via feature-toggle');
  });

  it('tillater skriving når feature-toggle er på', () => {
    isWriteEnabledMock.mockReturnValue(true);

    expect(requireWriteEnabled()).toBeNull();
  });
});
