import { beforeEach, describe, expect, it, vi } from 'vitest';

// recordReviewEvent er selvrapportert telemetri fra etterlevelse-/PVK-skillen —
// eneste signal vi kan få om hvorvidt den påkrevde interaktive gjennomgangsprosessen
// (rapport → godkjenning → ett SK om gangen → opplasting per krav) faktisk følges,
// siden MCP-serveren ellers bare ser tool-kall, ikke samtaleflyten rundt dem.
const incMock = vi.fn();
vi.mock('../../metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../metrics.js')>();
  return {
    ...actual,
    reviewWorkflowEventsTotal: { inc: (labels: unknown) => incMock(labels) },
  };
});

const { recordReviewEvent } = await import('./etterlevelse.js');

describe('recordReviewEvent', () => {
  beforeEach(() => {
    incMock.mockClear();
  });

  it('teller report_generated uten decision (defaulter til none)', () => {
    const result = recordReviewEvent('report_generated');

    expect(incMock).toHaveBeenCalledWith({ event: 'report_generated', decision: 'none' });
    expect(result).toEqual({ logged: true, event: 'report_generated', decision: null });
  });

  it('teller report_approved uten decision', () => {
    recordReviewEvent('report_approved');

    expect(incMock).toHaveBeenCalledWith({ event: 'report_approved', decision: 'none' });
  });

  it('teller sk_reviewed med decision=godkjent', () => {
    const result = recordReviewEvent('sk_reviewed', 'godkjent');

    expect(incMock).toHaveBeenCalledWith({ event: 'sk_reviewed', decision: 'godkjent' });
    expect(result).toEqual({ logged: true, event: 'sk_reviewed', decision: 'godkjent' });
  });

  it('teller sk_reviewed med decision=hoppet_over', () => {
    recordReviewEvent('sk_reviewed', 'hoppet_over');

    expect(incMock).toHaveBeenCalledWith({ event: 'sk_reviewed', decision: 'hoppet_over' });
  });

  it('teller sk_reviewed med decision=redigert', () => {
    recordReviewEvent('sk_reviewed', 'redigert');

    expect(incMock).toHaveBeenCalledWith({ event: 'sk_reviewed', decision: 'redigert' });
  });

  it('teller krav_uploaded uten decision', () => {
    recordReviewEvent('krav_uploaded');

    expect(incMock).toHaveBeenCalledWith({ event: 'krav_uploaded', decision: 'none' });
  });

  it('kaster og teller ikke hvis decision oppgis for en event-type som ikke er sk_reviewed', () => {
    expect(() => recordReviewEvent('report_generated', 'godkjent')).toThrow(
      /decision skal kun oppgis for event="sk_reviewed"/,
    );
    expect(() => recordReviewEvent('report_approved', 'hoppet_over')).toThrow();
    expect(() => recordReviewEvent('krav_uploaded', 'redigert')).toThrow();
    expect(incMock).not.toHaveBeenCalled();
  });

  it('kaster og teller ikke hvis sk_reviewed mangler decision', () => {
    expect(() => recordReviewEvent('sk_reviewed')).toThrow(/decision er påkrevd for event="sk_reviewed"/);
    expect(incMock).not.toHaveBeenCalled();
  });
});
