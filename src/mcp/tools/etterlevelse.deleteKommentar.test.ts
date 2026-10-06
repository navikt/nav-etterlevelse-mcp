import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { SessionContext } from '../server.js';

// Regresjonstest for issue #42 (Copilot-review på #50): den påkrevde kommentar-parameteren
// på delete-toolsene må håndheves av input-skjemaet. Fake-serveren i de andre tool-testene
// kaller handleren direkte og hopper over SDK-skjemavalideringen, så denne testen validerer
// de registrerte zod-skjemaene direkte: alle fem delete-tools skal avvise manglende og tom
// kommentar, men godta en gyldig verdi.
vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => true,
}));

const { registerEtterlevelseTools } = await import('./etterlevelse.js');

function captureConfigs(): Map<string, { inputSchema: Record<string, z.ZodType> }> {
  const configs = new Map<string, { inputSchema: Record<string, z.ZodType> }>();
  const server = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, config: any) => {
      configs.set(name, config);
    },
  };
  const ctx = {
    mcpAccessToken: 'token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: {} as any,
    tokenData: { lockedDocumentId: 'doc-1' },
  } as unknown as SessionContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  return configs;
}

const uuid = '00000000-0000-4000-8000-000000000000';

// Øvrige påkrevde felter per delete-tool (uten kommentar), for å isolere kommentar-valideringen.
const baseArgs: Record<string, Record<string, unknown>> = {
  delete_krav_besvarelse: { etterlevelseId: uuid },
  delete_pvk_dokument: {},
  delete_behandlingens_livsloep: {},
  delete_risikoscenario: { scenarioId: uuid },
  delete_tiltak: { tiltakId: uuid },
};

describe('delete-tools håndhever påkrevd kommentar (schema-nivå)', () => {
  const configs = captureConfigs();

  for (const [tool, base] of Object.entries(baseArgs)) {
    it(`${tool} avviser manglende og tom kommentar, men godtar en gyldig`, () => {
      const config = configs.get(tool);
      expect(config, `${tool} ble ikke registrert`).toBeDefined();

      const schema = z.object(config!.inputSchema);

      expect(schema.safeParse({ ...base }).success).toBe(false);
      expect(schema.safeParse({ ...base, kommentar: '' }).success).toBe(false);
      expect(schema.safeParse({ ...base, kommentar: 'ryddejobb etter test' }).success).toBe(true);
    });
  }
});
