import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { EtterlevelseClient } from '../../api/etterlevelseClient.js';

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { data },
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('MCP tool error', error);
  return {
    content: [{ type: 'text' as const, text: `Feil: ${message}` }],
    isError: true,
  };
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerEtterlevelseTools(server: McpServer, client: EtterlevelseClient): void {
  server.registerTool(
    'list_etterlevelse_dokumentasjoner',
    {
      description: 'List etterlevelsedokumentasjoner med enkel filtrering på søk og team.',
      inputSchema: {
        search: z.string().optional().describe('Filtrer på tittel eller etterlevelsenummer'),
        team: z.string().optional().describe('Filtrer på teamnavn'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ search, team }) => {
      try {
        return toolResult(await client.listEtterlevelseDokumentasjoner({ search, team }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_etterlevelse_dokumentasjon',
    {
      description: 'Hent full etterlevelsedokumentasjon på id, inkludert alle nestede etterlevelser med suksesskriteriebegrunnelser.',
      inputSchema: {
        id: z.string().min(1).describe('UUID for etterlevelsedokumentasjonen'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await client.getEtterlevelseDokumentasjon(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_krav',
    {
      description: 'List krav. Hvis etterlevelseDokumentasjonId oppgis, returneres kun gjeldende krav for det dokumentet (anbefalt for gap-analyse). Uten id returneres alle aktive krav.',
      inputSchema: {
        etterlevelseDokumentasjonId: z.string().optional().describe('UUID for dokumentasjonen — gir kun gjeldende krav for dette dokumentet'),
        relevansFor: z.string().optional().describe('Filtrer på relevans-for feltet'),
        tema: z.string().optional().describe('Filtrer på tema'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ etterlevelseDokumentasjonId, relevansFor, tema }) => {
      try {
        return toolResult(await client.listKrav({ etterlevelseDokumentasjonId, relevansFor, tema }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_krav',
    {
      description: 'Hent et krav enten med UUID eller formatet K123.1.',
      inputSchema: {
        id: z.string().min(1).describe('UUID eller krav-id på format K123.1'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await client.getKrav(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_etterlevelse',
    {
      description: 'Hent etterlevelse for en dokumentasjon og et spesifikt krav.',
      inputSchema: {
        etterlevelseDokumentasjonId: z.string().min(1).describe('UUID for dokumentasjonen'),
        kravNummer: z.number().int().describe('Kravnummer'),
        kravVersjon: z.number().int().describe('Kravversjon'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ etterlevelseDokumentasjonId, kravNummer, kravVersjon }) => {
      try {
        return toolResult(
          await client.getEtterlevelse({
            etterlevelseDokumentasjonId,
            kravNummer,
            kravVersjon,
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
