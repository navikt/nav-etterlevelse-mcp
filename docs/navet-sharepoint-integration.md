# Planlagt: Navet (SharePoint) integrasjon

Navet er NAVs interne SharePoint-baserte intranett med fagområdespesifikke sider om
lover, retningslinjer og hva veiledere har lov/ikke lov til å registrere. Innholdet
er verdifullt som domenekontekst for nav-etterlevelse og nav-pvk, men kan per nå ikke
hentes automatisk.

**Status:** Avventer admin-consent for `Sites.Selected`-tilgang i Entra ID.

---

## Tilnærming

### Tilgangsstyring: `Sites.Selected` (ikke `Sites.Read.All`)

`Sites.Read.All` gir altfor vide tilganger — appen ville kunne lese alle SharePoint-sider
brukeren har tilgang til, inkludert HR-dokumenter, ledermøtereferater og sensitive
prosjektsider.

Riktig tilnærming er **`Sites.Selected`** (application permission), der en administrator
eksplisitt tildeler appen tilgang til nøyaktig de Navet-sitene som er relevante:

```http
POST https://graph.microsoft.com/v1.0/sites/{navet-site-id}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [{
    "application": {
      "id": "<nav-etterlevelse-mcp app-id i Entra ID>"
    }
  }]
}
```

Dette må gjøres én gang per Navet-site av en SharePoint-administrator, f.eks. via
PowerShell eller Microsoft Graph Explorer.

### Autentisering: application token (ikke OBO)

`Sites.Selected` fungerer med **application permissions**, ikke delegerte. Appen leser
Navet som en service identity — uavhengig av den innloggede brukerens SharePoint-tilgang.
Dette er passende siden Navet-innholdet er interne fagretningslinjer uten personrettet
tilgangsstyring.

Token hentes via **client credentials flow** (NAIS Texas `azure:application`):

```
[MCP-server] → Texas /api/m2m/token?target=https://graph.microsoft.com/.default
            → Graph API (Sites.Selected scope)
            → Kun konfigurerte Navet-siter
```

Texas-konfigurasjonen i `app.yaml` trenger ingen endringer — client credentials støttes
allerede via `/.well-known/nais-texas`-endepunktet.

---

## Implementasjonsplan

### Steg 1: Entra ID og SharePoint-konfigurasjon (admin-oppgave)

#### 1a: Legg til `Sites.Selected` i Azure-portalen

