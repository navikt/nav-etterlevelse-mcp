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

## MCP-tools (v1 — read only)

| Tool | API |
|------|-----|
| `list_etterlevelse_dokumentasjoner` | Etterlevelse |
| `get_etterlevelse_dokumentasjon` | Etterlevelse |
| `list_krav` | Etterlevelse |
| `get_krav` | Etterlevelse |
| `get_etterlevelse` | Etterlevelse |
| `search_behandlinger` | Behandlingskatalog |
| `get_behandling` | Behandlingskatalog |
| `get_processor` | Behandlingskatalog |

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
