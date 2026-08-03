/**
 * NavetClient — leser fagområdespesifikke sider fra NAVs interne SharePoint (Navet)
 * via Microsoft Graph API med Sites.Selected application permission.
 *
 * Autentisering: application token (client credentials) via Texas M2M-endepunkt.
 * Tilgang er begrenset til eksplisitt konfigurerte Navet-siter — ikke hele SharePoint.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';
const NAVNO_HOST = 'navno.sharepoint.com';

export interface NavetPage {
  id: string;
  title: string;
  webUrl: string;
  lastModified: string;
}

export class NavetClient {
  constructor(private readonly appToken: string) {}

  private async get(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Microsoft Graph svarte ${response.status}: ${body}`);
    }
    return response.json();
  }

  /** Hent site-ID for en Navet-site gitt URL-segment, f.eks. "fag-og-ytelser-arbeid-arbeidsrettet-brukeroppfolging" */
  async getSiteId(siteRelativePath: string): Promise<string> {
    const url = `${GRAPH_BASE}/sites/${NAVNO_HOST}:/sites/${siteRelativePath}`;
    const data = await this.get(url) as Record<string, unknown>;
    const id = data['id'];
    if (typeof id !== 'string') {
      throw new Error(`Fant ikke site-ID for ${siteRelativePath}`);
    }
    return id;
  }

  /** List sider på en Navet-site — returnerer tittel, URL og sist endret */
  async listPages(siteId: string, filter?: string): Promise<NavetPage[]> {
    const url = `${GRAPH_BETA}/sites/${siteId}/pages?$select=id,title,webUrl,lastModifiedDateTime`;
    const data = await this.get(url) as Record<string, unknown>;
    const pages: NavetPage[] = [];
    if (Array.isArray(data['value'])) {
      for (const p of data['value'] as Record<string, unknown>[]) {
        const title = typeof p['title'] === 'string' ? p['title'] : '';
        if (filter && !title.toLowerCase().includes(filter.toLowerCase())) continue;
        pages.push({
          id: typeof p['id'] === 'string' ? p['id'] : '',
          title,
          webUrl: typeof p['webUrl'] === 'string' ? p['webUrl'] : '',
          lastModified: typeof p['lastModifiedDateTime'] === 'string' ? p['lastModifiedDateTime'] : '',
        });
      }
    }
    return pages;
  }

  /**
   * Hent tekstinnhold fra en side.
   *
   * Strategi (fallback-kjede):
   * 1. /webParts — henter alle webparts inkl. verticalSection, støtter
   *    textWebPart.innerHtml og standardWebPart.data.serverProcessedContent.searchablePlainTexts
   * 2. listItem CanvasContent1 — råinnhold via Graph listItem hvis /webParts er tom
   *
   * Tidligere brukte vi ?$expand=canvasLayout som bare dekket horizontalSections
   * og gikk glipp av verticalSection og standardWebPart-tekst.
   */
  async getPageContent(siteId: string, pageId: string): Promise<{ title: string; content: string; webUrl: string }> {
    // Hent metadata (tittel, URL, listItem-referanse)
    const meta = await this.get(
      `${GRAPH_BETA}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage`,
    ) as Record<string, unknown>;
    const title = typeof meta['title'] === 'string' ? meta['title'] : '';
    const webUrl = typeof meta['webUrl'] === 'string' ? meta['webUrl'] : '';

    // Strategi 1: /webParts — dekker alle seksjoner og webpart-typer
    let content = '';
    try {
      const wpData = await this.get(
        `${GRAPH_BETA}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage/webParts`,
      ) as Record<string, unknown>;
      if (Array.isArray(wpData['value'])) {
        content = extractTextFromWebparts(wpData['value'] as Record<string, unknown>[]);
      }
    } catch {
      // Fortsett til neste strategi
    }

    // Strategi 2: listItem CanvasContent1 via Graph (ingen separat token nødvendig)
    if (!content) {
      try {
        const sharepointIds = meta['sharepointIds'] as Record<string, unknown> | undefined;
        const listId = sharepointIds?.['listId'];
        const listItemId = sharepointIds?.['listItemId'];
        if (typeof listId === 'string' && typeof listItemId === 'string') {
          const itemData = await this.get(
            `${GRAPH_BASE}/sites/${siteId}/lists/${listId}/items/${listItemId}?$expand=fields($select=CanvasContent1)`,
          ) as Record<string, unknown>;
          const fields = itemData['fields'] as Record<string, unknown> | undefined;
          const canvasContent = fields?.['CanvasContent1'];
          if (typeof canvasContent === 'string' && canvasContent.trim()) {
            content = extractTextFromCanvasContent1(canvasContent);
          }
        }
      } catch {
        // Ingen innhold tilgjengelig
      }
    }

    return { title, content: content || '(ingen tekstinnhold funnet)', webUrl };
  }
}

/** Ekstraher tekst fra /webParts-responsen.
 *  Håndterer textWebPart (innerHtml) og standardWebPart (searchablePlainTexts). */
function extractTextFromWebparts(webparts: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const wp of webparts) {
    // textWebPart
    const inner = wp['innerHtml'];
    if (typeof inner === 'string' && inner.trim()) {
      const text = htmlToText(inner);
      if (text) parts.push(text);
      continue;
    }
    // standardWebPart: serverProcessedContent.searchablePlainTexts
    const data = wp['data'] as Record<string, unknown> | undefined;
    const spc = data?.['serverProcessedContent'] as Record<string, unknown> | undefined;
    const plainTexts = spc?.['searchablePlainTexts'];
    if (Array.isArray(plainTexts)) {
      for (const pt of plainTexts as Record<string, unknown>[]) {
        const val = pt['value'];
        if (typeof val === 'string' && val.trim()) parts.push(val.trim());
      }
    }
    // standardWebPart: searchablePlainTexts som flat array av strenger
    const texts = data?.['searchablePlainTexts'];
    if (Array.isArray(texts)) {
      for (const t of texts) {
        if (typeof t === 'string' && t.trim()) parts.push(t.trim());
      }
    }
  }
  return parts.join('\n\n');
}

/** Ekstraher tekst fra rå CanvasContent1 JSON-streng (SharePoint intern format). */
function extractTextFromCanvasContent1(canvasContent: string): string {
  const parts: string[] = [];
  try {
    const items = JSON.parse(canvasContent);
    if (!Array.isArray(items)) return '';
    for (const item of items) {
      // innerHtml på webpart-nivå
      if (typeof item.innerHTML === 'string' && item.innerHTML.trim()) {
        parts.push(htmlToText(item.innerHTML));
      }
      // Nøstede webparts
      if (Array.isArray(item.webparts)) {
        for (const wp of item.webparts) {
          if (typeof wp.innerHTML === 'string' && wp.innerHTML.trim()) {
            parts.push(htmlToText(wp.innerHTML));
          }
          if (typeof wp.innerHtml === 'string' && wp.innerHtml.trim()) {
            parts.push(htmlToText(wp.innerHtml));
          }
        }
      }
    }
  } catch {
    // Ikke parsbart JSON — returner tom
  }
  return parts.join('\n\n');
}

/**
 * Konverter HTML til ren tekst ved å splitte på '<'.
 * Garanterer at ingen '<'-tegn overlever til output (CodeQL CWE-116).
 */
function htmlToText(html: string): string {
  const chunks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n')
    .split('<');
  const textChunks: string[] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const closeIdx = chunks[i].indexOf('>');
    if (closeIdx >= 0) {
      textChunks.push(chunks[i].slice(closeIdx + 1));
    }
  }
  return textChunks
    .join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '')
    .replace(/&gt;/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
