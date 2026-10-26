import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SessionContext } from './server.js';

// GHSA-46jr-4wx8-v453: grensen for antall elementer i argumentene håndheves av SDK-en, ikke av
// verktøyene våre. Testen går derfor gjennom en ekte MCP-klient og -server, ikke den falske
// serveren de andre testene bruker.
vi.mock('../unleash.js', () => ({
  isWriteEnabled: () => true,
}));

const { createMcpServer, MAX_TOOL_INPUT_ELEMENTS } = await import('./server.js');

async function connect(etterlevelseClient: Record<string, unknown>) {
  const ctx = {
    mcpAccessToken: 'token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: etterlevelseClient as any,
    tokenData: { lockedDocumentId: 'doc-1', lockedPvkDokumentId: 'pvk-1' },
  } as unknown as SessionContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = createMcpServer(ctx, {} as any, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('maxToolInputElements', () => {
  it('avviser et kall med flere elementer enn grensen uten å nå backend', async () => {
    const createTiltak = vi.fn();
    const client = await connect({ createTiltak });

    const result = await client.callTool({
      name: 'write_tiltak',
      arguments: {
        risikoscenarioIder: Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => uuid(i)),
        navn: 'Tiltak',
        beskrivelse: 'Beskrivelse',
      },
    });

    expect(result.isError).toBe(true);
    expect(createTiltak).not.toHaveBeenCalled();
  });

  it('slipper gjennom et vanlig kall under grensen', async () => {
    const createTiltak = vi.fn().mockResolvedValue({ id: 'ny-1' });
    const getTiltak = vi.fn().mockResolvedValue({ id: 'ny-1', navn: 'Tiltak', beskrivelse: 'Beskrivelse' });
    const client = await connect({ createTiltak, getTiltak, addTiltakToRisikoscenario: vi.fn() });

    const result = await client.callTool({
      name: 'write_tiltak',
      arguments: { risikoscenarioIder: [uuid(1)], navn: 'Tiltak', beskrivelse: 'Beskrivelse' },
    });

    expect(result.isError).toBeFalsy();
    expect(createTiltak).toHaveBeenCalledTimes(1);
  });
});
