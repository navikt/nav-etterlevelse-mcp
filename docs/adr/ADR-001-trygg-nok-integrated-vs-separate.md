# ADR-001: TryggNok-integrasjon som del av nav-etterlevelse-mcp

**Dato:** 2026-08-17
**Status:** Godkjent
**Besluttet av:** Hans Petter Simonsen

---

## Kontekst

Vi ønsker å gi AI-agenter (GitHub Copilot, OpenCode) mulighet til å lese og skrive
til TryggNok — Navs PowerApp-baserte ROS-løsning — som del av en agentisk
etterlevelsesarbeidsflyt.

Spørsmålet er om denne funksjonaliteten skal:

1. **Integreres i `nav-etterlevelse-mcp`** — samme MCP-server som etterlevelse og PVK
2. **Leve i en separat MCP-server** — f.eks. `nav-trygg-nok-mcp`
3. **Kun eksponeres som en skill** — uten nye MCP-verktøy

---

## Vurderte alternativer

### Alternativ A: Integrert i nav-etterlevelse-mcp

Nye verktøy legges i `src/mcp/tools/trygg-nok.ts` og `src/api/tryggNokClient.ts`.

**Fordeler:**
- Full tilgang til etterlevelseskontekst under ROS-arbeid: kildekodeanalyse,
  `system-context.md`, `domain-context.md`, behandlingskatalog-data og PVK-vurderinger
- PVK og ROS utfyller hverandre — felles kontekst gir rikere risikovurderinger
- Ingen ekstra MCP-server å konfigurere og vedlikeholde for brukerne
- OBO-autentiseringsmønster er allerede etablert — kan utvides med nytt Dataverse-scope
- Følger eksisterende kodestruktur og konvensjoner

**Ulemper:**
- TryggNok kan ikke brukes uavhengig av etterlevelse
- Øker størrelsen og ansvarsområdet til én server
- **Team Datajegerne** (naturlig eier av nav-etterlevelse-mcp) vil sitte med
  vedlikeholdsansvar for TryggNok-kode mot et system de ikke eier — på sikt bør
  TryggNok-eierteamet ta eierskap til dette integrasjonslaget

### Alternativ B: Separat MCP-server

**Fordeler:**
- Klar separasjon av ansvar
- TryggNok-funksjonalitet tilgjengelig uavhengig av etterlevelse
- Isolert deployment og versjonering
- **Organisatorisk eierskap følger systemgrenser:** TryggNok-eierteamet kan ta
  eierskap til `nav-trygg-nok-mcp` uten å måtte forholde seg til etterlevelse-koden

**Ulemper:**
- Mister tilgang til etterlevelseskontekst (kildekodeanalyse, system-context, PVK)
  uten ekstra orkestrering — noe som er kjernen av verdien
- To MCP-servere å konfigurere, autentisere og vedlikeholde
- Auth-utfordringen (Dataverse OBO) er identisk uansett plassering
- Krever separat Nais-applikasjon, CI/CD og deploy-pipeline

### Alternativ C: Skill uten MCP-verktøy

**Fordeler:**
- Ingen ny kode i MCP-serveren

**Ulemper:**
- Kan ikke utføre CRUD mot Dataverse — ingen reell integrasjon
- Utelukker den sentrale bruksverdien (opprette og oppdatere ROS)

---

## Beslutning

**Alternativ A — integrert i `nav-etterlevelse-mcp`, med mulighet for senere utskilling.**

### Begrunnelse

Beslutningen utsettes ikke, men tas inkrementelt: start integrert, skill ut ved behov.

Argumentene for og mot separat server er reelle, men umodne å ta stilling til nå:
- Det er uavklart om en selvstendig ROS-arbeidsflyt (med `security-champion` og
  `threat-model`) vil ha et reelt behov for en separat server, eller om skill-basert
  komposisjon over felles filer (`system-context.md` etc.) er tilstrekkelig
