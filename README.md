# nav-etterlevelse-mcp

MCP-server (Model Context Protocol) som gir Copilot CLI strukturert og schema-validert
tilgang til [etterlevelse-api.intern.nav.no](https://etterlevelse-api.intern.nav.no) og
[behandlingskatalog.ansatt.nav.no](https://behandlingskatalog.ansatt.nav.no).

Autentisering skjer via Azure AD OAuth 2.1 (PKCE) — brukeren logger inn én gang i nettleseren,
og serveren holder tokenene i minne for sesjonen.

## Arkitektur

```
[Copilot CLI /mcp]
       ↓  MCP OAuth 2.1
[nav-etterlevelse-mcp  (NAIS, prod-gcp, namespace dab)]
       ↓  Azure AD OBO
[etterlevelse-api.intern.nav.no]   [behandlingskatalog.ansatt.nav.no]
```

## MCP-tools

### Etterlevelse — les

| Tool | Beskrivelse |
|------|-------------|
| `list_etterlevelse_dokumentasjoner` | Søk/list etterlevelsesdokumentasjoner |
| `get_etterlevelse_dokumentasjon` | Hent ett dokument med status |
| `list_krav` | List krav, filtrer på tema/status |
| `get_krav` | Hent ett krav med suksesskriterier |
| `get_etterlevelse` | Hent etterlevelse for et krav |
| `get_behandlingens_livsloep` | Hent behandlingens livsløp for låst dokument |
| `get_my_teams` | Hent team du er medlem av (bruk for å finne team-UUID) |
| `lock_document` | Lås et dokument for MCP-sesjonen (påkrevd før skriving) |

### Etterlevelse — skriv *(krever feature-toggle)*

| Tool | Beskrivelse |
|------|-------------|
| `create_etterlevelse_dokumentasjon` | Opprett nytt etterlevelsesdokument |
| `write_etterlevelse_dokumentasjon` | Oppdater dokumentegenskaper (tittel, teams, behandlinger, irrelevansFor …) |
| `write_etterlevelse` | Svar på ett krav (statusBegrunnelse, dokumentasjon) |
| `write_behandlingens_livsloep` | Opprett/oppdater behandlingens livsløp |
| `write_behandlingens_art_og_omfang` | Opprett/oppdater behandlingens art og omfang |

### PVK — les

| Tool | Beskrivelse |
|------|-------------|
| `get_pvk_dokument` | Hent PVK-dokument for låst dokument |
| `list_risikoscenarioer` | List risikoscenarioer for låst PVK-dokument |
| `list_tiltak` | List tiltak for låst PVK-dokument |

### PVK — skriv *(krever feature-toggle)*

| Tool | Beskrivelse |
|------|-------------|
| `write_pvk_involvering` | Oppdater involveringssteg i PVK |
| `write_pvk_egenskaper` | Oppdater egenskaper/risikovurdering i PVK |
| `write_risikoscenario` | Opprett/oppdater risikoscenario |
| `write_tiltak` | Opprett/oppdater tiltak |
| `link_krav_to_risikoscenario` | Koble krav til risikoscenario |

### Behandlingskatalog — les

| Tool | Beskrivelse |
|------|-------------|
| `search_behandlinger` | Søk behandlinger på navn eller B-nummer |
| `get_behandling` | Hent full behandlingsinfo (UUID eller B-nummer) |
| `get_processor` | Hent databehandler-info |

### Tilgangsbegrensninger

- **Teamtilgang**: Du kan kun opprette og oppdatere etterlevelsesdokumenter som eies av team du selv er medlem av. `get_my_teams` returnerer dine team med UUID-er.
- **Dokumentlås**: Alle skriveoperasjoner krever at dokumentet er låst med `lock_document` i gjeldende sesjon. Låsen gjelder kun i minnet — ny sesjon krever ny lås.
- **Feature-toggle**: Alle skriveoperasjoner styres av Unleash-toggle `nav-etterlevelse-mcp.write-enabled`. Toggle administreres i [dab-unleash-web.iap.nav.cloud.nais.io](https://dab-unleash-web.iap.nav.cloud.nais.io). Uten Unleash-konfigurasjon er skriving alltid tillatt (fallback).
- **Kravstatus**: `OPPFYLT` / `FERDIG` settes manuelt i [etterlevelse.ansatt.nav.no](https://etterlevelse.ansatt.nav.no) etter menneskelig gjennomgang.

Skriveflyten for kravdokumentasjon:

1. `lock_document` — lås dokumentet
2. `write_etterlevelse` — svar på krav (statusBegrunnelse, dokumentasjon, filer)
3. Sett status til `OPPFYLT` manuelt i nettleseren etter gjennomgang

## Oppsett

### 1. Autoriser repoet i NAIS Console
Gå til [console.nav.cloud.nais.io](https://console.nav.cloud.nais.io) → team **dab** → **Repositories** → legg til `navikt/nav-etterlevelse-mcp`.

### 2. Deploy

```bash
gh workflow run deploy.yaml
```

### 3. Be datajegerne legge til inbound-regler

I `etterlevelse-backend` (teamdatajegerne) og `behandlingskatalog-backend` (teamkatalog):

```yaml
accessPolicy:
  inbound:
    rules:
      - application: nav-etterlevelse-mcp
        namespace: dab
```

### 4. Bruk via Copilot CLI

```bash
gh copilot /mcp add https://nav-etterlevelse-mcp.intern.nav.no
```
