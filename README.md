# nav-etterlevelse-mcp

> ⚠️ **Status: kun dev.** Løsningen er foreløpig kun operativ og godkjent for bruk i `dev-gcp`.
> Prod-instansen er deployert, men **ikke godkjent/åpnet for bruk** ennå — ikke bruk
> `https://nav-etterlevelse-mcp.intern.nav.no/mcp` før dette er avklart.

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
| `begin_sk_review` | Start den obligatoriske per-SK-gjennomgangen for ETT suksesskriterium — krever aktiv sesjonslås og feature-toggle for skriving. Returnerer en ferdig formatert presentasjon og et engangs `reviewToken` som `write_suksesskriterium` krever for akkurat dette SK-et. Kaller ingen skrive-endepunkt selv (`destructiveHint: false`), men hører til skriveflyten siden tokenet kun er nyttig for en påfølgende skriving |
| `write_suksesskriterium` | Skriv/oppdater begrunnelsen for ETT suksesskriterium om gangen (fletter inn i eksisterende besvarelse). Krever et gyldig `reviewToken` fra `begin_sk_review` for akkurat dette SK-et — kall `begin_sk_review` og vent på brukerens svar først. Oppdager automatisk samtidig redigering (f.eks. fra etterlevelse-frontend) via sesjonssporet versjonskontroll — ingen input påkrevd fra kalleren |
| `write_krav_status` | Sett status for et helt krav (f.eks. IKKE_RELEVANT) uten å røre suksesskriterie-begrunnelsene. Oppdager automatisk samtidig redigering (f.eks. fra etterlevelse-frontend) via sesjonssporet versjonskontroll — ingen input påkrevd fra kalleren |
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
| `intranett-omstilling` | ✅ Tilgang innvilget (dev + prod) |
| `fag-og-ytelser` | ✅ Hub-site (dev + prod, begrenset innhold) |
| `arbeidsavklaringspenger` | ✅ Tilgang innvilget (dev + prod) |
| `dagpenger` | ✅ Tilgang innvilget (dev + prod) |
| `sykefravarsoppfolging-og-sykepenger` | ✅ Tilgang innvilget (dev + prod) |
| `sosiale-tjenester` | ✅ Tilgang innvilget (dev + prod) |
| `tiltak-og-virkemidler` | ✅ Tilgang innvilget (dev + prod) |
| `pensjon-alderspensjon` | ✅ Tilgang innvilget (dev + prod) |
| `markedsarbeid` | ✅ Tilgang innvilget (dev + prod) |

### Behandlingskatalog — les

| Tool | Beskrivelse |
|------|-------------|
| `search_behandlinger` | Søk behandlinger på navn eller B-nummer |
| `get_behandling` | Hent full behandlingsinfo (UUID eller B-nummer) |
| `search_dp_behandlinger` | Søk behandlinger der Nav er databehandler, på navn eller D-nummer |
| `get_dp_behandling` | Hent full behandlingsinfo der Nav er databehandler (UUID eller D-nummer) |
| `get_processor` | Hent databehandler-info |

**B-nummer vs. D-nummer:** Behandlingskatalogen skiller mellom vanlige behandlinger der Nav er
behandlingsansvarlig (`Process`, B-nummer, f.eks. B580) og behandlinger der Nav kun opptrer som
databehandler for en annen behandlingsansvarlig (`DpProcess`, D-nummer, f.eks. D123, registrert
under «Nav som databehandler»). Et etterlevelsesdokument kan kobles til enten `behandlingIds`
(B-nummer) eller `dpBehandlingIds` (D-nummer) — minst ett av dem må være satt.

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
# Dev:  https://nav-etterlevelse-mcp.intern.dev.nav.no/mcp
# Prod: https://nav-etterlevelse-mcp.intern.nav.no/mcp (ikke godkjent for bruk ennå, se statusvarsel øverst)
```
I copilot CLI kan du bruke `mcp`-kommandoene direkte, f.eks.:
```bash
/mcp add 

name: nav-etterlevelse-mcp
servertype: HTTP
remote server: https://nav-etterlevelse-mcp.intern.nav.no/mcp
```
Copilot validerer mcp servere mot mcp-registry, så det er ikke mulig å legge til dev-instansen.
Merk at prod-URL-en over foreløpig ikke skal tas i bruk, se statusvarsel øverst i denne README-en.

Autentiser:

```bash
opencode mcp auth nav-etterlevelse-mcp
```
I copilot autentiserer du automatisk inne i agent sesjonen.

### 2. Installer etterlevelse-skills

MCP-serveren brukes av skillene i [navikt/dab-copilot-config](https://github.com/navikt/dab-copilot-config).
Se README der for oppsett av symlinker til `~/.copilot/skills/` og `~/.config/opencode/skills/`.

### 3. Kjøring i sandbox (cplt)

Se [dab-copilot-config README](https://github.com/navikt/dab-copilot-config#kjøring-i-cplt-sandbox)
for komplett cplt-oppsett (skills, GH_TOKEN, OAuth-autentisering).

MCP-serveren krever spesifikt:
- `sandbox.allow_browser = true` — for OAuth-flows mot nav-etterlevelse-mcp
- `proxy.allow_private_domains = ["intern.nav.no"]` — for tilgang til intern ingress

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

Ingen planlagte utvidelser for øyeblikket.
