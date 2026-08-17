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

### Alternativ B: Separat MCP-server

**Fordeler:**
- Klar separasjon av ansvar
- TryggNok-funksjonalitet tilgjengelig uavhengig av etterlevelse
- Isolert deployment og versjonering

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

**Alternativ A — integrert i `nav-etterlevelse-mcp`.**

### Begrunnelse

**Presisering om kontekst:** `nav-etterlevelse-mcp` er en tilstandsløs server —
den eneste tilstanden som lever her er påloggings- og autentiseringstoken.
Konteksten fra en etterlevelsesgjennomgang (kildekodeanalyse, `system-context.md`,
`domain-context.md`, behandlingskatalog-data, PVK-vurderinger) lever i **agenten**
og i filer produsert av skillene underveis. Denne konteksten er tilgjengelig for
agenten uansett hvilken MCP-server den kaller.

Argumentet for integrert løsning er derfor ikke at serveren «har tilgang» til
konteksten, men at:

1. **Skillene kan orkestrere på tvers av etterlevelse og TryggNok i én arbeidsflyt**
   uten at brukeren må konfigurere og autentisere mot to separate MCP-servere.
2. **Én server — én innlogging.** OBO-tokenet for etterlevelse og Dataverse hentes
   fra samme autentiseringsøkt, noe som gir en sømløs brukeropplevelse.
3. **PVK-presedens:** Sensitive personvernvurderinger (PVK) er allerede integrert
   i samme server. Sensitiv sikkerhetsinfo i TryggNok er ikke et sterkere argument
   for separasjon enn det PVK allerede representerer.
4. **Enklere vedlikehold:** Én Nais-applikasjon, én CI/CD-pipeline, én
   konfigurasjonsflate.

**PVK-presedens:** PVK-modulen inneholder sensitive personvernvurderinger som sendes
til personvernombudet. Dette er sammenlignbart med sensitiv sikkerhetsinfo i TryggNok.
PVK er allerede integrert i `nav-etterlevelse-mcp` uten at det har vært et problem —
det samme prinsippet gjelder for TryggNok.

En eventuell separat `nav-trygg-nok-mcp` kan vurderes på et senere tidspunkt dersom
det oppstår et reelt behov for å bruke TryggNok-funksjonalitet uavhengig av etterlevelse.

---

## Konsekvenser

- Ny fil `src/mcp/tools/trygg-nok.ts` med Dataverse-verktøy
- Ny fil `src/api/tryggNokClient.ts` med Dataverse Web API-klient
- NAIS Texas-konfigurasjon utvides med Dataverse OBO-scope
- `app.yaml` og `app-dev.yaml` oppdateres med ny Texas-konfigurasjon
- Nais app-registrering trenger `user_impersonation`-tillatelse mot Dataverse
