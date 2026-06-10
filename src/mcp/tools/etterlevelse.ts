import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { consumeConfirmation, storeConfirmation } from '../../api/confirmationStore.js';
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
  const content: Array<{ type: 'text'; text: string }> = [];
  if (isRecord(data) && typeof data.preview === 'string') {
    content.push({
      type: 'text',
      text: data.preview,
    });
  }

  content.push({
    type: 'text',
    text: JSON.stringify(data, null, 2),
  });

  return {
    content,
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
    'preview_etterlevelse_write',
    {
      description:
        'Forhåndsvis en etterlevelsesbesvarelse. Henter krav med suksesskriterier og kravets hensikt, ' +
        'og viser en formatert diff mot eksisterende begrunnelse. ' +
        'Returnerer et bekreftelsestoken (gyldig 15 min) og en formatert tekst som MÅ vises til brukeren. ' +
        'Be brukeren bekrefte (j/N) før write_etterlevelse kalles. ' +
        'Krever at lock_document er kalt først.',
      inputSchema: {
        etterlevelseDokumentasjonId: z
          .string()
          .min(1)
          .describe('UUID for dokumentasjonen — må matche låst dokument'),
        kravNummer: z.number().int().describe('Kravnummer'),
        kravVersjon: z.number().int().describe('Kravversjon'),
        status: z.enum(['UNDER_ARBEID', 'IKKE_RELEVANT']).describe('Ny status for etterlevelsen'),
        statusBegrunnelse: z.string().optional().describe('Begrunnelse for status'),
        suksesskriterieBegrunnelser: z
          .array(
            z.object({
              suksesskriterieId: z.number().int(),
              begrunnelse: z.string(),
              suksesskriterieStatus: z
                .enum(['UNDER_ARBEID', 'IKKE_RELEVANT', 'IKKE_OPPFYLT'])
                .describe('OPPFYLT settes i UI etter menneskelig gjennomgang'),
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
      if (guardError) {
        return guardError;
      }

      try {
        const [kravRaw, existingRaw, docRaw] = await Promise.all([
          client.getKrav(`K${kravNummer}.${kravVersjon}`),
          client.getEtterlevelse({ etterlevelseDokumentasjonId, kravNummer, kravVersjon }),
          client.getEtterlevelseDokumentasjon(etterlevelseDokumentasjonId),
        ]);

        const krav = isRecord(kravRaw) ? kravRaw : {};
        const kravNavn = typeof krav.navn === 'string' ? krav.navn : `K${kravNummer}.${kravVersjon}`;
        const hensikt = typeof krav.hensikt === 'string' ? stripHtml(krav.hensikt) : '';
        const beskrivelse = typeof krav.beskrivelse === 'string' ? stripHtml(krav.beskrivelse) : '';
        const suksesskriterier = Array.isArray(krav.suksesskriterier)
          ? (krav.suksesskriterier as Record<string, unknown>[])
          : [];

        const existingItems = extractArray<Record<string, unknown>>(existingRaw);
        const existing = existingItems[0] ?? {};
        const existingStatus = typeof existing.status === 'string' ? existing.status : '(ingen)';
        const existingSKBs = Array.isArray(existing.suksesskriterieBegrunnelser)
          ? (existing.suksesskriterieBegrunnelser as Record<string, unknown>[])
          : [];

        const doc = isRecord(docRaw) ? docRaw : {};
        const docTitle = typeof doc.title === 'string' ? doc.title : etterlevelseDokumentasjonId;
        const docNummer = typeof doc.etterlevelseNummer === 'string' ? ` (${doc.etterlevelseNummer})` : '';

        const width = 76;
        const lines: string[] = [];

        lines.push(`╔${'═'.repeat(width - 2)}╗`);
        const header = `  📝  FORHÅNDSVISNING — K${kravNummer}.${kravVersjon}`;
        lines.push(`║${header.padEnd(width - 2)}║`);
        lines.push(`╚${'═'.repeat(width - 2)}╝`);
        lines.push('');
        lines.push(`  Dokument : ${docTitle}${docNummer}`);
        lines.push(`  Krav     : K${kravNummer}.${kravVersjon} — ${kravNavn}`);
        lines.push(`  Status   : ${existingStatus} → ${status}`);

        if (hensikt) {
          lines.push('');
          lines.push(boxSection('KRAVETS HENSIKT', hensikt, width));
        }

        for (const [index, skb] of suksesskriterieBegrunnelser.entries()) {
          const kriteriumDef = suksesskriterier.find(
            (sk) => sk.id === skb.suksesskriterieId || sk.id === String(skb.suksesskriterieId),
          );
          const kriteriumTekst =
            kriteriumDef && typeof kriteriumDef.navn === 'string'
              ? stripHtml(kriteriumDef.navn)
              : `Suksesskriterium ${skb.suksesskriterieId}`;

          const existingSKB = existingSKBs.find(
            (entry) =>
              entry.suksesskriterieId === skb.suksesskriterieId ||
              entry.suksesskriterieId === String(skb.suksesskriterieId),
          );
          const oldBegrunnelse =
            existingSKB && typeof existingSKB.begrunnelse === 'string' && existingSKB.begrunnelse
              ? existingSKB.begrunnelse
              : '(tom)';
          const oldSKStatus =
            existingSKB && typeof existingSKB.suksesskriterieStatus === 'string'
              ? existingSKB.suksesskriterieStatus
              : '(ingen)';

          lines.push('');
          lines.push(
            boxSection(
              `SUKSESSKRITERIUM ${index + 1} av ${suksesskriterieBegrunnelser.length}`,
              kriteriumTekst,
              width,
            ),
          );
          lines.push('');
          lines.push(`  Status         : ${oldSKStatus} → ${skb.suksesskriterieStatus}`);
          lines.push(
            `  Begrunnelse nå : ${wordWrap(oldBegrunnelse, width - 18, ' '.repeat(19)).trimStart()}`,
          );
          lines.push(
            `  Begrunnelse ny : ${wordWrap(skb.begrunnelse, width - 18, ' '.repeat(19)).trimStart()}`,
          );
        }

        if (beskrivelse) {
          lines.push('');
          lines.push(boxSection('MER OM KRAVET', beskrivelse, width));
        }

        lines.push('');
        lines.push('  ⚠  OPPFYLT kan ikke settes via agenten.');
        lines.push('     Sett OPPFYLT/FERDIG i etterlevelse.ansatt.nav.no etter gjennomgang.');

        const previewText = lines.join('\n');
        const token = storeConfirmation({
          etterlevelseDokumentasjonId,
          kravNummer,
          kravVersjon,
          status,
          statusBegrunnelse,
          suksesskriterieBegrunnelser,
          previewText,
        });

        return toolResult({
          preview: previewText,
          confirmationToken: token,
          expiresInMinutes: 15,
          instruction: `Vis preview-teksten ovenfor til brukeren og be om bekreftelse (j/N). Kall write_etterlevelse(confirmationToken: "${token}") hvis brukeren bekrefter.`,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_etterlevelse',
    {
      description:
        'Skriv en etterlevelsesbesvarelse. Krever at preview_etterlevelse_write er kalt og at ' +
        'brukeren har bekreftet innholdet. Oppgi confirmationToken fra forhåndsvisningen. ' +
        'Tokenet er enkeltgangsbruk og utløper etter 15 minutter.',
      inputSchema: {
        confirmationToken: z.string().uuid().describe('Token fra preview_etterlevelse_write'),
      },
      annotations: writeAnnotations,
    },
    async ({ confirmationToken }) => {
      try {
        const pending = consumeConfirmation(confirmationToken);
        if (!pending) {
          return toolError(
            'Bekreftelsestoken er ugyldig eller utløpt. Kall preview_etterlevelse_write på nytt.',
          );
        }

        const guardError = requireDocumentLock(ctx, pending.etterlevelseDokumentasjonId);
        if (guardError) {
          return guardError;
        }

        const result = await client.upsertEtterlevelse({
          etterlevelseDokumentasjonId: pending.etterlevelseDokumentasjonId,
          kravNummer: pending.kravNummer,
          kravVersjon: pending.kravVersjon,
          status: pending.status,
          statusBegrunnelse: pending.statusBegrunnelse,
          suksesskriterieBegrunnelser: pending.suksesskriterieBegrunnelser,
        });

        return toolResult({
          success: true,
          message: `K${pending.kravNummer}.${pending.kravVersjon} er oppdatert. Husk å sette OPPFYLT/FERDIG manuelt i etterlevelse.ansatt.nav.no etter gjennomgang.`,
          result,
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
