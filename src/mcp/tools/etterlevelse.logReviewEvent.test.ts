import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';
import { authStore } from '../../auth/store.js';

// Regresjonstest for feilen rapportert av bruker: skReviewedPending ble kun
// inkrementert for decision='godkjent', slik at et legitimt redigert/hoppet-over
// suksesskriterium ikke telte som "vurdert" — og utløste et falskt positivt
// batchWarning selv om gjennomgangsprosessen faktisk ble fulgt (se
// buildBatchWarning i etterlevelse.ts). Alle tre beslutningstypene (G/H/R) skal
// telle likt.
vi.mock('../../metrics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../metrics.js')>();
  return {
    ...actual,
    reviewWorkflowEventsTotal: { inc: vi.fn() },
  };
});

const { registerEtterlevelseTools } = await import('./etterlevelse.js');

function fakeServer() {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, _config: unknown, handler: any) => {
      handlers.set(name, handler);
    },
    invoke: (name: string, args: unknown) => {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`Tool "${name}" ble aldri registrert`);
      }
      return handler(args);
    },
  };
}

function ctxWithToken(accessToken: string): SessionContext {
  authStore.saveMcpSession(accessToken, `refresh-${accessToken}`, 'client-1', {
    userToken: 'user-token',
    refreshToken: null,
    azureExpiresAt: 0,
    userEmail: 'bruker@nav.no',
    userName: 'Bruker Brukersen',
    userGroups: [],
  });
  return {
    mcpAccessToken: accessToken,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: {} as any,
    tokenData: authStore.getMcpToken(accessToken)!,
  };
}

describe('log_review_event — skReviewedPending-telling', () => {
  let tokenCounter = 0;
  let accessToken: string;
  let server: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    tokenCounter += 1;
    accessToken = `access-token-log-review-event-${tokenCounter}`;
    const ctx = ctxWithToken(accessToken);
    server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
  });

  it('inkrementerer skReviewedPending for decision=godkjent', async () => {
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'godkjent' });
    expect(authStore.getMcpToken(accessToken)?.skReviewedPending).toBe(1);
  });

  it('inkrementerer skReviewedPending for decision=redigert', async () => {
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'redigert' });
    expect(authStore.getMcpToken(accessToken)?.skReviewedPending).toBe(1);
  });

  it('inkrementerer skReviewedPending for decision=hoppet_over', async () => {
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'hoppet_over' });
    expect(authStore.getMcpToken(accessToken)?.skReviewedPending).toBe(1);
  });

  it('teller alle tre beslutningstyper likt over flere kall', async () => {
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'godkjent' });
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'redigert' });
    await server.invoke('log_review_event', { event: 'sk_reviewed', decision: 'hoppet_over' });
    expect(authStore.getMcpToken(accessToken)?.skReviewedPending).toBe(3);
  });

  it('endrer ikke skReviewedPending for andre event-typer', async () => {
    await server.invoke('log_review_event', { event: 'report_generated' });
    expect(authStore.getMcpToken(accessToken)?.skReviewedPending).toBeUndefined();
  });
});
