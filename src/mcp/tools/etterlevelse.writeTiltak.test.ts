import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { SessionContext } from '../server.js';

// Issues #44 og #45: write_tiltak kan nå koble et tiltak til flere risikoscenarioer (opprettes
// under det første, kobles til de øvrige; ved oppdatering synkroniseres koblingene), og kan sette
// iverksattDato/iverksettingsKommentar.
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
    createTiltak: vi.fn().mockResolvedValue({ id: 'ny-1' }),
    updateTiltak: vi.fn().mockResolvedValue({ id: 't-1' }),
    getTiltak: vi
      .fn()
      .mockResolvedValue({ id: 't-1', risikoscenarioIds: ['rs-1', 'rs-2'], navn: 'x', beskrivelse: 'y' }),
    addTiltakToRisikoscenario: vi.fn().mockResolvedValue({}),
    removeTiltakFromRisikoscenario: vi.fn().mockResolvedValue(undefined),
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

describe('write_tiltak — scenario-kobling og iverksetting', () => {
  beforeEach(() => {
    isWriteEnabledMock.mockReturnValue(true);
  });

  it('oppretter under det første scenarioet uten ekstra kobling når bare ett er oppgitt', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_tiltak', {
      risikoscenarioIder: ['rs-1'],
      navn: 'Tiltak',
      beskrivelse: 'Beskrivelse',
    });

    expect(client.createTiltak).toHaveBeenCalledWith(
      'rs-1',
      expect.objectContaining({ navn: 'Tiltak', beskrivelse: 'Beskrivelse', pvkDokumentId: 'pvk-1' }),
    );
    expect(client.addTiltakToRisikoscenario).not.toHaveBeenCalled();
  });

  it('oppretter under det første scenarioet og kobler til de øvrige', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_tiltak', {
      risikoscenarioIder: ['rs-1', 'rs-2', 'rs-3'],
      navn: 'Tiltak',
      beskrivelse: 'Beskrivelse',
    });

    expect(client.createTiltak).toHaveBeenCalledWith('rs-1', expect.any(Object));
    expect(client.addTiltakToRisikoscenario).toHaveBeenCalledWith('rs-2', ['ny-1']);
    expect(client.addTiltakToRisikoscenario).toHaveBeenCalledWith('rs-3', ['ny-1']);
    expect(client.addTiltakToRisikoscenario).toHaveBeenCalledTimes(2);
  });

  it('sender iverksattDato og iverksettingsKommentar i request', async () => {
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_tiltak', {
      risikoscenarioIder: ['rs-1'],
      navn: 'Tiltak',
      beskrivelse: 'Beskrivelse',
      iverksatt: true,
      iverksattDato: '2026-01-15',
      iverksettingsKommentar: 'Gjennomført i sprint 3',
    });

    expect(client.createTiltak).toHaveBeenCalledWith(
      'rs-1',
      expect.objectContaining({
        iverksatt: true,
        iverksattDato: '2026-01-15',
        iverksettingsKommentar: 'Gjennomført i sprint 3',
      }),
    );
  });

  it('synkroniserer scenario-koblingene ved oppdatering (legger til nye, fjerner fjernede)', async () => {
    // Eksisterende kobling: rs-1, rs-2. Ønsket: rs-2, rs-3 → legg til rs-3, fjern rs-1.
    const client = fakeClient();
    const server = setup(client);

    await server.invoke('write_tiltak', {
      tiltakId: 't-1',
      risikoscenarioIder: ['rs-2', 'rs-3'],
      navn: 'Oppdatert',
      beskrivelse: 'Oppdatert',
    });

    expect(client.updateTiltak).toHaveBeenCalledTimes(1);
    expect(client.addTiltakToRisikoscenario).toHaveBeenCalledWith('rs-3', ['t-1']);
    expect(client.addTiltakToRisikoscenario).toHaveBeenCalledTimes(1);
    expect(client.removeTiltakFromRisikoscenario).toHaveBeenCalledWith('rs-1', 't-1');
    expect(client.removeTiltakFromRisikoscenario).toHaveBeenCalledTimes(1);
  });
});

// Schema-nivåtest (Copilot-review på #54): handler-testene kaller handleren direkte med ikke-UUID-er,
// så zod-skjemaet kjøres aldri. Her valideres det registrerte skjemaet direkte, slik at den brytende
// kontrakten (risikoscenarioIder som påkrevd UUID-array) ikke kan regrese ubemerket.
describe('write_tiltak — skjema', () => {
  function captureConfig(): { inputSchema: Record<string, z.ZodType> } {
    let captured: { inputSchema: Record<string, z.ZodType> } | undefined;
    const server = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerTool: (name: string, config: any) => {
        if (name === 'write_tiltak') captured = config;
      },
    };
    const ctx = {
      mcpAccessToken: 'token',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      etterlevelseClient: {} as any,
      tokenData: { lockedDocumentId: 'doc-1', lockedPvkDokumentId: 'pvk-1' },
    } as unknown as SessionContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerEtterlevelseTools(server as any, ctx);
    if (!captured) throw new Error('write_tiltak ble ikke registrert');
    return captured;
  }

  const uuid = '00000000-0000-4000-8000-000000000001';

  it('godtar risikoscenarioIder som UUID-array, avviser entall/tom/ugyldig UUID', () => {
    const schema = z.object(captureConfig().inputSchema);
    const base = { navn: 'Tiltak', beskrivelse: 'Beskrivelse' };

    expect(schema.safeParse({ ...base, risikoscenarioIder: [uuid] }).success).toBe(true);
    // Gammelt entallsfelt (uten risikoscenarioIder) mangler påkrevd felt
    expect(schema.safeParse({ ...base, risikoscenarioId: uuid }).success).toBe(false);
    // Tom array bryter min(1)
    expect(schema.safeParse({ ...base, risikoscenarioIder: [] }).success).toBe(false);
    // Ugyldig UUID
    expect(schema.safeParse({ ...base, risikoscenarioIder: ['ikke-en-uuid'] }).success).toBe(false);
  });

  it('avviser ugyldig kalenderdato i iverksattDato', () => {
    const schema = z.object(captureConfig().inputSchema);
    const base = { navn: 'Tiltak', beskrivelse: 'Beskrivelse', risikoscenarioIder: [uuid] };

    expect(schema.safeParse({ ...base, iverksattDato: '2026-01-15' }).success).toBe(true);
    expect(schema.safeParse({ ...base, iverksattDato: '2026-99-99' }).success).toBe(false);
  });
});
