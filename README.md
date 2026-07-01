# nav-etterlevelse-mcp

MCP-server (Model Context Protocol) som gir AI-agenter (GitHub Copilot CLI, OpenCode) strukturert og
schema-validert tilgang til NAVs etterlevelsesløsning og behandlingskatalog.

Autentisering skjer via Azure AD OAuth 2.1 PKCE — brukeren logger inn én gang i nettleseren,
og serveren holder brukerens sesjon i minnet.

## Arkitektur

```
[Copilot CLI / OpenCode]
        ↓  MCP OAuth 2.1 (PKCE)
[nav-etterlevelse-mcp  (NAIS, prod-gcp / dev-gcp, namespace dab)]
        ↓  Texas OBO (on-behalf-of) via NAIS-sidecar
[etterlevelse-backend.teamdatajegerne]   [behandlingskatalog-backend.teamdatajegerne]
```

Brukeren logger inn og får et token med `aud=nav-etterlevelse-mcp`. For hvert MCP-kall
exchanger serveren dette tokenet via [Texas](https://docs.nais.io/auth/reference/#texas)
til downstream-tokens for etterlevelse og behandlingskatalog — med brukerens identitet
bevart for auditing.

## MCP-tools

### Etterlevelse — les

| Tool | Beskrivelse |
|------|-------------|
| `list_etterlevelse_dokumentasjoner` | Søk/list etterlevelsesdokumentasjoner |
| `get_etterlevelse_dokumentasjon` | Hent ett dokument med alle etterlevelser |
| `list_krav` | List krav, filtrer på tema, tagger eller dokument |
| `get_krav` | Hent ett krav med suksesskriterier |
| `get_etterlevelse` | Hent etterlevelse for et spesifikt krav |
| `get_behandlingens_livsloep` | Hent behandlingens livsløp for låst dokument |
| `get_pvk_dokument` | Hent PVK-dokument for låst dokument |
| `list_risikoscenarioer` | List risikoscenarioer for låst PVK-dokument |
| `list_tiltak` | List tiltak for låst PVK-dokument |
| `get_my_teams` | Hent team du er medlem av |
| `lock_document` | Lås et dokument for skriveoperasjoner i gjeldende sesjon |

### Etterlevelse — skriv *(krever feature-toggle)*

| Tool | Beskrivelse |
|------|-------------|
| `create_etterlevelse_dokumentasjon` | Opprett nytt etterlevelsesdokument |
| `write_etterlevelse_dokumentasjon` | Oppdater dokumentegenskaper |
| `write_etterlevelse` | Svar på ett krav |
| `delete_etterlevelse` | Slett en etterlevelsesbesvarelse |
| `write_behandlingens_livsloep` | Opprett/oppdater behandlingens livsløp (støtter filvedlegg) |
| `delete_behandlingens_livsloep` | Slett behandlingens livsløp |
| `write_behandlingens_art_og_omfang` | Opprett/oppdater behandlingens art og omfang |

### PVK — skriv *(krever feature-toggle)*

| Tool | Beskrivelse |
|------|-------------|
| `create_pvk_dokument` | Opprett PVK-dokument for låst etterlevelsesdokument |
| `delete_pvk_dokument` | Slett PVK-dokumentet |
| `write_pvk_egenskaper` | Oppdater DPIA-egenskaper og PVK-behovsvurdering (veiviser) |
| `write_pvk_involvering` | Oppdater involveringsfelt i PVK |
| `write_pvk_risikoeier` | Skriv merknad til risikoeier (lederrettet oppsummering for godkjenning) |
| `write_risikoscenario` | Opprett/oppdater risikoscenario (krav-koblet eller øvrig) |
| `delete_risikoscenario` | Slett risikoscenario (cascade-sletter tilknyttede tiltak) |
| `write_tiltak` | Opprett/oppdater tiltak |
| `delete_tiltak` | Slett tiltak |
| `link_krav_to_risikoscenario` | Koble krav til risikoscenario |
| `unlink_krav_from_risikoscenario` | Fjern krav-kobling fra risikoscenario |

### Behandlingskatalog — les

| Tool | Beskrivelse |
|------|-------------|
| `search_behandlinger` | Søk behandlinger på navn eller B-nummer |
| `get_behandling` | Hent full behandlingsinfo (UUID eller B-nummer) |
| `get_processor` | Hent databehandler-info |

## Tilgangsbegrensninger

- **Teamtilgang**: Skriveoperasjoner er kun tillatt for dokumenter eid av team du er medlem av.
  `get_my_teams` returnerer dine team med UUID-er. Tilgang verifiseres via `hasCurrentUserAccess`
  i etterlevelse-backend.
- **Dokumentlås**: Alle skriveoperasjoner krever at dokumentet er låst med `lock_document`
  i gjeldende sesjon. Låsen gjelder kun i minnet — ny sesjon krever ny lås.
- **Feature-toggle**: Alle skriveoperasjoner (unntatt `lock_document`) styres av
  Unleash-toggle `nav-etterlevelse-mcp.write-enabled`. Toggle administreres i
  [dab-unleash-web.iap.nav.cloud.nais.io](https://dab-unleash-web.iap.nav.cloud.nais.io).
  Uten Unleash-konfigurasjon er skriving alltid tillatt (fallback).
- **Kravstatus**: `OPPFYLT` / `FERDIG` settes manuelt i
  [etterlevelse.ansatt.nav.no](https://etterlevelse.ansatt.nav.no) etter menneskelig gjennomgang.

## Oppsett

### 1. Deploy

```bash
gh workflow run deploy.yaml
```

### 2. Bruk via OpenCode / Copilot CLI

Legg til MCP-serveren:

```bash
opencode mcp add
# Velg "remote", skriv inn URL:
# Prod: https://nav-etterlevelse-mcp.intern.nav.no
# Dev:  https://nav-etterlevelse-mcp.intern.dev.nav.no
```
I copilot CLI kan du bruke `mcp`-kommandoene direkte, f.eks.:
```bash
/mcp add 

name: nav-etterlevelse-mcp
servertype: HTTP
remote server: https://nav-etterlevelse-mcp.intern.nav.no
```
Copilot validerer mcp servere mot mcp-registry, så det er ikke mulig å legge til dev-instansen

Autentiser:

```bash
opencode mcp auth nav-etterlevelse-mcp
```
I copilot autentiserer du automatisk inne i agent sesjonen.

Ingen `.cplt.toml` er nødvendig — agenten kaller kun MCP-serveren direkte.

### 3. Installer etterlevelse-skills

MCP-serveren brukes av skillene i [navikt/dab-copilot-config](https://github.com/navikt/dab-copilot-config).
Se README der for oppsett av symlinker til `~/.copilot/skills/` og `~/.config/opencode/skills/`.

## Sesjonshåndtering

MCP-tokenet lever i **1 time**, men klienten fornyer det automatisk ved hjelp av et
refresh-token som lever i **24 timer** — full re-autentisering via nettleser er normalt
kun nødvendig én gang per dag.

Azure AD Entra-sesjonen lever i **10 timer** — Texas-sidekaren håndterer automatisk
fornyelse av downstream-tokens innenfor denne perioden.

Hvis en agentsesjon feiler med autentiseringsfeil:
- **OpenCode:** Kjør `opencode mcp auth nav-etterlevelse-mcp` i et nytt terminalvindu
- **Copilot CLI:** Prøv `/mcp`-kommandoen i chat-vinduet for å re-autentisere

In-memory sesjonsstoren betyr at ett token per pod er gyldige. Av den grunn er
`replicas.max: 1` i NAIS-manifestet — se kommentar i `.nais/app.yaml` for detaljer.

## Planlagte utvidelser

| Utvidelse | Beskrivelse | Status |
|-----------|-------------|--------|
| [Navet (SharePoint) integrasjon](docs/navet-sharepoint-integration.md) | Les fagretningslinjer og personvernsider fra Navet via Microsoft Graph API med `Sites.Selected`-tilgang. Gjør at nav-context-skillen kan hente domenekontekst automatisk. | Avventer admin-consent for `Sites.Selected` i Entra ID |
