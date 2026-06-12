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

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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

const irrelevansForCodes = [
  'PERSONOPPLYSNINGER',
  'INTERN_SKJERMFLATE',
  'EKSTERN_SKJERMFLATE',
  'EGETUTVIKLETSYSTEM',
  'VEDTAKSBEHANDLING',
  'OKONOMISYSTEM',
] as const;

const etterlevelseDokumentasjonReadOnlyFields = [
  'changeStamp',
  'teamsData',
  'risikoeiereData',
  'behandlinger',
  'dpBehandlinger',
  'produktOmradetData',
  'resourcesData',
  'hasCurrentUserAccess',
  'versjonHistorikk',
  'stats',
  'sistEndretEtterlevelse',
  'sistEndretDokumentasjon',
  'sistEndretEtterlevelseAvMeg',
  'sistEndretDokumentasjonAvMeg',
  'hasCurrentUser',
  'irrepirsibleFields',
  'resources',
] as const;

const ytterligereEgenskaperCodes = [
  'SYSTEMATIC_PROFILING',
  'LARGE_SCALE_PROCESSING',
  'SYSTEMATIC_MONITORING',
  'SENSITIVE_DATA',
  'LARGE_SCALE_SENSITIVE_DATA',
  'AUTOMATED_DECISIONS',
  'VULNERABLE_GROUPS',
  'INNOVATIVE_TECHNOLOGY',
  'ACCESS_CONTROL_RESTRICTION',
] as const;

const ytterligereEgenskaperDescription =
  'Ytterligere DPIA-triggere. Gyldige koder: ' + ytterligereEgenskaperCodes.join(', ');

function requireDocumentLock(ctx: SessionContext, targetDocumentId?: string) {
  const { lockedDocumentId, lockedDocumentTitle } = ctx.tokenData;
  if (!lockedDocumentId) {
    return toolError(
      'Ingen dokumentlås aktiv. Kall lock_document(etterlevelseDokumentasjonId) først.',
    );
  }
  if (targetDocumentId && lockedDocumentId !== targetDocumentId) {
    return toolError(
      `Sesjonen er låst til "${lockedDocumentTitle ?? lockedDocumentId}". ` +
        'Kall lock_document på nytt hvis du vil bytte dokument.',
    );
  }
  return null;
}

