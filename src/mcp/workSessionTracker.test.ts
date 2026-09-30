import { beforeEach, describe, expect, it } from 'vitest';
import { userKeyFor, WorkSessionTracker, type WorkSessionSummary } from './workSessionTracker.js';

const minutt = 60 * 1000;

describe('WorkSessionTracker', () => {
  let klokke: number;
  let avsluttet: WorkSessionSummary[];
  let tracker: WorkSessionTracker;

  beforeEach(() => {
    klokke = 0;
    avsluttet = [];
    tracker = new WorkSessionTracker((s) => avsluttet.push(s), () => klokke, 60 * minutt);
  });

  it('teller ulike krav og SK-er, men alle skrivinger', () => {
    tracker.recordLock('u1', 'dok-a');
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 1);
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 2);
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 2); // revidert samme SK
    klokke = 10 * minutt;
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 200, 2, 1);
    tracker.recordKravStatusWrite('u1', 'dok-a', 300, 1);

    tracker.endAll('nedstenging');

    expect(avsluttet).toEqual([
      {
        endReason: 'nedstenging',
        kravCount: 3,
        suksesskriterieCount: 3,
        writeCount: 5,
        lockCount: 1,
        durationSeconds: 600,
      },
    ]);
  });

  it('fortsetter samme økt når samme dokument låses på nytt', () => {
    tracker.recordLock('u1', 'dok-a');
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 1);
    tracker.recordLock('u1', 'dok-a');
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 2);

    tracker.endAll('nedstenging');

    expect(avsluttet).toHaveLength(1);
    expect(avsluttet[0]).toMatchObject({ lockCount: 2, suksesskriterieCount: 2 });
  });

  it('avslutter økta når brukeren låser et annet dokument', () => {
    tracker.recordLock('u1', 'dok-a');
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 1);
    tracker.recordLock('u1', 'dok-b');

    expect(avsluttet).toEqual([expect.objectContaining({ endReason: 'dokumentbytte', kravCount: 1 })]);
    expect(tracker.activeCount).toBe(1);
  });

  it('lar andre brukeres økter på andre dokumenter være i fred ved dokumentbytte', () => {
    tracker.recordSuksesskriteriumWrite('u2', 'dok-a', 100, 1, 1);
    tracker.recordLock('u1', 'dok-b');

    expect(avsluttet).toEqual([]);
    expect(tracker.activeCount).toBe(2);
  });

  it('avslutter økter som har vært inaktive lenger enn grensen', () => {
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 1);
    klokke = 59 * minutt;
    tracker.endIdleSessions();
    expect(avsluttet).toEqual([]);

    klokke = 60 * minutt;
    tracker.endIdleSessions();
    expect(avsluttet).toEqual([expect.objectContaining({ endReason: 'inaktiv' })]);
  });

  it('holder økta i live på begin_sk_review-aktivitet uten skriving', () => {
    tracker.recordSuksesskriteriumWrite('u1', 'dok-a', 100, 1, 1);
    klokke = 50 * minutt;
    tracker.recordActivity('u1', 'dok-a');
    klokke = 100 * minutt;
    tracker.endIdleSessions();

    expect(avsluttet).toEqual([]);
  });

  it('rapporterer ikke økter uten skriving', () => {
    tracker.recordLock('u1', 'dok-a');
    tracker.recordActivity('u1', 'dok-a');

    tracker.endAll('nedstenging');

    expect(avsluttet).toEqual([]);
    expect(tracker.activeCount).toBe(0);
  });
});

describe('userKeyFor', () => {
  it('gir stabil nøkkel uten å eksponere e-postadressen', () => {
    const key = userKeyFor({ userEmail: 'ola.nordmann@nav.no' });

    expect(key).toBe(userKeyFor({ userEmail: 'ola.nordmann@nav.no' }));
    expect(key).not.toContain('ola');
    expect(key).not.toBe(userKeyFor({ userEmail: 'kari.nordmann@nav.no' }));
  });
});
