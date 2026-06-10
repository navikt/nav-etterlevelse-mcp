import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { EtterlevelseClient } from '../../api/etterlevelseClient.js';
import { authStore } from '../../auth/store.js';
import type { SessionContext } from '../server.js';

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

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function requireDocumentLock(ctx: SessionContext, targetDocumentId: string) {
  const { lockedDocumentId, lockedDocumentTitle } = ctx.tokenData;
  if (!lockedDocumentId) {
    return toolError(
      'Ingen dokumentlås aktiv. Kall lock_document(etterlevelseDokumentasjonId) først.',
    );
  }
  if (lockedDocumentId !== targetDocumentId) {
    return toolError(
      `Sesjonen er låst til "${lockedDocumentTitle ?? lockedDocumentId}". ` +
        `Kall lock_document på nytt hvis du vil bytte dokument.`,
    );
  }
  return null;
}

export function registerEtterlevelseTools(server: McpServer, ctx: SessionContext): void {
  const { etterlevelseClient: client } = ctx;
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

  // --- Sesjonslåsing ---

  server.registerTool(
    'lock_document',
    {
      description:
        'Lås sesjonen til en spesifikk etterlevelsesdokumentasjon for skriveoperasjoner. ' +
        'Verifiserer at du er medlem av teamet som eier dokumentet. ' +
        'Lese-tools er alltid frie og påvirkes ikke av låsen. ' +
        'Kall på nytt for å bytte til et annet dokument.',
      inputSchema: {
        etterlevelseDokumentasjonId: z
          .string()
          .min(1)
          .describe('UUID for etterlevelsesdokumentasjonen som skal låses'),
      },
      annotations: writeAnnotations,
    },
    async ({ etterlevelseDokumentasjonId }) => {
      try {
        const doc = await client.getEtterlevelseDokumentasjon(etterlevelseDokumentasjonId);

        if (!doc || typeof doc !== 'object') {
          return toolError(`Fant ikke etterlevelsesdokumentasjon med id ${etterlevelseDokumentasjonId}`);
        }

        const docRecord = doc as Record<string, unknown>;
        const title = typeof docRecord['title'] === 'string' ? docRecord['title'] : etterlevelseDokumentasjonId;
        const teams = Array.isArray(docRecord['teams'])
          ? (docRecord['teams'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];

        if (teams.length === 0) {
          return toolError(
            `Dokumentet "${title}" har ingen registrerte team. Kan ikke verifisere eierskap.`,
          );
        }

        // Sjekk om brukeren er medlem av noen av dokumentets team via Entra ID
        const { userGroups } = ctx.tokenData;
        const match = await ctx.graphClient.findMatchingTeam(teams, userGroups);

        if (!match) {
          return toolError(
            `Du er ikke medlem av noen av teamene som eier "${title}": ${teams.join(', ')}. ` +
              `Kun teammedlemmer kan låse sesjonen til dette dokumentet.`,
          );
        }

        const updated = authStore.updateMcpToken(ctx.mcpAccessToken, {
          lockedDocumentId: etterlevelseDokumentasjonId,
          lockedDocumentTitle: title,
        });

        if (!updated) {
          return toolError('Klarte ikke oppdatere sesjonen. Token kan ha utløpt.');
        }

        return toolResult({
          locked: true,
          documentId: etterlevelseDokumentasjonId,
          documentTitle: title,
          teamMatch: match.teamName,
          message: `Sesjonen er nå låst til "${title}". Skriveoperasjoner er begrenset til dette dokumentet.`,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // --- Write-tools (stub — aktiveres når ADR-002 er implementert i etterlevelse-backend) ---

  server.registerTool(
    'write_etterlevelse',
    {
      description:
        '[IKKE AKTIVERT] Skriv/oppdater en etterlevelsesbesvarelse for et krav. ' +
        'Krever at lock_document er kalt først. ' +
        'Aktiveres når etterlevelse-backend implementerer team-scope tilgangsstyring (ADR-002).',
      inputSchema: {
        etterlevelseDokumentasjonId: z.string().min(1).describe('UUID for dokumentasjonen — må matche låst dokument'),
        kravNummer: z.number().int().describe('Kravnummer'),
        kravVersjon: z.number().int().describe('Kravversjon'),
        status: z
          .enum(['UNDER_ARBEID', 'FERDIG', 'IKKE_RELEVANT', 'IKKE_RELEVANT_FERDIG'])
          .describe('Status for etterlevelsen'),
        statusBegrunnelse: z.string().optional().describe('Begrunnelse for status'),
        suksesskriterieBegrunnelser: z
          .array(
            z.object({
              suksesskriterieId: z.number().int(),
              begrunnelse: z.string(),
              suksesskriterieStatus: z.enum(['UNDER_ARBEID', 'OPPFYLT', 'IKKE_RELEVANT', 'IKKE_OPPFYLT']),
            }),
          )
          .optional()
          .describe('Begrunnelser per suksesskriterium'),
      },
      annotations: writeAnnotations,
    },
    async ({ etterlevelseDokumentasjonId }) => {
      const guardError = requireDocumentLock(ctx, etterlevelseDokumentasjonId);
      if (guardError) return guardError;

      return toolError(
        'write_etterlevelse er ikke aktivert enda. ' +
          'Venter på at etterlevelse-backend implementerer team-scope tilgangsstyring (ADR-002).',
      );
    },
  );

  server.registerTool(
    'write_pvk_risikoscenario',
    {
      description:
        '[IKKE AKTIVERT] Skriv/oppdater et PVK-risikoscenario. ' +
        'Krever at lock_document er kalt først. ' +
        'Aktiveres når etterlevelse-backend implementerer team-scope tilgangsstyring (ADR-002).',
      inputSchema: {
        etterlevelseDokumentasjonId: z.string().min(1).describe('UUID for dokumentasjonen — må matche låst dokument'),
        scenarioId: z.string().min(1).describe('UUID for risikoscenarioet'),
        beskrivelse: z.string().describe('Beskrivelse av risikoscenarioet'),
        tiltak: z.string().optional().describe('Tiltak for å redusere risikoen'),
      },
      annotations: writeAnnotations,
    },
    async ({ etterlevelseDokumentasjonId }) => {
      const guardError = requireDocumentLock(ctx, etterlevelseDokumentasjonId);
      if (guardError) return guardError;

      return toolError(
        'write_pvk_risikoscenario er ikke aktivert enda. ' +
          'Venter på at etterlevelse-backend implementerer team-scope tilgangsstyring (ADR-002).',
      );
    },
  );
}
