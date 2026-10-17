# ADR-002: OBO-autentisering mot Dataverse

**Dato:** 2026-08-17
**Status:** Godkjent
**Besluttet av:** Hans Petter Simonsen

---

## Kontekst

TryggNok kjører på Microsoft Dataverse. For å kalle Dataverse Web API fra
`nav-etterlevelse-mcp` trenger vi et gyldig Azure AD-token med audience
`https://org4b8eb712.api.crm4.dynamics.com`.

Brukeren er allerede autentisert mot MCP-serveren via Azure AD PKCE. Spørsmålet
er hvilken token-mekanisme som skal brukes videre mot Dataverse.

---

## Vurderte alternativer

### Alternativ A: OBO (on-behalf-of) via NAIS Texas

Brukerens innloggingstoken veksles til et Dataverse-token via Texas OBO-endepunktet.
Hvert API-kall mot Dataverse gjøres på vegne av den innloggede brukeren.

**Fordeler:**
- Bevarer brukeridentitet i Dataverse sin audit-logg
- TryggNok sin interne tilgangsstyring (per team) håndheves automatisk —
  brukeren kan bare lese/skrive det de selv har tilgang til
- Følger eksisterende autentiseringsmønster i `nav-etterlevelse-mcp`
- Ingen ekstra privilegier sammenlignet med hva brukeren allerede har

**Ulemper:**
- Krever ny app-registrering i Entra ID med Dataverse `user_impersonation`-tillatelse
- Krever admin consent i Nav-tenant
- Texas OBO må konfigureres med riktig Dataverse-audience

### Alternativ B: Client credentials (service-to-service)

MCP-serveren autentiserer som en service identity mot Dataverse, uavhengig av
innlogget bruker.

**Fordeler:**
- Enklere å konfigurere (ingen OBO-flyt)
- Ingen avhengighet av brukerens individuelle TryggNok-tilgang

**Ulemper:**
- **Mister brukeridentitet i audit-trail** — alle handlinger i TryggNok logges
  som MCP-serveren, ikke som brukeren. Ikke akseptabelt.
- Omgår TryggNok sin interne tilgangsstyring — serveren ville potensielt ha
  tilgang til alle vurderinger på tvers av alle team
- Strider mot Nav-prinsippet om å bevare brukerkontekst i OBO-flyter

---

## Beslutning

**Alternativ A — OBO via NAIS Texas.**

### Begrunnelse

Brukeridentitet i audit-trail er et eksplisitt krav. TryggNok har intern
tilgangsstyring per team som må respekteres — OBO sikrer at agenten aldri kan
gjøre mer enn den innloggede brukeren selv har rett til.

Dette er det samme mønsteret som brukes for etterlevelse-backend og
behandlingskatalog i dag.

---

## Implementasjonskrav

### Entra ID (admin-oppgave)

1. Legg til API-tillatelse på `nav-etterlevelse-mcp`-appregistreringen:
   - API: `Dynamics CRM` (eller direkte audience `https://org4b8eb712.api.crm4.dynamics.com`)
   - Tillatelse: `user_impersonation` (delegert)
2. Grant admin consent i Nav-tenant

### NAIS Texas-konfigurasjon

Texas OBO kalles med Dataverse som target:

```
GET /.well-known/nais-texas  →  finn obo-endepunkt
POST {obo-endpoint}
  grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
  assertion={brukerens innloggingstoken}
  scope=https://org4b8eb712.api.crm4.dynamics.com/user_impersonation
```

### Nais app-manifest

```yaml
# app.yaml / app-dev.yaml — ingen endring i selve azure-blokken,
# men Texas må eksponere et nytt OBO-scope for Dataverse.
# Avklares med NAIS om dette krever eksplisitt konfigurasjon
# eller om vilkårlige audiences støttes automatisk.
azure:
  application:
    enabled: true
```

### Token-flyt i kode

```
[Bruker-token fra MCP-request]
        │
        ▼
Texas OBO-endepunkt
  target: https://org4b8eb712.api.crm4.dynamics.com/user_impersonation
        │
        ▼
[Dataverse-token]
        │
        ▼
TryggNokClient → Dataverse Web API
```

---

## Åpne spørsmål

- Støtter NAIS Texas OBO vilkårlige Dataverse-audiences, eller kreves det eksplisitt
  konfigurasjon per audience? Avklares med #nais-support.
- Finnes det et dev Dataverse-miljø med separat audience for testing uten å treffe
  produksjonsdataene i TryggNok?

---

## Konsekvenser

- Ny app-registrerings-konfigurasjon (admin-oppgave, blokkerer implementasjon)
- `src/api/tryggNokClient.ts` henter OBO-token fra Texas per request
- Token caches ikke på tvers av brukere — hver bruker får sitt eget Dataverse-token
