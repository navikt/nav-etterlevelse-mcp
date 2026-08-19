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
| `get_etterlevelse_dokumentasjon` | Hent ett dokument med alle etterlevelser og begrunnelsestekst |
| `get_etterlevelse_status_oversikt` | Hent statusoversikt uten begrunnelsestekst — bruk for gap-analyse |
| `list_krav` | List krav, filtrer på tema, tagger eller dokument |
| `get_krav` | Hent ett krav med suksesskriterier |
| `get_krav_for_gjennomgang` | Forbered interaktiv gjennomgang med synlig kravhensikt, SK-beskrivelser og eventuell eksisterende besvarelse |
| `get_etterlevelse` | Hent etterlevelse for et spesifikt krav |
| `get_behandlingens_livsloep` | Hent behandlingens livsløp for låst dokument |
| `get_pvk_dokument` | Hent PVK-dokument for låst dokument |
| `list_risikoscenarioer` | List risikoscenarioer for låst PVK-dokument |
| `list_tiltak` | List tiltak for låst PVK-dokument |
| `get_my_teams` | Hent team du er medlem av (inkl. nomAvdelingId og avdelingNavn) |
| `list_nom_avdelinger` | List alle avdelinger fra NOM |
| `search_slack_channel` | Søk etter Slack-kanaler (for varslingsadresser) |
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
| `write_pvk_melding_til_pvo` | Skriv utkast til melding til PVO (merknad + endringsnotat) |
| `write_risikoscenario` | Opprett/oppdater risikoscenario (krav-koblet eller øvrig) |
| `delete_risikoscenario` | Slett risikoscenario (cascade-sletter tilknyttede tiltak) |
| `write_tiltak` | Opprett/oppdater tiltak |
| `delete_tiltak` | Slett tiltak |
| `link_krav_to_risikoscenario` | Koble krav til risikoscenario |
| `unlink_krav_from_risikoscenario` | Fjern krav-kobling fra risikoscenario |

### Navet (SharePoint) — les

Leser fagområdespesifikke sider fra NAVs interne Navet via Microsoft Graph API med `Sites.Selected`-tilgang.
Tilgang innvilges per fagområde av #tech-azure. Se [implementasjonsplan](docs/navet-sharepoint-integration.md) for detaljer.

| Tool | Beskrivelse |
|------|-------------|
| `list_navet_pages` | List sider på en Navet-site for et fagområde |
| `get_navet_page` | Hent tekstinnhold fra en Navet-side (fagretningslinjer, lover, personvern) |

**Tilgang per fagområde:**

| Fagområde-kode | Status |
|---|---|
| `arbeidsrettet-brukeroppfolging` | ✅ Tilgang innvilget (dev + prod) |
| `utbetalinger` | ✅ Tilgang innvilget (dev + prod) |
| `intranett-utvikling` | ✅ Tilgang innvilget (dev + prod) |
| `fag-og-ytelser` | ✅ Hub-site (dev + prod, begrenset innhold) |
| `stonadsokonomi` | ⏳ Planlagt |
| `arbeidsavklaringspenger` | ⏳ Planlagt |
| `dagpenger` | ⏳ Planlagt |
| `sykefravarsoppfolging-og-sykepenger` | ⏳ Planlagt |
| `sosiale-tjenester` | ⏳ Planlagt |
| `tiltak-og-virkemidler` | ⏳ Planlagt |
| `pensjon-alderspensjon` | ⏳ Planlagt |
| `markedsarbeid` | ⏳ Planlagt |

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

### 1. Bruk via OpenCode / Copilot CLI

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

### 2. Installer etterlevelse-skills

MCP-serveren brukes av skillene i [navikt/dab-copilot-config](https://github.com/navikt/dab-copilot-config).
Se README der for oppsett av symlinker til `~/.copilot/skills/` og `~/.config/opencode/skills/`.

### 3. Kjøring i sandbox (cplt)

Fra august 2026 er Nav-ansatte pålagt å kjøre AI-agenter i sandkasse-miljø. Følgende
konfigurasjon er påkrevd i `~/.config/cplt/config.toml`:

```toml
[sandbox]
allow_browser = true          # Påkrevd for MCP OAuth-flows med nettleser

[allow]
read = ["<path-til-skills-repo>/copilot-config/all/skills"]

[proxy]
allow_private_domains = ["intern.nav.no"]  # Prod. Bruk ["intern.dev.nav.no"] for dev.
timeout = 180                              # Forhindrer timeout på tunge verktøykall
```

**`allow_browser = true`** er nødvendig for at OAuth-flyten mot MCP-serveren skal fungere
inne i sandkassen. Uten dette kan ikke nettleseren åpnes for innlogging.

**OpenCode:** Kjør `opencode mcp auth nav-etterlevelse-mcp` inne i sandkassen (forutsetter
`allow_browser = true`) eller i et separat terminalvindu utenfor cplt.

**Copilot CLI:** Autentiserer automatisk inne i sandkassen når nødvendig — ingen
manuell pre-autentisering kreves.

## Sesjonshåndtering

MCP-tokenet lever i **1 time**, men klienten fornyer det automatisk ved hjelp av et
refresh-token som lever i **24 timer** — full re-autentisering via nettleser er normalt
kun nødvendig én gang per dag.

Azure AD Entra-sesjonen lever i **10 timer** — Texas-sidekaren håndterer automatisk
fornyelse av downstream-tokens innenfor denne perioden.

Hvis en agentsesjon feiler med autentiseringsfeil:
- **OpenCode:** Kjør `opencode mcp auth nav-etterlevelse-mcp` inne i sandkassen
  (forutsetter `allow_browser = true`) eller i et separat terminalvindu utenfor cplt
- **Copilot CLI:** Re-autentiserer automatisk — ingen manuell handling nødvendig

In-memory sesjonsstoren betyr at ett token per pod er gyldige. Av den grunn er
`replicas.max: 1` i NAIS-manifestet — se kommentar i `.nais/app.yaml` for detaljer.

## Planlagte utvidelser

| Utvidelse | Beskrivelse | Status |
|-----------|-------------|--------|
| Navet-tilgang for flere fagområder | `Sites.Selected`-tilgang for stonadsokonomi, dagpenger, sykepenger m.fl. | ⏳ Planlagt |
