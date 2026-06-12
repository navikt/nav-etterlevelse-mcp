# Copilot Instructions — nav-etterlevelse-mcp

## Project overview

TypeScript MCP server (Model Context Protocol) that gives GitHub Copilot CLI access to Nav's etterlevelse and behandlingskatalog APIs. Users authenticate once via Azure AD OAuth 2.1 PKCE; the server exchanges tokens using OBO (On-Behalf-Of) to call downstream services on their behalf.

```
[Copilot CLI /mcp]
       ↓  MCP OAuth 2.1 (PKCE)
[nav-etterlevelse-mcp  — Nais prod-gcp, namespace dab]
       ↓  Azure AD OBO
[etterlevelse-backend (teamdatajegerne)]   [behandlingskatalog-backend (teamkatalog)]
```

## Stack

- **Runtime:** Node.js 22, TypeScript (ESM, `"type": "module"`)
- **Framework:** Express 4
- **MCP:** `@modelcontextprotocol/sdk`
- **Feature flags:** Unleash (`unleash-client`)
- **Build:** `tsc` → `dist/`, `npm run dev` uses `tsx` directly
- **Deploy:** Nais (Kubernetes/GCP), Docker, GitHub Actions

## Architecture — key modules

| Path | Responsibility |
|------|----------------|
| `src/index.ts` | Express app setup, route wiring, error handling |
| `src/config.ts` | All configuration from env-vars; fail-fast on missing required vars |
| `src/auth/oauth.ts` | OAuth 2.1 PKCE + device code flow, token issuance |
| `src/auth/middleware.ts` | MCP bearer-token validation middleware |
| `src/auth/store.ts` | In-memory session/token store (single-replica constraint) |
| `src/mcp/server.ts` | MCP server, tool registration, request dispatch |
| `src/mcp/tools/etterlevelse.ts` | All etterlevelse + PVK MCP tools |
| `src/mcp/tools/behandlingskatalog.ts` | All behandlingskatalog MCP tools |
| `src/api/etterlevelseClient.ts` | HTTP client for etterlevelse-backend |
| `src/api/behandlingskatalogClient.ts` | HTTP client for behandlingskatalog-backend |
| `src/api/graphClient.ts` | Shared fetch wrapper with auth headers |
| `src/unleash.ts` | Unleash client init and feature-toggle helpers |

## Coding conventions

- **Language:** TypeScript with strict mode. No `any` unless unavoidable — use `unknown` and narrow.
- **Imports:** ESM with `.js` extensions on relative imports (required for Node ESM).
- **Error handling:** Throw typed errors or return `Result`-style objects. Never swallow errors silently.
- **Secrets/config:** All secrets come from environment variables. Never hardcode credentials or tokens.
- **Logging:** Use `console.error` for errors/warnings (stderr), `console.log` for structured info. Never log tokens, PII (fnr, name, address), or secrets.
- **MCP tools:** Each tool must have a clear `description`, typed `inputSchema` (Zod or JSON Schema), and return structured JSON. Keep tools focused — one action per tool.
- **Feature flags:** Write operations must check the `nav-etterlevelse-mcp.write-enabled` Unleash toggle before proceeding.
- **Auth:** All MCP endpoints require `requireMcpBearerToken` middleware. The OBO exchange must happen per-request using the user's token.

## Nais / deployment

- **Namespace:** `dab`, **cluster:** `prod-gcp` (and `dev-gcp`)
- **Replicas:** Locked to `max: 1` — the in-memory `authStore` is not shared across pods. Do not increase replicas without replacing the store (e.g., Redis/Valkey).
- **Health endpoint:** `GET /health` — used for both liveness and readiness.
- **Access policy:** Outbound rules to `etterlevelse-backend` (teamdatajegerne) and `behandlingskatalog-backend` (teamkatalog). External egress to Unleash API.
- **Auth:** Azure AD application with `allowAllUsers: true` and PKCE reply URL.

## Adding a new MCP tool

1. Add the tool registration in `src/mcp/tools/etterlevelse.ts` or `behandlingskatalog.ts`.
2. Add the corresponding API call in the relevant client under `src/api/`.
3. If the tool writes data, guard with the Unleash write-enabled toggle.
4. Document the tool in `README.md` under the correct section (les/skriv).

## Do not

- Log tokens, refresh tokens, authorization codes, or PII.
- Hardcode Azure client IDs, secrets, or API URLs — use `src/config.ts`.
- Increase `replicas.max` without replacing the in-memory session store.
- Set CPU limits in the Nais manifest (use only `requests`).
- Bypass the `requireMcpBearerToken` middleware on MCP endpoints.
