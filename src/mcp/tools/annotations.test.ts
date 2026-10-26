import { describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../server.js';

// Hvert verktøy skal oppgi readOnlyHint eksplisitt. Uten annotasjon skal en MCP-klient anta
// readOnlyHint: false, altså at verktøyet kan skrive. Testen fanget at Navet-verktøyene manglet
// annotasjoner.
vi.mock('../../unleash.js', () => ({
  isWriteEnabled: () => true,
}));

const { registerEtterlevelseTools } = await import('./etterlevelse.js');
const { registerBehandlingskatalogTools } = await import('./behandlingskatalog.js');
const { registerNavetTools } = await import('./navet.js');

type Annotations = { readOnlyHint?: unknown } | undefined;

function captureAnnotations(): Map<string, Annotations> {
  const annotations = new Map<string, Annotations>();
  const server = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (name: string, config: any) => {
      annotations.set(name, config?.annotations);
    },
  };
  const ctx = {
    mcpAccessToken: 'token',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    etterlevelseClient: {} as any,
    tokenData: {},
  } as unknown as SessionContext;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerEtterlevelseTools(server as any, ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerBehandlingskatalogTools(server as any, {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerNavetTools(server as any, {} as any);
  return annotations;
}

describe('verktøyannotasjoner', () => {
  const annotations = captureAnnotations();

  it('registrerer verktøy fra alle modulene', () => {
    expect(annotations.has('lock_document')).toBe(true);
    expect(annotations.has('search_behandlinger')).toBe(true);
    expect(annotations.has('list_navet_pages')).toBe(true);
  });

  it('alle verktøy oppgir readOnlyHint eksplisitt', () => {
    const mangler = [...annotations.entries()]
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(mangler).toEqual([]);
  });

  it('Navet-verktøyene er merket som lesing', () => {
    expect(annotations.get('list_navet_pages')?.readOnlyHint).toBe(true);
    expect(annotations.get('get_navet_page')?.readOnlyHint).toBe(true);
  });
});
