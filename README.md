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

## MCP-tools (v2 — read + guarded write)

| Tool | API |
|------|-----|
| `list_etterlevelse_dokumentasjoner` | Etterlevelse |
| `get_etterlevelse_dokumentasjon` | Etterlevelse |
| `list_krav` | Etterlevelse |
| `get_krav` | Etterlevelse |
| `get_etterlevelse` | Etterlevelse |
| `lock_document` | Etterlevelse |
| `preview_etterlevelse_write` | Etterlevelse |
| `write_etterlevelse` | Etterlevelse |
| `search_behandlinger` | Behandlingskatalog |
| `get_behandling` | Behandlingskatalog |
| `get_processor` | Behandlingskatalog |

Skriveflyten er to-faset:

1. `lock_document` låser dokumentet for MCP-sesjonen.
2. `preview_etterlevelse_write` henter kravkontekst og viser formatert forhåndsvisning.
3. `write_etterlevelse` bruker et enkeltgangstoken (15 min TTL) etter eksplisitt bekreftelse.

`OPPFYLT` / `FERDIG` settes fortsatt manuelt i etterlevelse.ansatt.nav.no etter menneskelig gjennomgang.

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
