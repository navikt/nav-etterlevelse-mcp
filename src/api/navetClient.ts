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

  /** Hent tekstinnhold fra en side via canvasLayout webParts */
  async getPageContent(siteId: string, pageId: string): Promise<{ title: string; content: string; webUrl: string }> {
    const url = `${GRAPH_BETA}/sites/${siteId}/pages/${pageId}/microsoft.graph.sitePage?$expand=canvasLayout`;
    const data = await this.get(url) as Record<string, unknown>;
    const title = typeof data['title'] === 'string' ? data['title'] : '';
    const webUrl = typeof data['webUrl'] === 'string' ? data['webUrl'] : '';
    const content = extractCanvasText(data['canvasLayout']);
    return { title, content, webUrl };
  }
}

/** Trekk ut ren tekst fra SharePoint canvasLayout (webParts) */
function extractCanvasText(layout: unknown): string {
  if (!layout || typeof layout !== 'object') return '';
  const sections = (layout as Record<string, unknown>)['horizontalSections'];
  if (!Array.isArray(sections)) return '';

  const parts: string[] = [];
  for (const section of sections) {
    const columns = (section as Record<string, unknown>)['columns'];
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      const webparts = (column as Record<string, unknown>)['webparts'];
      if (!Array.isArray(webparts)) continue;
      for (const wp of webparts) {
        const inner =
          (wp as Record<string, unknown>)['innerHtml'] ??
          ((wp as Record<string, unknown>)['data'] as Record<string, unknown> | undefined)?.['bodyHtml'] ?? '';
        if (typeof inner === 'string' && inner.trim()) {
          const text = inner
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '«')
            .replace(/&gt;/g, '»')
            .replace(/&quot;/g, '"')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (text) parts.push(text);
        }
      }
    }
  }
  return parts.join('\n\n');
}
