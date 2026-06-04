import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { BehandlingskatalogClient } from '../../api/behandlingskatalogClient.js';

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

export function registerBehandlingskatalogTools(
  server: McpServer,
  client: BehandlingskatalogClient,
): void {
  server.registerTool(
    'search_behandlinger',
    {
      description: 'Søk etter behandlinger i behandlingskatalogen.',
      inputSchema: {
        search: z.string().min(1).describe('Søk på B-nummer eller navn'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ search }) => {
      try {
        return toolResult(await client.searchBehandlinger(search));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_behandling',
    {
      description: 'Hent en behandling med UUID eller B-nummer.',
      inputSchema: {
        id: z.string().min(1).describe('UUID eller B-nummer, for eksempel B123'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await client.getBehandling(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_processor',
    {
      description: 'Hent en databehandler på UUID.',
      inputSchema: {
        id: z.string().uuid().describe('UUID for processor/databehandler'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ id }) => {
      try {
        return toolResult(await client.getProcessor(id));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
