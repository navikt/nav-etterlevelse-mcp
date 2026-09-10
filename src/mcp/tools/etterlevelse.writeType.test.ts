import { describe, expect, it } from 'vitest';
import { determineWriteType } from './etterlevelse.js';

// Brukes til å skille førstegangsskriving fra revisjon på write_type-labelen i
// etterlevelse_writes_total — proxy for hvilke krav som tiltrekker mest iterasjon.
describe('determineWriteType', () => {
  it('returnerer "created" når suksesskriteriet ikke finnes i eksisterende besvarelse', () => {
    expect(determineWriteType([], 1)).toBe('created');
  });

  it('returnerer "created" når suksesskriteriet finnes, men uten tidligere begrunnelse', () => {
    const existing = [{ suksesskriterieId: 1, begrunnelse: '' }];
    expect(determineWriteType(existing, 1)).toBe('created');
  });

  it('returnerer "created" når begrunnelse er null', () => {
    const existing = [{ suksesskriterieId: 1, begrunnelse: null }];
    expect(determineWriteType(existing, 1)).toBe('created');
  });

  it('returnerer "revised" når suksesskriteriet har en ikke-tom eksisterende begrunnelse', () => {
    const existing = [{ suksesskriterieId: 1, begrunnelse: 'Tidligere tekst' }];
    expect(determineWriteType(existing, 1)).toBe('revised');
  });

  it('matcher riktig SK blant flere eksisterende', () => {
    const existing = [
      { suksesskriterieId: 1, begrunnelse: 'SK1 tekst' },
      { suksesskriterieId: 2, begrunnelse: '' },
    ];
    expect(determineWriteType(existing, 1)).toBe('revised');
    expect(determineWriteType(existing, 2)).toBe('created');
    expect(determineWriteType(existing, 3)).toBe('created');
  });

  it('matcher selv om suksesskriterieId har ulik type (string vs. number) mellom eksisterende og innsendt', () => {
    // getEtterlevelse returnerer rå backend-JSON (unknown), som andre steder i koden
    // (EtterlevelseClient, get_krav_for_gjennomgang) håndterer kan ha suksesskriterieId
    // som streng selv om write_etterlevelse-skjemaet krever number.
    const existingWithStringId = [{ suksesskriterieId: '1', begrunnelse: 'Tidligere tekst' }];
    expect(determineWriteType(existingWithStringId, 1)).toBe('revised');

    const existingWithNumberId = [{ suksesskriterieId: 1, begrunnelse: 'Tidligere tekst' }];
    expect(determineWriteType(existingWithNumberId, '1')).toBe('revised');
  });
});
