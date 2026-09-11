import { describe, expect, it } from 'vitest';
import { buildBatchWarning, isHomogeneousIkkeRelevantBatch } from './etterlevelse.js';

// Disse funksjonene gir write_etterlevelse et deterministisk, in-band signal når
// et kall inneholder flere suksesskriterie-begrunnelser i strid med kravet om
// enkeltvis presentasjon/godkjenning (G/H/R) i den interaktive gjennomgangen.
describe('isHomogeneousIkkeRelevantBatch', () => {
  it('returnerer false for ett enkelt SK (ikke en batch i det hele tatt)', () => {
    expect(isHomogeneousIkkeRelevantBatch([{ suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'x' }])).toBe(
      false,
    );
  });

  it('returnerer true når alle SK-er er IKKE_RELEVANT med identisk begrunnelse', () => {
    const skbs = [
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke dette systemet' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke dette systemet' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke dette systemet' },
    ];
    expect(isHomogeneousIkkeRelevantBatch(skbs)).toBe(true);
  });

  it('returnerer false hvis én SK har avvikende begrunnelse', () => {
    const skbs = [
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Samme tekst' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Annen tekst' },
    ];
    expect(isHomogeneousIkkeRelevantBatch(skbs)).toBe(false);
  });

  it('returnerer false hvis én SK har annen status enn IKKE_RELEVANT (blandet tilfelle)', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'Samme tekst' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Samme tekst' },
    ];
    expect(isHomogeneousIkkeRelevantBatch(skbs)).toBe(false);
  });
});

describe('buildBatchWarning', () => {
  it('returnerer null for ett enkelt SK', () => {
    expect(buildBatchWarning([{ suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'x' }])).toBeNull();
  });

  it('returnerer null for det sanksjonerte IKKE_RELEVANT-unntaket', () => {
    const skbs = [
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke' },
    ];
    expect(buildBatchWarning(skbs)).toBeNull();
  });

  it('returnerer en advarsel for flere SK-er med blandede statuser (K251-tilfellet)', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'Begrunnelse for SK0' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Begrunnelse for SK1' },
    ];
    const warning = buildBatchWarning(skbs);
    expect(warning).not.toBeNull();
    expect(warning).toContain('2 suksesskriterie-begrunnelser');
    expect(warning).toContain('enkeltvis');
  });

  it('returnerer en advarsel for flere SK-er som alle er UNDER_ARBEID', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'A' },
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'B' },
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'C' },
    ];
    expect(buildBatchWarning(skbs)).toContain('3 suksesskriterie-begrunnelser');
  });
});