- TryggNok-integrasjonen er under utforskning — datamodell og omfang er ikke kartlagt
- TryggNok-eierteamet er ikke identifisert — eierskap til integrasjonslaget er uavklart

Det organisatoriske eierskapsargumentet taler på sikt for separat server: prinsippet
om at teamet som eier et system også bør eie integrasjonslaget mot det systemet. Dette
er ikke et argument for å vente, men for å holde utskilling åpen som en naturlig neste
steg når TryggNok-eierteamet er identifisert og ønsker å ta eierskap.

**Valget er bevisst reversibelt:** Kode plasseres i dedikerte filer
(`src/mcp/tools/trygg-nok.ts`, `src/api/tryggNokClient.ts`) uten avhengigheter inn
i etterlevelse-koden. Utskilling til egen server krever kun å flytte disse filene og
etablere en ny Nais-applikasjon.

**Tilleggsargumenter for integrert start:**
- Én server — én innlogging. OBO-tokenet for etterlevelse og Dataverse hentes fra
  samme autentiseringsøkt.
- Skillene kan orkestrere på tvers av etterlevelse og TryggNok uten at brukeren
  konfigurerer og autentiserer mot to separate servere.
- Enklere vedlikehold i startfasen: én Nais-applikasjon, én CI/CD-pipeline.

---

## Forutsetning: ROS og etterlevelsesdokumentasjon for agentisk etterlevelse

Denne beslutningen innebærer at `nav-etterlevelse-mcp` vil håndtere to kategorier
sensitiv informasjon i agentens kontekst:

- **Personvernsvakheter** — fra PVK-modulen (allerede tilgjengelig i dag)
- **Sikkerhetssvakheter** — fra TryggNok (ny med denne integrasjonen)

Per i dag er det gjennomført en ROS for agentisk etterlevelse, men denne er ikke
godkjent av risikoeier. Det er heller ikke fullført etterlevelsesdokumentasjon eller
PVK for løsningen. Risikoen ved at sensitiv informasjon eksponeres i agentens kontekst
er ikke formelt vurdert.

**Denne integrasjonen bør ikke settes i produksjon før:**

1. ROS for agentisk etterlevelse er godkjent av risikoeier — risikoscenarioer for
   lekkasje av personvernsvakheter (PVK) og sikkerhetssvakheter (TryggNok) er
   dokumentert og mitigert
2. Etterlevelsesdokumentasjon og PVK for agentisk etterlevelse er fullført

**Relevant for ROS-vurderingen:**
Navs oppdaterte retningslinjer for Copilot (juni 2026) har fjernet restriksjoner mot
bruk av virksomhetskritisk og konfidensiell informasjon i M365 Copilot. Eneste
gjenværende restriksjon er personopplysninger om Navs brukere. Retningslinjene er
skrevet for M365 Copilot og Copilot Chat, men argumentasjonslinjen (data lagres ikke,
brukes ikke til trening, opererer innenfor sikkerhetsperimeter) er relevant å vurdere
opp mot GitHub Copilot og OpenCode i ROS-arbeidet.

Se: [Oppdaterte retningslinjer for Copilot med færre restriksjoner (Navet)](https://navno.sharepoint.com/sites/intranett-fellesnyheter/SitePages/Oppdaterte-retningslinjer-for-Copilot-med-færre-restriksjoner.aspx)

---

## Konsekvenser

- Ny fil `src/mcp/tools/trygg-nok.ts` med Dataverse-verktøy
- Ny fil `src/api/tryggNokClient.ts` med Dataverse Web API-klient
- NAIS Texas-konfigurasjon utvides med Dataverse OBO-scope
- `app.yaml` og `app-dev.yaml` oppdateres med ny Texas-konfigurasjon
- Nais app-registrering trenger `user_impersonation`-tillatelse mot Dataverse
- **Blokkerer produksjonssetting:** Godkjent ROS og fullført etterlevelse/PVK for agentisk etterlevelse
