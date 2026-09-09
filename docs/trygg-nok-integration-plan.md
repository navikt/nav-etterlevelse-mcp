# Plan: TryggNok-integrasjon i nav-etterlevelse-mcp

## Status

**Fase 1 fullført** — arkitekturvurderinger dokumentert i ADR-er.
**Fase 2 pågår** — detaljert implementasjonsplan under utarbeidelse.

---

## Bakgrunn

TryggNok er Navs PowerApp-baserte løsning for risiko- og sikkerhetsvurderinger (ROS).
Den kjører på Microsoft Dataverse (Dynamics 365) med API-endepunkt:

```
https://org4b8eb712.api.crm4.dynamics.com/api/data/v9.2
```

I dag er koblingen mellom etterlevelse og ROS utelukkende manuell: etterlevelsesdokumentasjonen
kan lenke til en TryggNok-vurdering, men det finnes ingen programmatisk integrasjon.

PVK-modulen i etterlevelse dekker personvernrisiko, men ikke sikkerhetsrisiko. TryggNok
og PVK utfyller hverandre og er begge del av den totale etterlevelsesdokumentasjonen.

---

## Fase 1 — Intervjufunn

### Funksjonelt omfang

| Spørsmål | Svar |
|----------|------|
| Les eller skriv? | Begge — full CRUD: risikoscenarioer, risiko, konsekvens, tiltak |
| Kobling til etterlevelse? | Etterlevelsesdokumentasjonen lenker til ROS, men systemene er ikke integrert i dag |
| Hvem bruker det? | Teammedlemmer med eksisterende TryggNok-tilgang (tilgangsstyring per team i TryggNok) |
| Sensitiv data? | Potensielt sensitiv sikkerhetsinfo (sårbarheter, trusselaktører) |
| Brukeridentitet i audit-trail? | Ja — påkrevd |

### Teknisk kontekst

| Tema | Funn |
|------|------|
| TryggNok eier | Servicebruker `srvTryggNok` — ansvarlig team ikke identifisert enda |
| Power Apps tilgang | "Delt med meg" — kjøretilgang, ikke editeringstilgang |
| App-registrering for Dataverse | Finnes ikke per nå — må etableres |
| Auth-mekanisme | OBO (on-behalf-of) påkrevd for å bevare brukeridentitet |
| Eneste ROS-verktøy? | Ja — PVK dekker personvernrisiko separat |

### Blindsoner

| # | Domene | Status | Kommentar |
|---|--------|--------|-----------|
| 1 | Personvern | ✅ | Sensitiv sikkerhetsinfo, ikke PII — men access-sensitiv |
| 2 | Tilgangskontroll | ✅ | OBO kreves, team-RBAC i TryggNok, bruker må ha egen tilgang |
| 3 | Feilhåndtering | ⬜ | Graceful degradation antas akseptabelt |
| 4 | Observability | ⬜ | Ikke avklart |
| 5 | Teamgrenser | ⚠️ | TryggNok-eier ikke identifisert |
| 6 | Endringsimpakt | ✅ | Greenfield — ingen eksisterende konsumenter |
| 7 | Teststrategi | ⬜ | Sandbox/dev-miljø i Dataverse ikke avklart |
| 8–10 | Modernisering / bakoverkompatibilitet | N/A | Nybygg |
| 11 | Ny teknologi | ⚠️ | Dataverse Web API er ukjent territorium → rød sone |

### Åpne spørsmål

- Hvem eier TryggNok i Nav? Kontaktpunkt for app-registrering og admin consent?
- Finnes det et dev/sandbox Dataverse-miljø for testing?
- Hva er TryggNok sin datamodell? (tabeller, felter, relasjoner)

---

## Arkitekturvurderinger

Se dedikerte ADR-er:

- [ADR-001: Integrer TryggNok i nav-etterlevelse-mcp](adr/ADR-001-trygg-nok-integrated-vs-separate.md)
- [ADR-002: OBO-autentisering mot Dataverse](adr/ADR-002-trygg-nok-obo-auth.md)

---

## Overordnet teknisk tilnærming

```
[Bruker]
   │  Azure AD PKCE (eksisterende)
   ▼
[nav-etterlevelse-mcp]
   │  OBO via NAIS Texas (nytt scope: Dataverse)
   ▼
[Dataverse Web API]
   https://org4b8eb712.api.crm4.dynamics.com/api/data/v9.2
```

Ny kode plasseres i `src/mcp/tools/trygg-nok.ts` og `src/api/tryggNokClient.ts`,
etter samme mønster som eksisterende etterlevelse- og PVK-verktøy.

**Merk:** `nav-etterlevelse-mcp` er tilstandsløs — eneste tilstand er
autentiseringstoken. Konteksten fra en etterlevelsesgjennomgang (kildekodeanalyse,
`system-context.md`, `domain-context.md`) lever i agenten og i filer produsert av
skillene. Denne konteksten er tilgjengelig for agenten uansett hvilken server den
kaller. Integrasjonsargumentet handler derfor om sømløs brukeropplevelse og
skillbasert orkestrering — ikke om server-intern konteksttilgang.

---

## Avhengigheter og forutsetninger

| Forutsetning | Status | Ansvarlig |
|---|---|---|
| Identifisere TryggNok-eierteam | ⏳ Ikke påbegynt | — |
| App-registrering med Dataverse `user_impersonation` | ⏳ Avventer eierteam | NAV IT / Entra-admin |
| Admin consent i Nav-tenant | ⏳ Avventer app-reg | NAV IT |
| NAIS Texas OBO-konfigurasjon for Dataverse | ⏳ Avventer app-reg | NAIS / teamet |
| Kartlegge TryggNok datamodell | ⏳ Ikke påbegynt | Teamet (se tips nedenfor) |
| **ROS for agentisk etterlevelse godkjent av risikoeier** | ⚠️ Påbegynt, ikke godkjent | Teamet |
| **Etterlevelse og PVK for agentisk etterlevelse fullført** | ❌ Ikke påbegynt | Teamet |

> **Merk:** TryggNok-integrasjonen bør ikke settes i produksjon før ROS er godkjent
> og etterlevelse/PVK er fullført. Risikoen for lekkasje av personvernsvakheter (PVK)
> og sikkerhetssvakheter (TryggNok) i agentens kontekst er ikke formelt vurdert.
> Se [ADR-001](adr/ADR-001-trygg-nok-integrated-vs-separate.md) for detaljer.

### Tips: Kartlegge datamodellen uten app-registrering

"Opprett agent fra app" i Power Apps (make.powerapps.com) kan brukes til å generere
en Copilot Studio-agent fra TryggNok-appen. Dette kan gi innsikt i datamodellen
(tabeller, felter, relasjoner) uten å måtte etablere Dataverse API-tilgang først.
Nyttig som en tidlig utforskningsstrategi parallelt med å spore opp eierteamet.

---

## Referanser

- [Dataverse Web API dokumentasjon](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
- [NAIS Texas OBO-dokumentasjon](https://docs.nais.io/auth/reference/#texas)
- [Power Apps — miljø-info (intern)](https://make.powerapps.com)
  - Miljø-ID: `Default-62366534-1ec3-4962-8869-9b5535279d0b`
  - Web API: `https://org4b8eb712.api.crm4.dynamics.com/api/data/v9.2`
