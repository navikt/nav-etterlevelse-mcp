import { createHash } from 'node:crypto';
import { workSessionDurationSeconds, workSessionKrav, workSessionSuksesskriterier } from '../metrics.js';

/**
 * Arbeidsøkt = én bruker som jobber med ett etterlevelsesdokument, fram til hen bytter
 * dokument eller har vært inaktiv lenge. Pågående økter går tapt ved pod-omstart. Økta er bevisst ikke knyttet til
 * lock_document eller MCP-tokenet: låsen forsvinner ved ny innlogging, og agenten låser ofte
 * samme dokument på nytt. Nøkkelen er derfor hash(bruker) + dokument-ID.
 */
export type WorkSessionEndReason = 'inaktiv' | 'dokumentbytte';

export interface WorkSessionSummary {
  endReason: WorkSessionEndReason;
  kravCount: number;
  suksesskriterieCount: number;
  writeCount: number;
  lockCount: number;
  durationSeconds: number;
}

interface WorkSessionState {
  userKey: string;
  documentId: string;
  startedAt: number;
  lastActivityAt: number;
  krav: Set<string>;
  suksesskriterier: Set<string>;
  writeCount: number;
  lockCount: number;
}

// Lengre enn reviewToken-TTL (45 min), slik at lang tenketid på ett SK ikke deler økta.
export const workSessionIdleLimitMs = 60 * 60 * 1000;
const sweepIntervalMs = 5 * 60 * 1000;

export function userKeyFor(tokenData: { userEmail?: string; userName?: string }): string {
  const identity = tokenData.userEmail || tokenData.userName || 'ukjent';
  // Hash slik at brukeridentitet aldri kan havne i logg eller metrikk via nøkkelen.
  return createHash('sha256').update(identity).digest('base64url').slice(0, 22);
}

export class WorkSessionTracker {
  private readonly sessions = new Map<string, WorkSessionState>();

  constructor(
    private readonly onEnd: (summary: WorkSessionSummary) => void,
    private readonly now: () => number = Date.now,
    private readonly idleLimitMs: number = workSessionIdleLimitMs,
  ) {}

  /** lock_document: avslutter brukerens økter på andre dokumenter og teller låsingen. */
  recordLock(userKey: string, documentId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.userKey === userKey && session.documentId !== documentId) {
        this.end(key, session, 'dokumentbytte');
      }
    }
    this.touch(userKey, documentId).lockCount += 1;
  }

  /** begin_sk_review: holder økta i live også når brukeren hopper over SK-er. */
  recordActivity(userKey: string, documentId: string): void {
    this.touch(userKey, documentId);
  }

  /** Returnerer true hvis SK-et allerede var skrevet i samme økt (ny iterasjon). */
  recordSuksesskriteriumWrite(
    userKey: string,
    documentId: string,
    kravNummer: number,
    kravVersjon: number,
    suksesskriterieId: number,
  ): boolean {
    const session = this.touch(userKey, documentId);
    const krav = `K${kravNummer}.${kravVersjon}`;
    const skKey = `${krav}::${suksesskriterieId}`;
    const alreadyWritten = session.suksesskriterier.has(skKey);
    session.krav.add(krav);
    session.suksesskriterier.add(skKey);
    session.writeCount += 1;
    return alreadyWritten;
  }

  recordKravStatusWrite(userKey: string, documentId: string, kravNummer: number, kravVersjon: number): void {
    const session = this.touch(userKey, documentId);
    session.krav.add(`K${kravNummer}.${kravVersjon}`);
    session.writeCount += 1;
  }

  endIdleSessions(): void {
    const cutoff = this.now() - this.idleLimitMs;
    for (const [key, session] of this.sessions) {
      if (session.lastActivityAt <= cutoff) {
        this.end(key, session, 'inaktiv');
      }
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  private touch(userKey: string, documentId: string): WorkSessionState {
    const key = `${userKey}::${documentId}`;
    const now = this.now();
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        userKey,
        documentId,
        startedAt: now,
        lastActivityAt: now,
        krav: new Set(),
        suksesskriterier: new Set(),
        writeCount: 0,
        lockCount: 0,
      };
      this.sessions.set(key, session);
    }
    session.lastActivityAt = now;
    return session;
  }

  private end(key: string, session: WorkSessionState, endReason: WorkSessionEndReason): void {
    this.sessions.delete(key);
    // Økter uten skriving (kun lesing/låsing) sier ingenting om hvor mye man dokumenterer.
    if (session.writeCount === 0) return;
    this.onEnd({
      endReason,
      kravCount: session.krav.size,
      suksesskriterieCount: session.suksesskriterier.size,
      writeCount: session.writeCount,
      lockCount: session.lockCount,
      durationSeconds: Math.round((session.lastActivityAt - session.startedAt) / 1000),
    });
  }
}

function emitWorkSessionSummary(summary: WorkSessionSummary): void {
  const labels = { end_reason: summary.endReason };
  workSessionKrav.observe(labels, summary.kravCount);
  workSessionSuksesskriterier.observe(labels, summary.suksesskriterieCount);
  workSessionDurationSeconds.observe(labels, summary.durationSeconds);
}

export const workSessionTracker = new WorkSessionTracker(emitWorkSessionSummary);

const sweepHandle = setInterval(() => workSessionTracker.endIdleSessions(), sweepIntervalMs);
sweepHandle.unref?.();
