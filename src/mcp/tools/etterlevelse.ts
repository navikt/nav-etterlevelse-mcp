import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { authStore } from '../../auth/store.js';
import type { SessionContext } from '../server.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (!isRecord(payload)) {
    return [];
  }
  for (const key of ['content', 'items', 'data', 'results']) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate as T[];
    }
  }
  return [];
}

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
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
        'Kall lock_document på nytt hvis du vil bytte dokument.',
    );
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wordWrap(text: string, width: number, indent = ''): string {
  return text
    .split('\n')
    .flatMap((paragraph) => {
      if (paragraph.trim() === '') {
        return [''];
      }

      const words = paragraph.split(/\s+/);
      const lines: string[] = [];
      let current = indent;

      for (const word of words) {
        if (current.length + word.length + 1 > width && current.trim() !== '') {
          lines.push(current.trimEnd());
          current = indent + word;
        } else {
          current += (current === indent ? '' : ' ') + word;
        }
      }

      if (current.trim()) {
        lines.push(current.trimEnd());
      }

      return lines;
    })
    .join('\n');
}

function boxSection(title: string, content: string, width = 76): string {
  const bar = '─'.repeat(width - title.length - 4);
  const wrapped = wordWrap(content, width - 4, '  ');
  const lines = wrapped
    .split('\n')
    .map((line) => `│${line.padEnd(width - 2)}│`)
    .join('\n');
  return `┌─ ${title} ${bar}┐\n${lines}\n└${'─'.repeat(width - 2)}┘`;
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
      description:
        'Hent full etterlevelsedokumentasjon på id, inkludert alle nestede etterlevelser med suksesskriteriebegrunnelser.',
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
      description:
        'List krav. Hvis etterlevelseDokumentasjonId oppgis, returneres kun gjeldende krav for det dokumentet (anbefalt for gap-analyse). Uten id returneres alle aktive krav.',
      inputSchema: {
        etterlevelseDokumentasjonId: z
          .string()
          .optional()
          .describe('UUID for dokumentasjonen — gir kun gjeldende krav for dette dokumentet'),
        relevansFor: z.string().optional().describe('Filtrer på relevans-for feltet'),
        tema: z.string().optional().describe('Filtrer på tema'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ etterlevelseDokumentasjonId, relevansFor, tema }) => {
      try {
        return toolResult(
          await client.listKrav({ etterlevelseDokumentasjonId, relevansFor, tema }),
        );
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

        if (!isRecord(doc)) {
          return toolError(`Fant ikke etterlevelsesdokumentasjon med id ${etterlevelseDokumentasjonId}`);
        }

        const title = typeof doc.title === 'string' ? doc.title : etterlevelseDokumentasjonId;
        const teams = Array.isArray(doc.teams)
          ? doc.teams.filter((team): team is string => typeof team === 'string')
          : [];

        if (teams.length === 0) {
          return toolError(
            `Dokumentet "${title}" har ingen registrerte team. Kan ikke verifisere eierskap.`,
          );
        }

        const match = await ctx.graphClient.findMatchingTeam(teams, ctx.tokenData.userGroups);

        if (!match) {
          return toolError(
            `Du er ikke medlem av noen av teamene som eier "${title}": ${teams.join(', ')}. ` +
              'Kun teammedlemmer kan låse sesjonen til dette dokumentet.',
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

  // --- Write-tools ---

  server.registerTool(
    'write_etterlevelse',
    {
      description:
        'Skriv/oppdater en etterlevelsesbesvarelse for et krav. Krever aktiv sesjonslås (kall lock_document først). ' +
        'Henter kravets hensikt og eksisterende begrunnelse og returnerer dem i svaret for menneskelig gjennomgang. ' +
        'OPPFYLT og FERDIG/FERDIGSTILT kan ikke settes via agenten — sett disse manuelt i etterlevelse.ansatt.nav.no ' +
        'etter at du har lest suksesskriterieteksten og kravets hensikt.',
      inputSchema: {
        etterlevelseDokumentasjonId: z
          .string()
          .min(1)
          .describe('UUID for dokumentasjonen — må matche låst dokument'),
        kravNummer: z.number().int().describe('Kravnummer'),
        kravVersjon: z.number().int().describe('Kravversjon'),
        status: z
          .enum(['UNDER_ARBEID', 'IKKE_RELEVANT'])
          .describe('Status. FERDIG/FERDIGSTILT settes manuelt i UI etter gjennomgang.'),
        statusBegrunnelse: z.string().optional().describe('Begrunnelse for status'),
        suksesskriterieBegrunnelser: z
          .array(
            z.object({
              suksesskriterieId: z.number().int(),
              begrunnelse: z.string(),
              suksesskriterieStatus: z
                .enum(['UNDER_ARBEID', 'IKKE_RELEVANT', 'IKKE_OPPFYLT'])
                .describe('OPPFYLT settes manuelt i UI etter at suksesskriterieteksten er lest og vurdert.'),
            }),
          )
          .min(1)
          .describe('Begrunnelser per suksesskriterium'),
      },
      annotations: writeAnnotations,
    },
    async ({
      etterlevelseDokumentasjonId,
      kravNummer,
      kravVersjon,
      status,
      statusBegrunnelse,
      suksesskriterieBegrunnelser,
    }) => {
      const guardError = requireDocumentLock(ctx, etterlevelseDokumentasjonId);
      if (guardError) return guardError;

      try {
        const [kravRaw, existingRaw] = await Promise.all([
          client.getKrav(`K${kravNummer}.${kravVersjon}`),
          client.getEtterlevelse({ etterlevelseDokumentasjonId, kravNummer, kravVersjon }),
        ]);

        const writeResult = await client.upsertEtterlevelse({
          etterlevelseDokumentasjonId,
          kravNummer,
          kravVersjon,
          status,
          statusBegrunnelse,
          suksesskriterieBegrunnelser,
        });

        // Build summary with krav context for human review
        const krav = isRecord(kravRaw) ? kravRaw : {};
        const kravNavn = typeof krav.navn === 'string' ? krav.navn : `K${kravNummer}.${kravVersjon}`;
        const hensikt = typeof krav.hensikt === 'string' ? stripHtml(krav.hensikt) : '';
        const beskrivelse = typeof krav.beskrivelse === 'string' ? stripHtml(krav.beskrivelse) : '';
        const suksesskriterier = Array.isArray(krav.suksesskriterier)
          ? (krav.suksesskriterier as Record<string, unknown>[])
          : [];

        const existingItems = extractArray<Record<string, unknown>>(existingRaw);
        const existingSKBs = Array.isArray(existingItems[0]?.suksesskriterieBegrunnelser)
          ? (existingItems[0].suksesskriterieBegrunnelser as Record<string, unknown>[])
          : [];

        const W = 76;
        const lines: string[] = [];
        lines.push(`✅  K${kravNummer}.${kravVersjon} — ${kravNavn} er oppdatert`);
        lines.push(`    Status: ${status}`);

        if (hensikt) {
          lines.push('');
          lines.push(boxSection('KRAVETS HENSIKT', hensikt, W));
        }

        for (const [i, skb] of suksesskriterieBegrunnelser.entries()) {
          const def = suksesskriterier.find(
            (sk) => sk.id === skb.suksesskriterieId || sk.id === String(skb.suksesskriterieId),
          );
          const tekst =
            def && typeof def.navn === 'string'
              ? stripHtml(def.navn)
              : `Suksesskriterium ${skb.suksesskriterieId}`;
          const oldSKB = existingSKBs.find(
            (e) => e.suksesskriterieId === skb.suksesskriterieId,
          );
          const oldBegrunnelse =
            oldSKB && typeof oldSKB.begrunnelse === 'string' && oldSKB.begrunnelse
              ? oldSKB.begrunnelse
              : '(tom)';

          lines.push('');
          lines.push(boxSection(`SUKSESSKRITERIUM ${i + 1} av ${suksesskriterieBegrunnelser.length}`, tekst, W));
          lines.push(`  Var    : ${wordWrap(oldBegrunnelse, W - 11, ' '.repeat(11)).trimStart()}`);
          lines.push(`  Skrevet: ${wordWrap(skb.begrunnelse, W - 11, ' '.repeat(11)).trimStart()}`);
          lines.push(`  Status : ${skb.suksesskriterieStatus}`);
        }

        if (beskrivelse) {
          lines.push('');
          lines.push(boxSection('MER OM KRAVET', beskrivelse, W));
        }

        lines.push('');
        lines.push('⚠  OPPFYLT kan ikke settes via agenten.');
        lines.push('   Sett OPPFYLT/FERDIG i etterlevelse.ansatt.nav.no etter at du har');
        lines.push('   lest suksesskriterieteksten og kravets hensikt ovenfor.');

        return toolResult({
          success: true,
          summary: lines.join('\n'),
          result: writeResult,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_pvk_risikoscenario',
    {
      description:
        '[IKKE AKTIVERT] Skriv/oppdater et PVK-risikoscenario. ' +
        'Krever at lock_document er kalt først.',
      inputSchema: {
        etterlevelseDokumentasjonId: z
          .string()
          .min(1)
          .describe('UUID for dokumentasjonen — må matche låst dokument'),
        scenarioId: z.string().min(1).describe('UUID for risikoscenarioet'),
        beskrivelse: z.string().describe('Beskrivelse av risikoscenarioet'),
        tiltak: z.string().optional().describe('Tiltak for å redusere risikoen'),
      },
      annotations: writeAnnotations,
    },
    async ({ etterlevelseDokumentasjonId }) => {
      const guardError = requireDocumentLock(ctx, etterlevelseDokumentasjonId);
      if (guardError) {
        return guardError;
      }

      return toolError(
        'write_pvk_risikoscenario er ikke aktivert enda. ' +
          'PVK write-API er under kartlegging.',
      );
    },
  );
}
