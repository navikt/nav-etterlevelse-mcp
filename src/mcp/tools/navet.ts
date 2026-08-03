import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { NavetClient } from '../../api/navetClient.js';

const FAGOMRAADER = {
  'arbeidsrettet-brukeroppfolging': 'fag-og-ytelser-arbeid-arbeidsrettet-brukeroppfolging',
  'arbeidsavklaringspenger': 'fag-og-ytelser-arbeid-arbeidsavklaringspenger',
  'dagpenger': 'fag-og-ytelser-arbeid-dagpenger',
  'sykefravarsoppfolging-og-sykepenger': 'fag-og-ytelser-arbeid-sykefravarsoppfolging-og-sykepenger',
  'sosiale-tjenester': 'fag-og-ytelser-sosiale-tjenester',
  'tiltak-og-virkemidler': 'fag-og-ytelser-arbeid-tiltak-og-virkemidler',
  'pensjon-alderspensjon': 'fag-og-ytelser-pensjon-alderspensjon',
  'markedsarbeid': 'fag-og-ytelser-arbeid-markedsarbeid',
  'fag-og-ytelser': 'fag-og-ytelser',
  'stonadsokonomi': 'fag-og-ytelser-stonadsokonomi',
  'utbetalinger': 'fag-og-ytelser-utbetalinger',
  'intranett-utvikling': 'intranett-utvikling',
} as const;

type Fagomrade = keyof typeof FAGOMRAADER;

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Feil: ${message}` }],
    isError: true,
  };
}

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { data },
  };
}

export function registerNavetTools(server: McpServer, navetClient: NavetClient): void {
  server.registerTool(
    'list_navet_pages',
    {
      description:
        'List tilgjengelige sider på en Navet-site (NAVs interne SharePoint). ' +
        'Brukes for å finne relevante fagretningslinjer, personvernsider og lover/regler ' +
        'for et fagområde. Bruk get_navet_page for å hente innholdet i en bestemt side.',
      inputSchema: {
        fagomrade: z
          .enum(Object.keys(FAGOMRAADER) as [Fagomrade, ...Fagomrade[]])
          .describe('Fagområde å liste sider for'),
        filter: z
          .string()
          .optional()
          .describe('Filtrer på sidetittel, f.eks. "personvern" eller "rutiner"'),
      },
    },
    async ({ fagomrade, filter }) => {
      try {
        const sitePath = FAGOMRAADER[fagomrade];
        const siteId = await navetClient.getSiteId(sitePath);
        const pages = await navetClient.listPages(siteId, filter);
        return toolResult({
          fagomrade,
          siteUrl: `https://navno.sharepoint.com/sites/${sitePath}`,
          antallSider: pages.length,
          sider: pages.map((p) => ({
            id: p.id,
            tittel: p.title,
            url: p.webUrl,
            sistEndret: p.lastModified.slice(0, 10),
          })),
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    'get_navet_page',
    {
      description:
        'Hent tekstinnhold fra en bestemt Navet-side. ' +
        'Bruk list_navet_pages først for å finne side-ID. ' +
        'Innholdet brukes til domenekontekst i nav-context — ' +
        'særlig fagretningslinjer, personvernkrav og lovhenvisninger.',
      inputSchema: {
        fagomrade: z
          .enum(Object.keys(FAGOMRAADER) as [Fagomrade, ...Fagomrade[]])
          .describe('Fagområdet siden tilhører'),
        pageId: z.string().min(1).describe('Side-ID fra list_navet_pages'),
      },
    },
    async ({ fagomrade, pageId }) => {
      try {
        const sitePath = FAGOMRAADER[fagomrade];
        const siteId = await navetClient.getSiteId(sitePath);
        const { title, content, webUrl } = await navetClient.getPageContent(siteId, pageId);
        return toolResult({
          fagomrade,
          tittel: title,
          url: webUrl,
          innhold: content || '(ingen tekstinnhold funnet på siden)',
        });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