function sanitizeEtterlevelseDokumentasjonForUpdate(document: unknown): Record<string, unknown> {
  if (!isRecord(document)) {
    throw new Error('Etterlevelsesdokumentasjonen kunne ikke leses som et objekt.');
  }

  const cleaned: Record<string, unknown> = { ...document };
  for (const field of etterlevelseDokumentasjonReadOnlyFields) {
    delete cleaned[field];
  }

  if (Array.isArray(cleaned.irrelevansFor)) {
    cleaned.irrelevansFor = cleaned.irrelevansFor
      .map((value) => {
        if (typeof value === 'string') {
          return value;
        }
        if (isRecord(value)) {
          return asString(value.code);
        }
        return undefined;
      })
      .filter((value): value is string => Boolean(value));
  }

  return cleaned;
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

function cleanText(value: unknown, fallback = ''): string {
  const text = asString(value);
  return text ? stripHtml(text).trim() : fallback;
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatScalar(value: unknown): string | undefined {
  if (typeof value === 'boolean') {
    return value ? 'Ja' : 'Nei';
  }

  const number = asNumber(value);
  if (number !== undefined) {
    return String(number);
  }

  const text = asString(value);
  if (!text) {
    return undefined;
  }

  const sanitized = stripHtml(text).trim();
  return sanitized || undefined;
}

function formatField(label: string, value: unknown): string | null {
  const formatted = formatScalar(value);
  return formatted ? `${label}: ${formatted}` : null;
}

function formatListField(label: string, values: Array<string | undefined> | undefined): string | null {
  const items = (values ?? [])
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return items.length > 0 ? `${label}: ${items.join(', ')}` : null;
}

function normalizeRisikoscenario(raw: unknown) {
  const scenario = isRecord(raw) ? raw : {};
  return {
    id: asString(scenario.id) ?? '',
    navn: cleanText(scenario.navn ?? scenario.name, 'Uten navn'),
    beskrivelse: cleanText(scenario.beskrivelse),
    sannsynlighetsNivaa: asNumber(scenario.sannsynlighetsNivaa),
    sannsynlighetsNivaaBegrunnelse: cleanText(scenario.sannsynlighetsNivaaBegrunnelse),
    konsekvensNivaa: asNumber(scenario.konsekvensNivaa),
    konsekvensNivaaBegrunnelse: cleanText(scenario.konsekvensNivaaBegrunnelse),
    sannsynlighetsNivaaEtterTiltak: asNumber(scenario.sannsynlighetsNivaaEtterTiltak),
    konsekvensNivaaEtterTiltak: asNumber(scenario.konsekvensNivaaEtterTiltak),
    nivaaBegrunnelseEtterTiltak: cleanText(scenario.nivaaBegrunnelseEtterTiltak),
    ingenTiltak: typeof scenario.ingenTiltak === 'boolean' ? scenario.ingenTiltak : undefined,
  };
}

function formatRisikoscenarioSection(raw: unknown, index?: number): string {
  const scenario = normalizeRisikoscenario(raw);
  const title =
    index !== undefined ? `RISIKOSCENARIO ${index}` : scenario.navn || 'RISIKOSCENARIO';
  const lines = [
    formatField('Id', scenario.id),
    formatField('Navn', scenario.navn),
    formatField('Beskrivelse', scenario.beskrivelse || '(tom)'),
    formatField('Sannsynlighet', scenario.sannsynlighetsNivaa),
    formatField('Begrunnelse sannsynlighet', scenario.sannsynlighetsNivaaBegrunnelse),
    formatField('Konsekvens', scenario.konsekvensNivaa),
    formatField('Begrunnelse konsekvens', scenario.konsekvensNivaaBegrunnelse),
    formatField('Sannsynlighet etter tiltak', scenario.sannsynlighetsNivaaEtterTiltak),
    formatField('Konsekvens etter tiltak', scenario.konsekvensNivaaEtterTiltak),
    formatField('Begrunnelse etter tiltak', scenario.nivaaBegrunnelseEtterTiltak),
    formatField('Ingen tiltak', scenario.ingenTiltak),
  ].filter((line): line is string => Boolean(line));

  return boxSection(title, lines.join('\n'));
}

function normalizeTiltak(raw: unknown) {
  const tiltak = isRecord(raw) ? raw : {};
  return {
    id: asString(tiltak.id) ?? '',
    risikoscenarioId: asString(tiltak.risikoscenarioId) ?? '',
    pvkDokumentId: asString(tiltak.pvkDokumentId) ?? '',
    navn: cleanText(tiltak.navn ?? tiltak.name, 'Uten navn'),
    beskrivelse: cleanText(tiltak.beskrivelse),
    ansvarlig: cleanText(tiltak.ansvarlig),
    frist: cleanText(tiltak.frist),
    iverksatt: typeof tiltak.iverksatt === 'boolean' ? tiltak.iverksatt : undefined,
  };
}

function formatTiltakSection(raw: unknown, index?: number): string {
  const tiltak = normalizeTiltak(raw);
  const title = index !== undefined ? `TILTAK ${index}` : 'TILTAK';
  const lines = [
    formatField('Id', tiltak.id),
    formatField('RisikoscenarioId', tiltak.risikoscenarioId),
    formatField('PVK-dokumentId', tiltak.pvkDokumentId),
    formatField('Navn', tiltak.navn),
    formatField('Beskrivelse', tiltak.beskrivelse || '(tom)'),
    formatField('Ansvarlig', tiltak.ansvarlig),
    formatField('Frist', tiltak.frist),
    formatField('Iverksatt', tiltak.iverksatt),
  ].filter((line): line is string => Boolean(line));

  return boxSection(title, lines.join('\n'));
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
        tagger: z
          .array(z.string())
          .optional()
          .describe('Filtrer på tagger, f.eks. ["Personvernkonsekvensvurdering"] for PVK-krav'),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ etterlevelseDokumentasjonId, relevansFor, tema, tagger }) => {
      try {
        return toolResult(
          await client.listKrav({ etterlevelseDokumentasjonId, relevansFor, tema, tagger }),
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

        const pvkDokument = await client.getPvkDokument(etterlevelseDokumentasjonId);
        const lockedPvkDokumentId =
          pvkDokument && isRecord(pvkDokument) && typeof pvkDokument.id === 'string'
            ? pvkDokument.id
            : undefined;

        const updated = authStore.updateMcpToken(ctx.mcpAccessToken, {
          lockedDocumentId: etterlevelseDokumentasjonId,
          lockedPvkDokumentId,
          lockedDocumentTitle: title,
        });

        if (!updated) {
          return toolError('Klarte ikke oppdatere sesjonen. Token kan ha utløpt.');
        }

        return toolResult({
          locked: true,
          documentId: etterlevelseDokumentasjonId,
          documentTitle: title,
          pvkDokumentId: lockedPvkDokumentId ?? null,
          teamMatch: match.teamName,
          message: `Sesjonen er nå låst til "${title}". Skriveoperasjoner er begrenset til dette dokumentet.`,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_pvk_dokument',
    {
      description:
        'Hent PVK-dokumentet knyttet til det låste etterlevelsesdokumentet. Returnerer pvkDokumentId, status og nøkkelfelter.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const lockedDocumentId = ctx.tokenData.lockedDocumentId as string;
      const lockedDocumentTitle = ctx.tokenData.lockedDocumentTitle ?? lockedDocumentId;

      try {
        const pvkDokument = await client.getPvkDokument(lockedDocumentId);
        if (!pvkDokument || !isRecord(pvkDokument)) {
          return toolResult({
            preview:
              `Ingen PVK-dokument funnet for "${lockedDocumentTitle}". ` +
              'Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
            found: false,
            etterlevelseDokumentasjonId: lockedDocumentId,
          });
        }

        const summaryLines = [
          formatField('Etterlevelsesdokument', lockedDocumentTitle),
          formatField('PVK-dokumentId', pvkDokument.id),
          formatField('Status', pvkDokument.status),
          formatField('BehandlingId', pvkDokument.behandlingId),
          formatField('PVO involvert', pvkDokument.pvoInvolveres),
          formatField('Har personopplysningsoversikt', pvkDokument.harPersonopplysningsoversikt),
          formatField('Sist endret', pvkDokument.sistEndret ?? pvkDokument.sistEndretDato),
        ].filter((line): line is string => Boolean(line));

        return toolResult({
          preview: boxSection('PVK-DOKUMENT', summaryLines.join('\n')),
          found: true,
          etterlevelseDokumentasjonId: lockedDocumentId,
          pvkDokumentId: asString(pvkDokument.id) ?? null,
          status: asString(pvkDokument.status) ?? null,
          pvkDokument,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_behandlingens_livsloep',
    {
      description: 'Hent behandlingens livsløp-dokument for det låste dokumentet.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const lockedDocumentId = ctx.tokenData.lockedDocumentId as string;
      const lockedDocumentTitle = ctx.tokenData.lockedDocumentTitle ?? lockedDocumentId;

      try {
        const behandlingensLivsloep = await client.getBehandlingensLivsloep(lockedDocumentId);
        if (!behandlingensLivsloep || !isRecord(behandlingensLivsloep)) {
          return toolResult({
            preview: `Ingen behandlingens livsløp funnet for "${lockedDocumentTitle}".`,
            found: false,
            etterlevelseDokumentasjonId: lockedDocumentId,
          });
        }

        const beskrivelse = cleanText(behandlingensLivsloep.beskrivelse, '(tom)');
        const filer = extractArray(
          behandlingensLivsloep.filer ??
            behandlingensLivsloep.files ??
            behandlingensLivsloep.vedlegg,
        );
        const summaryLines = [
          formatField('Etterlevelsesdokument', lockedDocumentTitle),
          formatField('Status', behandlingensLivsloep.status),
          `Beskrivelse: ${truncateText(beskrivelse || '(tom)', 200)}`,
          `Antall filer: ${filer.length}`,
        ].filter((line): line is string => Boolean(line));

        return toolResult({
          preview: boxSection('BEHANDLINGENS LIVSLØP', summaryLines.join('\n')),
          found: true,
          etterlevelseDokumentasjonId: lockedDocumentId,
          status: asString(behandlingensLivsloep.status) ?? null,
          fileCount: filer.length,
          behandlingensLivsloep,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_risikoscenarioer',
    {
      description: 'List alle risikoscenarioer for det låste PVK-dokumentet.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError(
          'Ingen PVK-dokument funnet for dette etterlevelsesdokumentet. Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
        );
      }

      try {
        const scenariosRaw = await client.getRisikoscenarioer(lockedPvkDokumentId);
        const scenarios = scenariosRaw.map((scenario) => normalizeRisikoscenario(scenario));
        const preview =
          scenarios.length > 0
            ? [
                `PVK-dokumentId: ${lockedPvkDokumentId}`,
                `Antall risikoscenarioer: ${scenarios.length}`,
                '',
                ...scenarios.map((scenario, index) => formatRisikoscenarioSection(scenario, index + 1)),
              ].join('\n\n')
            : `PVK-dokument ${lockedPvkDokumentId} har ingen risikoscenarioer enda.`;

        return toolResult({
          preview,
          pvkDokumentId: lockedPvkDokumentId,
          count: scenarios.length,
          scenarios,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_tiltak',
    {
      description: 'List alle tiltak for det låste PVK-dokumentet.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError('Ingen PVK-dokument funnet. Kall lock_document først.');
      }

      try {
        const tiltakRaw = await client.getTiltakForPvkDokument(lockedPvkDokumentId);
        const tiltak = tiltakRaw.map((item) => normalizeTiltak(item));
        const preview =
          tiltak.length > 0
            ? [
                `PVK-dokumentId: ${lockedPvkDokumentId}`,
                `Antall tiltak: ${tiltak.length}`,
                '',
                ...tiltak.map((item, index) => formatTiltakSection(item, index + 1)),
              ].join('\n\n')
            : `PVK-dokument ${lockedPvkDokumentId} har ingen tiltak enda.`;

        return toolResult({
          preview,
          pvkDokumentId: lockedPvkDokumentId,
          count: tiltak.length,
          tiltak,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  // --- Write-tools ---

  server.registerTool(
    'link_krav_to_risikoscenario',
    {
      description:
        'Koble et krav-nummer til ett eller flere risikoscenarioer i PVK-dokumentet. Gjør at scenariet vises under det relevante kravet i PVK-visningen.',
      inputSchema: {
        kravnummer: z
          .number()
          .int()
          .positive()
          .describe('Kravnummer (kun tall, ikke versjon), f.eks. 113'),
        risikoscenarioIder: z
          .array(z.string().uuid())
          .min(1)
          .describe('UUIDs for scenariene som skal knyttes til kravet'),
      },
      annotations: writeAnnotations,
    },
    async ({ kravnummer, risikoscenarioIder }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      if (!ctx.tokenData.lockedPvkDokumentId) {
        return toolError('Ingen PVK-dokument funnet. Kall lock_document først.');
      }

      try {
        const result = await client.linkKravToRisikoscenarioer(kravnummer, risikoscenarioIder);
        return toolResult({
          success: true,
          summary: `Krav K${kravnummer} koblet til ${risikoscenarioIder.length} risikoscenario(er)`,
          pvkDokumentId: ctx.tokenData.lockedPvkDokumentId,
          kravnummer,
          risikoscenarioIder,
          result,
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
    'write_etterlevelse_dokumentasjon',
    {
      description:
        'Oppdater agentrelevante felter på det låste etterlevelsesdokumentet med sikker partial update: GET, fjern read-only felt, merge oppgitte felter og send full PUT.',
      inputSchema: {
        beskrivelse: z
          .string()
          .optional()
          .describe(
            'Beskrivelse av etterlevelsesdokumentasjonen — kontekst, løsning og målgruppe. ' +
              'Hvis system-context.md finnes i repoet, bruk systembeskrivelsen derfra som utgangspunkt.',
          ),
        behandlingIds: z
          .array(z.string())
          .optional()
          .describe(
            'UUID-liste over behandlinger fra behandlingskatalogen som knyttes til dokumentet. ' +
              'Bruk search_behandlinger for å finne riktig UUID fra B-nummer eller navn.',
          ),
        dpBehandlingIds: z
          .array(z.string())
          .optional()
          .describe(
            'UUID-liste over databehandler-behandlinger fra behandlingskatalogen. ' +
              'Bruk search_behandlinger for å finne riktig UUID fra B-nummer eller navn.',
          ),
        irrelevansFor: z
          .array(z.enum(irrelevansForCodes))
          .optional()
          .describe(
            'Egenskaper som IKKE er relevante for dette systemet. ' +
              'PERSONOPPLYSNINGER: behandler ikke personopplysninger. ' +
              'INTERN_SKJERMFLATE: ingen intern brukerflate. ' +
              'EKSTERN_SKJERMFLATE: ingen ekstern brukerflate. ' +
              'EGETUTVIKLETSYSTEM: drifter ikke egetutviklet system. ' +
              'VEDTAKSBEHANDLING: systemet fatter ikke vedtak. ' +
              'OKONOMISYSTEM: ingen økonomi/utbetaling.',
          ),
        Risikovurderinger: z
          .array(z.string())
          .optional()
          .describe('Lenker og beskrivelser til risikovurderinger, formatert som markdown'),
        prioritertKravNummer: z
          .array(z.string())
          .optional()
          .describe(
            'Kravnumre (uten versjon) sortert etter prioritet, f.eks. ["253", "191", "230"]',
          ),
        teams: z
          .array(z.string())
          .optional()
          .describe('UUID-liste over team fra teamkatalogen som eier dokumentet'),
      },
      annotations: writeAnnotations,
    },
    async ({
      beskrivelse,
      behandlingIds,
      dpBehandlingIds,
      irrelevansFor,
      Risikovurderinger,
      prioritertKravNummer,
      teams,
    }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const lockedDocumentId = ctx.tokenData.lockedDocumentId as string;

      try {
        const current = await client.getEtterlevelseDokumentasjonRaw(lockedDocumentId);
        const cleaned = sanitizeEtterlevelseDokumentasjonForUpdate(current);

        if (beskrivelse !== undefined) cleaned.beskrivelse = beskrivelse;
        if (behandlingIds !== undefined) cleaned.behandlingIds = behandlingIds;
        if (dpBehandlingIds !== undefined) cleaned.dpBehandlingIds = dpBehandlingIds;
        if (irrelevansFor !== undefined) cleaned.irrelevansFor = irrelevansFor;
        if (Risikovurderinger !== undefined) cleaned.Risikovurderinger = Risikovurderinger;
        if (prioritertKravNummer !== undefined) cleaned.prioritertKravNummer = prioritertKravNummer;
        if (teams !== undefined) cleaned.teams = teams;

        const result = await client.updateEtterlevelseDokumentasjon(lockedDocumentId, cleaned);
        const saved = isRecord(result) ? result : {};
        const title = asString(saved.title) ?? ctx.tokenData.lockedDocumentTitle ?? '';
        const etterlevelseNummer = asString(saved.etterlevelseNummer) ?? '';

        const lines: string[] = [
          `✅ Etterlevelsesdokumentasjon oppdatert: ${title} (E${etterlevelseNummer})`,
          '',
        ];
        if (beskrivelse !== undefined) {
          lines.push(
            `Beskrivelse: ${beskrivelse.slice(0, 80)}${beskrivelse.length > 80 ? '…' : ''}`,
          );
        }
        if (behandlingIds !== undefined) {
          lines.push(`BehandlingIds: ${behandlingIds.join(', ')}`);
        }
        if (dpBehandlingIds !== undefined) {
          lines.push(`DpBehandlingIds: ${dpBehandlingIds.join(', ')}`);
        }
        if (irrelevansFor !== undefined) {
          lines.push(`IrrelevansFor: ${irrelevansFor.join(', ') || '(ingen)'}`);
        }
        if (Risikovurderinger !== undefined) {
          lines.push(`Risikovurderinger: ${Risikovurderinger.length} lenker`);
        }
        if (prioritertKravNummer !== undefined) {
          lines.push(`Prioritert kravliste: ${prioritertKravNummer.join(', ')}`);
        }
        if (teams !== undefined) {
          lines.push(`Teams: ${teams.join(', ')}`);
        }

        return toolResult({
          success: true,
          summary: lines.join('\n'),
          etterlevelseDokumentasjonId: lockedDocumentId,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_behandlingens_livsloep',
    {
      description:
        'Opprett eller oppdater behandlingens livsløp for det låste etterlevelsesdokumentet. ' +
        'Bruker multipart/form-data og kan sende vedlegg som base64.',
      inputSchema: {
        beskrivelse: z.string().describe('Beskrivelse av behandlingens livsløp (markdown)'),
        filer: z
          .array(
            z.object({
              navn: z.string().describe('Filnavn, f.eks. livsloep.png'),
              type: z
                .enum(['image/png', 'image/jpeg', 'application/pdf'])
                .describe('MIME-type'),
              innhold: z.string().describe('Base64-kodet filinnhold'),
            }),
          )
          .optional()
          .describe('Opptil 4 filer (PDF, PNG, JPG, maks 5 MB per fil). Erstatter eksisterende filer.'),
      },
      annotations: writeAnnotations,
    },
    async ({ beskrivelse, filer }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const lockedDocumentId = ctx.tokenData.lockedDocumentId as string;
      const lockedDocumentTitle = ctx.tokenData.lockedDocumentTitle ?? lockedDocumentId;

      try {
        const result = await client.upsertBehandlingensLivsloep(lockedDocumentId, beskrivelse, filer);
        const saved = isRecord(result) ? result : {};
        const previewLines = [
          formatField('Etterlevelsesdokument', lockedDocumentTitle),
          formatField('LivsløpId', saved.id),
          formatField('Beskrivelse', saved.beskrivelse ?? beskrivelse),
          formatField('Antall vedlegg sendt', filer?.length ?? 0),
          formatListField(
            'Vedlegg',
            filer?.map((fil) => fil.navn),
          ),
        ].filter((line): line is string => Boolean(line));
        const note =
          !filer || filer.length === 0
            ? 'Merk: Ved PUT uten nye filer kan backend kreve at eksisterende vedlegg lastes opp på nytt for å bevares.'
            : null;

        return toolResult({
          preview: [
            boxSection('BEHANDLINGENS LIVSLØP', previewLines.join('\n')),
            ...(note ? [boxSection('MERK', note)] : []),
          ].join('\n\n'),
          etterlevelseDokumentasjonId: lockedDocumentId,
          behandlingensLivsloep: saved,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_behandlingens_art_og_omfang',
    {
      description:
        'Opprett eller oppdater behandlingens art og omfang for det låste etterlevelsesdokumentet.',
      inputSchema: {
        stemmerPersonkategorier: z
          .boolean()
          .optional()
          .describe('Stemmer personkategoriene fra behandlingskatalogen?'),
        personkategoriAntallBeskrivelse: z
          .string()
          .optional()
          .describe('Beskrivelse av personkategorier og antall'),
        tilgangsBeskrivelsePersonopplysningene: z
          .string()
          .optional()
          .describe('Hvem har tilgang til personopplysningene?'),
        lagringsBeskrivelsePersonopplysningene: z
          .string()
          .optional()
          .describe('Hvor lagres og videresendes personopplysningene?'),
      },
      annotations: writeAnnotations,
    },
    async ({
      stemmerPersonkategorier,
      personkategoriAntallBeskrivelse,
      tilgangsBeskrivelsePersonopplysningene,
      lagringsBeskrivelsePersonopplysningene,
    }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const lockedDocumentId = ctx.tokenData.lockedDocumentId as string;
      const lockedDocumentTitle = ctx.tokenData.lockedDocumentTitle ?? lockedDocumentId;
      const request = {
        ...(stemmerPersonkategorier !== undefined ? { stemmerPersonkategorier } : {}),
        ...(personkategoriAntallBeskrivelse !== undefined ? { personkategoriAntallBeskrivelse } : {}),
        ...(tilgangsBeskrivelsePersonopplysningene !== undefined
          ? { tilgangsBeskrivelsePersonopplysningene }
          : {}),
        ...(lagringsBeskrivelsePersonopplysningene !== undefined
          ? { lagringsBeskrivelsePersonopplysningene }
          : {}),
      };

      try {
        const result = await client.upsertBehandlingensArtOgOmfang(lockedDocumentId, request);
        const saved = isRecord(result) ? { ...request, ...result } : request;
        const previewLines = [
          formatField('Etterlevelsesdokument', lockedDocumentTitle),
          formatField('Art og omfangId', isRecord(result) ? result.id : undefined),
          formatField('Stemmer personkategorier', saved.stemmerPersonkategorier),
          formatField(
            'Personkategorier og antall',
            saved.personkategoriAntallBeskrivelse,
          ),
          formatField(
            'Tilgang til personopplysningene',
            saved.tilgangsBeskrivelsePersonopplysningene,
          ),
          formatField(
            'Lagring og videresending',
            saved.lagringsBeskrivelsePersonopplysningene,
          ),
        ].filter((line): line is string => Boolean(line));

        return toolResult({
          preview: boxSection('BEHANDLINGENS ART OG OMFANG', previewLines.join('\n')),
          etterlevelseDokumentasjonId: lockedDocumentId,
          behandlingensArtOgOmfang: saved,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_pvk_involvering',
    {
      description:
        'Oppdater involveringsfelter på det låste PVK-dokumentet ved å hente eksisterende dokument og sende full PUT.',
      inputSchema: {
        harInvolvertRepresentant: z.boolean().optional(),
        representantInvolveringsBeskrivelse: z.string().optional(),
        harDatabehandlerRepresentantInvolvering: z.boolean().optional(),
        dataBehandlerRepresentantInvolveringBeskrivelse: z.string().optional(),
      },
      annotations: writeAnnotations,
    },
    async ({
      harInvolvertRepresentant,
      representantInvolveringsBeskrivelse,
      harDatabehandlerRepresentantInvolvering,
      dataBehandlerRepresentantInvolveringBeskrivelse,
    }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError(
          'Ingen PVK-dokument funnet for dette etterlevelsesdokumentet. Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
        );
      }

      const patch = {
        ...(harInvolvertRepresentant !== undefined ? { harInvolvertRepresentant } : {}),
        ...(representantInvolveringsBeskrivelse !== undefined
          ? { representantInvolveringsBeskrivelse }
          : {}),
        ...(harDatabehandlerRepresentantInvolvering !== undefined
          ? { harDatabehandlerRepresentantInvolvering }
          : {}),
        ...(dataBehandlerRepresentantInvolveringBeskrivelse !== undefined
          ? { dataBehandlerRepresentantInvolveringBeskrivelse }
          : {}),
      };

      if (Object.keys(patch).length === 0) {
        return toolError('Oppgi minst ett involveringsfelt som skal oppdateres.');
      }

      try {
        const result = await client.patchPvkDokument(lockedPvkDokumentId, patch);
        const saved = isRecord(result) ? result : patch;
        const previewLines = [
          formatField('PVK-dokumentId', lockedPvkDokumentId),
          formatField('Har involvert representant', saved.harInvolvertRepresentant),
          formatField(
            'Beskrivelse av representantinvolvering',
            saved.representantInvolveringsBeskrivelse,
          ),
          formatField(
            'Har databehandlerrepresentant-involvering',
            saved.harDatabehandlerRepresentantInvolvering,
          ),
          formatField(
            'Beskrivelse av databehandlerrepresentant-involvering',
            saved.dataBehandlerRepresentantInvolveringBeskrivelse,
          ),
        ].filter((line): line is string => Boolean(line));

        return toolResult({
          preview: boxSection('PVK INVOLVERING', previewLines.join('\n')),
          pvkDokumentId: lockedPvkDokumentId,
          pvkDokument: saved,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_pvk_egenskaper',
    {
      description:
        'Oppdater egenskaper på det låste PVK-dokumentet ved å hente eksisterende dokument og sende full PUT.',
      inputSchema: {
        dpProcessProfilering: z
          .boolean()
          .optional()
          .describe('Behandlingen innebærer profilering'),
        dpProcessHelautomatiskBehandling: z
          .boolean()
          .optional()
          .describe('Behandlingen er helautomatisert'),
        ytterligereEgenskaper: z
          .array(z.enum(ytterligereEgenskaperCodes))
          .optional()
          .describe(ytterligereEgenskaperDescription),
      },
      annotations: writeAnnotations,
    },
    async ({
      dpProcessProfilering,
      dpProcessHelautomatiskBehandling,
      ytterligereEgenskaper,
    }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError(
          'Ingen PVK-dokument funnet for dette etterlevelsesdokumentet. Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
        );
      }

      const patch = {
        ...(dpProcessProfilering !== undefined ? { dpProcessProfilering } : {}),
        ...(dpProcessHelautomatiskBehandling !== undefined
          ? { dpProcessHelautomatiskBehandling }
          : {}),
        ...(ytterligereEgenskaper !== undefined ? { ytterligereEgenskaper } : {}),
      };

      if (Object.keys(patch).length === 0) {
        return toolError('Oppgi minst ett egenskapsfelt som skal oppdateres.');
      }

      try {
        const result = await client.patchPvkDokument(lockedPvkDokumentId, patch);
        const saved = isRecord(result) ? result : patch;
        const previewLines = [
          formatField('PVK-dokumentId', lockedPvkDokumentId),
          formatField('Profilering', saved.dpProcessProfilering),
          formatField(
            'Helautomatisert behandling',
            saved.dpProcessHelautomatiskBehandling,
          ),
          formatListField(
            'Ytterligere egenskaper',
            Array.isArray(saved.ytterligereEgenskaper)
              ? saved.ytterligereEgenskaper.map((value) => asString(value))
              : undefined,
          ),
        ].filter((line): line is string => Boolean(line));

        return toolResult({
          preview: boxSection('PVK EGENSKAPER', previewLines.join('\n')),
          pvkDokumentId: lockedPvkDokumentId,
          pvkDokument: saved,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_risikoscenario',
    {
      description:
        'Opprett eller oppdater et risikoscenario i PVK-dokumentet. Krever aktiv sesjonslås (kall lock_document først).',
      inputSchema: {
        scenarioId: z.string().uuid().optional().describe('UUID for risikoscenarioet ved oppdatering'),
        navn: z.string().min(1).describe('Kort navn på risikoscenarioet'),
        beskrivelse: z.string().min(1).describe('Beskrivelse av risikoscenarioet'),
        sannsynlighetsNivaa: z.number().int().min(1).max(5).optional(),
        sannsynlighetsNivaaBegrunnelse: z.string().optional(),
        konsekvensNivaa: z.number().int().min(1).max(5).optional(),
        konsekvensNivaaBegrunnelse: z.string().optional(),
        sannsynlighetsNivaaEtterTiltak: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Sannsynlighetsnivå etter tiltak (1-5)'),
        konsekvensNivaaEtterTiltak: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Konsekvensnivå etter tiltak (1-5)'),
        nivaaBegrunnelseEtterTiltak: z
          .string()
          .optional()
          .describe('Begrunnelse for risikonivå etter tiltak'),
        ingenTiltak: z.boolean().optional(),
      },
      annotations: writeAnnotations,
    },
    async ({
      scenarioId,
      navn,
      beskrivelse,
      sannsynlighetsNivaa,
      sannsynlighetsNivaaBegrunnelse,
      konsekvensNivaa,
      konsekvensNivaaBegrunnelse,
      sannsynlighetsNivaaEtterTiltak,
      konsekvensNivaaEtterTiltak,
      nivaaBegrunnelseEtterTiltak,
      ingenTiltak,
    }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError(
          'Ingen PVK-dokument funnet for dette etterlevelsesdokumentet. Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
        );
      }

      const request = {
        pvkDokumentId: lockedPvkDokumentId,
        navn,
        beskrivelse,
        ...(sannsynlighetsNivaa !== undefined ? { sannsynlighetsNivaa } : {}),
        ...(sannsynlighetsNivaaBegrunnelse !== undefined
          ? { sannsynlighetsNivaaBegrunnelse }
          : {}),
        ...(konsekvensNivaa !== undefined ? { konsekvensNivaa } : {}),
        ...(konsekvensNivaaBegrunnelse !== undefined ? { konsekvensNivaaBegrunnelse } : {}),
        ...(sannsynlighetsNivaaEtterTiltak !== undefined
          ? { sannsynlighetsNivaaEtterTiltak }
          : {}),
        ...(konsekvensNivaaEtterTiltak !== undefined ? { konsekvensNivaaEtterTiltak } : {}),
        ...(nivaaBegrunnelseEtterTiltak !== undefined ? { nivaaBegrunnelseEtterTiltak } : {}),
        ...(ingenTiltak !== undefined ? { ingenTiltak } : {}),
      };

      try {
        const result = scenarioId
          ? await client.updateRisikoscenario(scenarioId, { id: scenarioId, ...request })
          : await client.createRisikoscenario(request);
        const scenario = normalizeRisikoscenario(
          isRecord(result) ? result : { id: scenarioId, ...request },
        );

        return toolResult({
          preview: formatRisikoscenarioSection(scenario),
          action: scenarioId ? 'updated' : 'created',
          pvkDokumentId: lockedPvkDokumentId,
          scenario,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'write_tiltak',
    {
      description:
        'Opprett eller oppdater et tiltak for et risikoscenario. Krever aktiv sesjonslås (kall lock_document først).',
      inputSchema: {
        risikoscenarioId: z.string().uuid().describe('UUID for risikoscenarioet tiltaket tilhører'),
        tiltakId: z.string().uuid().optional().describe('UUID for tiltaket ved oppdatering'),
        navn: z.string().min(1).describe('Kort navn på tiltaket'),
        beskrivelse: z.string().min(1).describe('Beskrivelse av tiltaket'),
        ansvarlig: z.string().optional().describe('NAVident for ansvarlig'),
        frist: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Frist på format YYYY-MM-DD'),
      },
      annotations: writeAnnotations,
    },
    async ({ risikoscenarioId, tiltakId, navn, beskrivelse, ansvarlig, frist }) => {
      const guardError = requireDocumentLock(ctx);
      if (guardError) {
        return guardError;
      }

      const { lockedPvkDokumentId } = ctx.tokenData;
      if (!lockedPvkDokumentId) {
        return toolError(
          'Ingen PVK-dokument funnet for dette etterlevelsesdokumentet. Opprett PVK-dokument i etterlevelse.ansatt.nav.no først.',
        );
      }

      const request = {
        pvkDokumentId: lockedPvkDokumentId,
        risikoscenarioId,
        navn,
        beskrivelse,
        ...(ansvarlig !== undefined ? { ansvarlig } : {}),
        ...(frist !== undefined ? { frist } : {}),
      };

      try {
        const result = tiltakId
          ? await client.updateTiltak(tiltakId, { id: tiltakId, ...request })
          : await client.createTiltak(risikoscenarioId, request);
        const tiltak = normalizeTiltak(isRecord(result) ? result : { id: tiltakId, ...request });

        return toolResult({
          preview: formatTiltakSection(tiltak),
          action: tiltakId ? 'updated' : 'created',
          pvkDokumentId: lockedPvkDokumentId,
          tiltak,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_my_teams',
    {
      description:
        'Hent team som den innloggede brukeren er medlem av (fra teamkatalogen via etterlevelse-backend). ' +
        'Bruk dette for å finne riktige team-UUIDer før oppretting av etterlevelsesdokumentasjon.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      try {
        const teams = await client.getMyTeams();
        if (teams.length === 0) {
          return toolResult({ teams: [], message: 'Ingen team funnet for innlogget bruker.' });
        }
        return toolResult({ teams });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'create_etterlevelse_dokumentasjon',
    {
      description:
        'Opprett ny etterlevelsesdokumentasjon. Bruk get_my_teams for å hente riktige team-UUIDer først. ' +
        'Etter oppretting: kall lock_document med den returnerte IDen for å låse sesjonen til det nye dokumentet.',
      inputSchema: {
        title: z.string().min(1).describe('Tittel på etterlevelsesdokumentasjonen'),
        beskrivelse: z
          .string()
          .describe(
            'Beskrivelse av systemet/løsningen — kontekst, målgruppe og formål. ' +
              'Hvis system-context.md finnes i repoet, bruk systembeskrivelsen derfra som utgangspunkt.',
          ),
        teams: z
          .array(z.string())
          .min(1)
          .describe('UUID-liste over team fra teamkatalogen som eier dokumentet (hentes via get_my_teams)'),
        behandlingIds: z
          .array(z.string())
          .optional()
          .describe(
            'UUID-liste over behandlinger fra behandlingskatalogen. ' +
              'Bruk search_behandlinger for å finne riktig UUID fra B-nummer eller navn.',
          ),
        behandlerPersonopplysninger: z
          .boolean()
          .describe('Angir om systemet behandler personopplysninger'),
        irrelevansFor: z
          .array(z.enum(irrelevansForCodes))
          .optional()
          .describe(
            'Egenskaper som IKKE er relevante for dette systemet. ' +
              'PERSONOPPLYSNINGER: behandler ikke personopplysninger. ' +
              'INTERN_SKJERMFLATE: ingen intern brukerflate. ' +
              'EKSTERN_SKJERMFLATE: ingen ekstern brukerflate. ' +
              'EGETUTVIKLETSYSTEM: drifter ikke egetutviklet system. ' +
              'VEDTAKSBEHANDLING: systemet fatter ikke vedtak. ' +
              'OKONOMISYSTEM: ingen økonomi/utbetaling.',
          ),
        prioritertKravNummer: z
          .array(z.string())
          .optional()
          .describe('Kravnumre (uten versjon) sortert etter prioritet'),
      },
      annotations: writeAnnotations,
    },
    async ({
      title,
      beskrivelse,
      teams,
      behandlingIds,
      behandlerPersonopplysninger,
      irrelevansFor,
      prioritertKravNummer,
    }) => {
      try {
        const body = {
          title,
          beskrivelse,
          teams,
          behandlingIds: behandlingIds ?? [],
          dpBehandlingIds: [],
          behandlerPersonopplysninger,
          irrelevansFor: irrelevansFor ?? [],
          prioritertKravNummer: prioritertKravNummer ?? [],
          etterlevelseNummer: 0,
          etterlevelseDokumentVersjon: 1,
          resources: [],
          risikoeiere: [],
          varslingsadresser: [],
          gjenbrukBeskrivelse: '',
          tilgjengeligForGjenbruk: false,
          forGjenbruk: false,
          knpivotenhetIds: [],
          knpivotenhetNavn: [],
          status: 'UNDER_ARBEID',
        };

        const result = await client.createEtterlevelseDokumentasjon(body);
        const saved = isRecord(result) ? result : {};
        const id = asString(saved.id) ?? '';
        const etterlevelseNummer = asString(saved.etterlevelseNummer) ?? '';

        return toolResult({
          success: true,
          summary:
            `✅ Etterlevelsesdokumentasjon opprettet: ${title} (E${etterlevelseNummer})\n` +
            `ID: ${id}\n` +
            `Kall lock_document("${id}") for å låse sesjonen til dette dokumentet.`,
          etterlevelseDokumentasjonId: id,
          etterlevelseNummer,
          result,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