1. Gå til [portal.azure.com](https://portal.azure.com)
2. Søk på **«Microsoft Entra ID»** → **App registrations**
3. Søk etter **`nav-etterlevelse-mcp`**
4. Klikk appen → **API permissions** i venstremenyen
5. **Add a permission** → **Microsoft Graph** → **Application permissions**
6. Søk på `Sites.Selected`, huk av → **Add permissions**
7. Klikk **Grant admin consent for NAV** og bekreft

Client ID-en til appen finnes under appen → **Overview** → **Application (client) ID**.
Denne brukes i steg 1b.

#### 1b: Sjekk om Navet bruker hub sites eller subsite-arv

```http
GET https://graph.microsoft.com/v1.0/sites/navno.sharepoint.com:/sites/fag-og-ytelser
```

- Hvis `isHubSite: true` → separate site collections, tilgang må gis per site (mest sannsynlig)
- Hvis vanlig site med subsites → ett grant til rot-siten kan være tilstrekkelig

#### 1c: Gi appen lesetilgang til relevante Navet-siter

Dette gjøres mot SharePoint — enkleste vei er **Microsoft Graph Explorer**
([developer.microsoft.com/en-us/graph/graph-explorer](https://developer.microsoft.com/en-us/graph/graph-explorer)).

Finn site-ID for hver site:
```http
GET https://graph.microsoft.com/v1.0/sites/navno.sharepoint.com:/sites/{site-path}
```
Responsen inneholder `"id": "navno.sharepoint.com,{guid},{guid}"`.

Gi deretter appen lesetilgang:
```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [{
    "application": {
      "id": "<nav-etterlevelse-mcp client ID>",
      "displayName": "nav-etterlevelse-mcp"
    }
  }]
}
```

Alternativt via PowerShell (PnP-modul):
```powershell
Connect-PnPOnline -Url "https://navno.sharepoint.com" -Interactive
Grant-PnPAzureADAppSitePermission `
  -AppId "<nav-etterlevelse-mcp client ID>" `
  -DisplayName "nav-etterlevelse-mcp" `
  -Site "https://navno.sharepoint.com/sites/{site-path}" `
  -Permissions Read
```

Start med de fagområdene som er aktuelle — det er enkelt å legge til flere siter senere:

```powershell
# PowerShell (PnP-modul)
Connect-PnPOnline -Url "https://navno.sharepoint.com" -Interactive
Grant-PnPAzureADAppSitePermission `
  -AppId "<nav-etterlevelse-mcp app-id>" `
  -DisplayName "nav-etterlevelse-mcp" `
  -Site "https://navno.sharepoint.com/sites/fag-og-ytelser-arbeid-arbeidsrettet-brukeroppfolging" `
  -Permissions Read
```

Relevante Navet-siter å gi tilgang til:

| Fagområde | URL |
|-----------|-----|
| Arbeidsrettet oppfølging | `/sites/fag-og-ytelser-arbeid-arbeidsrettet-brukeroppfolging` |
| Arbeidsavklaringspenger (AAP) | `/sites/fag-og-ytelser-arbeid-arbeidsavklaringspenger` |
| Dagpenger | `/sites/fag-og-ytelser-arbeid-dagpenger` |
| Sykefraværsoppfølging og sykepenger | `/sites/fag-og-ytelser-arbeid-sykefravarsoppfolging-og-sykepenger` |
| Sosiale tjenester | `/sites/fag-og-ytelser-sosiale-tjenester` |
| Tiltak og virkemidler | `/sites/fag-og-ytelser-arbeid-tiltak-og-virkemidler` |
| Alderspensjon | `/sites/fag-og-ytelser-pensjon-alderspensjon` |
| Markedsarbeid | `/sites/fag-og-ytelser-arbeid-markedsarbeid` |

### Steg 2: NavetClient i kildekoden

Opprett `src/api/navetClient.ts` — utvider eksisterende `GraphClient`-mønster:

```typescript
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class NavetClient {
  constructor(private readonly appToken: string) {}

  /** Finn site-ID fra URL-segment, f.eks. "fag-og-ytelser-arbeid-..." */
  async getSiteId(siteRelativePath: string): Promise<string> {
    const url = `${GRAPH_BASE}/sites/navno.sharepoint.com:/sites/${siteRelativePath}`;
    const data = await this.get(url);
    return (data as any).id;
  }

  /** List sider på en Navet-site med tittel og sist endret */
  async listPages(siteId: string): Promise<NavetPage[]> {
    // Beta-endepunktet for SharePoint-sider gir strukturert innhold
    const url = `https://graph.microsoft.com/beta/sites/${siteId}/pages`;
    const data = await this.get(url) as any;
    return (data.value ?? []).map((p: any) => ({
      id: p.id,
      title: p.title,
      webUrl: p.webUrl,
      lastModified: p.lastModifiedDateTime,
    }));
  }

  /** Hent tekstinnhold fra en bestemt side */
  async getPageContent(siteId: string, pageId: string): Promise<string> {
    const url =
      `https://graph.microsoft.com/beta/sites/${siteId}/pages/${pageId}` +
      `/microsoft.graph.sitePage?$expand=canvasLayout`;
    const data = await this.get(url) as any;
    return extractTextFromCanvasLayout(data.canvasLayout);
  }

  private async get(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Graph svarte ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }
}

interface NavetPage {
  id: string;
  title: string;
  webUrl: string;
  lastModified: string;
}

/** Trekk ut ren tekst fra SharePoint canvasLayout (webParts) */
function extractTextFromCanvasLayout(layout: any): string {
  if (!layout) return '';
  const parts: string[] = [];
  for (const section of layout.horizontalSections ?? []) {
    for (const column of section.columns ?? []) {
      for (const webPart of column.webparts ?? []) {
        const inner = webPart.innerHtml ?? webPart.data?.bodyHtml ?? '';
        if (inner) {
          parts.push(inner.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim());
        }
      }
    }
  }
  return parts.join('\n\n');
}
```

### Steg 3: MCP-tools

Legg til to nye tools i `src/mcp/tools/etterlevelse.ts` (eller egen `navet.ts`):

**`list_navet_pages`**
```typescript
server.registerTool('list_navet_pages', {
  description:
    'List tilgjengelige sider på en Navet-site. Brukes for å finne relevante ' +
    'fagretningslinjer, personvernsider og lover/regler for et fagområde.',
  inputSchema: {
    fagomrade: z.enum([
      'arbeidsrettet-brukeroppfolging',
      'arbeidsavklaringspenger',
      'dagpenger',
      'sykefravarsoppfolging-og-sykepenger',
      'sosiale-tjenester',
      'tiltak-og-virkemidler',
      'pensjon-alderspensjon',
      'markedsarbeid',
    ]).describe('Fagområde å liste sider for'),
    filter: z.string().optional()
      .describe('Fritekstfilter på sidetittel, f.eks. "personvern" eller "rutiner"'),
  },
  ...
})
```

**`get_navet_page`**
```typescript
server.registerTool('get_navet_page', {
  description:
    'Hent tekstinnhold fra en bestemt Navet-side. Bruk list_navet_pages først ' +
    'for å finne side-ID. Innholdet brukes til domenekontekst i nav-context.',
  inputSchema: {
    fagomrade: z.enum([...]),
    pageId: z.string().describe('Side-ID fra list_navet_pages'),
  },
  ...
})
```

### Steg 4: Token-henting

I `src/index.ts` eller der Texas-klienten initialiseres — hent app-token for Graph
via client credentials (ikke OBO):

```typescript
// Texas client credentials endpoint
const response = await fetch(
  `${process.env.NAIS_TOKEN_ENDPOINT}?target=https://graph.microsoft.com/.default`,
  { method: 'GET', headers: { Authorization: `Bearer ${texasToken}` } }
);
const { access_token } = await response.json();
const navetClient = new NavetClient(access_token);
```

### Steg 5: Oppdater nav-context skill

Erstatt den manuelle «be bruker oppsummere»-instruksjonen i steg 4 med:
- `list_navet_pages` for å finne relevante sider
- `get_navet_page` for å hente innhold
- Automatisk kondensering til domenekontekst

---

## Avhengigheter og forutsetninger

| Forutsetning | Status | Ansvarlig |
|---|---|---|
| `Sites.Selected` innvilget i Entra ID | ⏳ Avventer | NAV IT / Entra-admin |
| Site-tilgang konfigurert for relevante Navet-siter | ⏳ Avventer admin-consent | NAV IT / SharePoint-admin |
| Texas støtter client credentials for Graph | ✅ Støttes allerede | NAIS |

---

## Referanser

- [Microsoft Graph: Sites.Selected permission](https://learn.microsoft.com/en-us/graph/permissions-reference#sitesselected)
- [SharePoint Pages API (beta)](https://learn.microsoft.com/en-us/graph/api/sitepage-list)
- [NAIS Texas dokumentasjon](https://docs.nais.io/auth/reference/#texas)
- [Grant site permissions via Graph](https://learn.microsoft.com/en-us/graph/api/site-post-permissions)
