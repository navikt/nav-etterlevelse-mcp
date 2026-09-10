import { describe, expect, it } from 'vitest';
import {
  etterlevelseDokumentasjonReadOnlyFields,
  sanitizeEtterlevelseDokumentasjonForUpdate,
} from './etterlevelse.js';

// Regresjonstest for en tidligere datakorrumperingsfeil: write_etterlevelse_dokumentasjon
// nullet ut felt (bl.a. `version`) og senere feltet `risikoeiere`, fordi oppdateringen ikke
// bevarte det fullstendige, hentede dokumentet. sanitizeEtterlevelseDokumentasjonForUpdate
// er fikset til å sende hele dokumentet videre og kun fjerne en eksplisitt read-only-liste —
// alt annet (inkl. felt MCP-en ikke kjenner til) skal overleve uendret.
describe('sanitizeEtterlevelseDokumentasjonForUpdate', () => {
  function fullDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'doc-1',
      title: 'Mitt system',
      beskrivelse: 'En beskrivelse',
      version: 7,
      changeStamp: { lastModifiedBy: 'X', lastModifiedDate: '2026-01-01' },
      teamsData: [{ id: 'team-1', name: 'Team 1' }],
      resourcesData: [{ navIdent: 'A123456', fullName: 'Ola Nordmann' }],
      behandlinger: [{ id: 'b-1' }],
      dpBehandlinger: [{ id: 'dp-1' }],
      ardoqSystemData: [{ id: 'ardoq-1' }],
      hasCurrentUserAccess: true,
      hasCurrentUser: true,
      produktOmradetData: { id: 'po-1', name: 'Område' },
      // Felt MCP-toolen ikke kjenner til / ikke eksponerer i sitt skjema:
      risikoeiere: ['risikoeier@nav.no'],
      etterlevelseNummer: 42,
      status: 'UNDER_ARBEID',
      ...overrides,
    };
  }

  it('fjerner alle kjente read-only felt', () => {
    const cleaned = sanitizeEtterlevelseDokumentasjonForUpdate(fullDocument());

    for (const field of etterlevelseDokumentasjonReadOnlyFields) {
      expect(cleaned).not.toHaveProperty(field);
    }
  });

  it('bevarer risikoeiere og andre felt MCP-en ikke oppdaterer, uendret', () => {
    const cleaned = sanitizeEtterlevelseDokumentasjonForUpdate(fullDocument());

    expect(cleaned.risikoeiere).toEqual(['risikoeier@nav.no']);
    expect(cleaned.etterlevelseNummer).toBe(42);
    expect(cleaned.status).toBe('UNDER_ARBEID');
    expect(cleaned.title).toBe('Mitt system');
    expect(cleaned.beskrivelse).toBe('En beskrivelse');
  });

  it('normaliserer irrelevansFor fra objektform ({code}) til en ren strengliste', () => {
    const cleaned = sanitizeEtterlevelseDokumentasjonForUpdate(
      fullDocument({
        irrelevansFor: [
          { code: 'PERSONOPPLYSNINGER' },
          'INTERN_SKJERMFLATE',
          { code: null },
          {},
        ],
      }),
    );

    expect(cleaned.irrelevansFor).toEqual(['PERSONOPPLYSNINGER', 'INTERN_SKJERMFLATE']);
  });

  it('lar irrelevansFor stå urørt når feltet ikke er en liste', () => {
    const cleaned = sanitizeEtterlevelseDokumentasjonForUpdate(fullDocument({ irrelevansFor: undefined }));

    expect(cleaned.irrelevansFor).toBeUndefined();
  });

  it('kaster hvis dokumentet ikke kan leses som et objekt', () => {
    expect(() => sanitizeEtterlevelseDokumentasjonForUpdate(null)).toThrow();
    expect(() => sanitizeEtterlevelseDokumentasjonForUpdate('ikke et objekt')).toThrow();
    // isRecord i etterlevelse.ts ekskluderer eksplisitt arrays (typeof 'object' men Array.isArray true)
    expect(() => sanitizeEtterlevelseDokumentasjonForUpdate(['array'])).toThrow();
  });
});
