import { describe, expect, it } from 'vitest';
import { buildBatchWarning, consumePendingReviews, isHomogeneousIkkeRelevantBatch } from './etterlevelse.js';

// Disse funksjonene gir write_etterlevelse et in-band signal når en skriving
// inneholder flere suksesskriterie-begrunnelser enn det som faktisk er
// rapportert enkeltvis godkjent (log_review_event sk_reviewed/godkjent) siden
// forrige opplasting. Viktig: selve arraylengden alene er IKKE et batching-
// signal — steg 8 i gjennomgangsflyten laster opp *alle* individuelt godkjente
// SK-er for et krav i ett samlet kall, som er korrekt og forventet.
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
  it('returnerer null for ett enkelt SK, uansett rapportert antall', () => {
    expect(buildBatchWarning([{ suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'x' }], 0)).toBeNull();
  });

  it('returnerer null for det sanksjonerte IKKE_RELEVANT-unntaket, selv uten rapporterte godkjenninger', () => {
    const skbs = [
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Gjelder ikke' },
    ];
    expect(buildBatchWarning(skbs, 0)).toBeNull();
  });

  it('returnerer null når antall skrevne SK-er matcher antall rapporterte godkjenninger — normal, korrekt flyt', () => {
    // Dette er den vanlige, forventede flyten: alle SK-er for et krav er
    // gjennomgått individuelt (G/H/R) og deretter lastet opp samlet.
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'A' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'B' },
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'C' },
    ];
    expect(buildBatchWarning(skbs, 3)).toBeNull();
  });

  it('returnerer null når rapportert antall overstiger antall skrevne (f.eks. noen ble hoppet over)', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'A' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'B' },
    ];
    expect(buildBatchWarning(skbs, 5)).toBeNull();
  });

  it('returnerer en advarsel når skrevne SK-er overstiger rapporterte godkjenninger (K251-tilfellet)', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'Begrunnelse for SK0' },
      { suksesskriterieStatus: 'IKKE_RELEVANT', begrunnelse: 'Begrunnelse for SK1' },
    ];
    const warning = buildBatchWarning(skbs, 0);
    expect(warning).not.toBeNull();
    expect(warning).toContain('2 suksesskriterie-begrunnelser');
    expect(warning).toContain('kun 0');
    expect(warning).toContain('enkeltvis');
  });

  it('returnerer en advarsel når kun noen av flere SK-er er rapportert enkeltvis godkjent', () => {
    const skbs = [
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'A' },
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'B' },
      { suksesskriterieStatus: 'UNDER_ARBEID', begrunnelse: 'C' },
    ];
    const warning = buildBatchWarning(skbs, 1);
    expect(warning).toContain('3 suksesskriterie-begrunnelser');
    expect(warning).toContain('kun 1');
  });
});

describe('consumePendingReviews', () => {
  it('trekker fra antall skrevne SK-er fra antall pending', () => {
    expect(consumePendingReviews(3, 2)).toBe(1);
  });

  it('går aldri under 0 selv om flere skrives enn det som var pending', () => {
    expect(consumePendingReviews(1, 3)).toBe(0);
  });

  it('returnerer 0 uendret når ingenting var pending', () => {
    expect(consumePendingReviews(0, 1)).toBe(0);
  });
});
