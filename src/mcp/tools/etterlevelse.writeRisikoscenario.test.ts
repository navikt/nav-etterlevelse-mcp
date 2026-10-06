import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Issue #46: write_risikoscenario tvang tidligere generelScenario til false i request, så en
// oppdatering som utelot feltet gjorde øvrige scenarioer stille om til kravkoblede. Feltet er nå
// betinget: oppdatering bevarer eksisterende verdi, create defaulter til false.
const isWriteEnabledMock = vi.fn();
vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => isWriteEnabledMock(),
}));

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
      if (!handler) throw new Error(`Tool "${name}" ble aldri registrert`);
      return handler(args);
    },
  };
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getRisikoscenario: vi.fn().mockResolvedValue({ id: 'rs-1', generelScenario: true, navn: 'Gammelt' }),
    updateRisikoscenario: vi.fn().mockResolvedValue({ id: 'rs-1' }),
    createRisikoscenario: vi.fn().mockResolvedValue({ id: 'rs-ny' }),
    ...overrides,
  };
}

function setup(client: unknown) {
  const ctx = {
    mcpAccessToken: 'token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: client as any,
    tokenData: { lockedDocumentId: 'doc-1', lockedPvkDokumentId: 'pvk-1' },
  } as unknown as SessionContext;
  const server = fakeServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  return server;
}

describe('write_risikoscenario — generelScenario', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('oppdatering som utelater generelScenario bevarer eksisterende verdi (true)', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_risikoscenario', {
      scenarioId: 'rs-1',
      navn: 'Oppdatert navn',
      beskrivelse: 'Oppdatert beskrivelse',
    });

    expect(client.updateRisikoscenario).toHaveBeenCalledTimes(1);
    const merged = client.updateRisikoscenario.mock.calls[0][1] as Record<string, unknown>;
    expect(merged.generelScenario).toBe(true);
  });

  it('oppdatering med eksplisitt generelScenario=false overstyrer eksisterende', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_risikoscenario', {
      scenarioId: 'rs-1',
      navn: 'Navn',
      beskrivelse: 'Beskrivelse',
      generelScenario: false,
    });

    const merged = client.updateRisikoscenario.mock.calls[0][1] as Record<string, unknown>;
    expect(merged.generelScenario).toBe(false);
  });

  it('oppretting uten generelScenario defaulter til false', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_risikoscenario', { navn: 'Nytt', beskrivelse: 'Beskrivelse' });

    expect(client.createRisikoscenario).toHaveBeenCalledTimes(1);
    const request = client.createRisikoscenario.mock.calls[0][0] as Record<string, unknown>;
    expect(request.generelScenario).toBe(false);
  });

  it('oppretting med generelScenario=true respekteres', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_risikoscenario', {
      navn: 'Øvrig',
      beskrivelse: 'Beskrivelse',
      generelScenario: true,
    });

    const request = client.createRisikoscenario.mock.calls[0][0] as Record<string, unknown>;
    expect(request.generelScenario).toBe(true);
  });
});
