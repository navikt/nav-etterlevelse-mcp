# Copilot Code Review Instructions — nav-etterlevelse-mcp

Review all pull requests against the following criteria. Flag issues as **blocking** (must fix before merge) or **advisory** (should fix, but not a blocker).

## 🔐 Security — BLOCKING

- **No tokens or secrets in logs.** `console.log`/`console.error` must never include bearer tokens, refresh tokens, authorization codes, client secrets, or `tokenData` objects.
- **No PII in logs.** Do not log fnr, full names, addresses, or other personal identifiers. Log correlation IDs or sakId instead.
- **`requireMcpBearerToken` on all MCP endpoints.** Every route under `/mcp` must use this middleware.
- **OBO token exchange per request.** Never cache or reuse an OBO token across users or sessions.
- **No hardcoded credentials.** All secrets and Azure config must come from environment variables via `src/config.ts`.
- **No new outbound hosts** without a corresponding `accessPolicy.outbound.external` entry in both `.nais/app.yaml` and `.nais/app-dev.yaml`.

## ✍️ Write operations — BLOCKING

- Every tool that modifies data (create/update/delete) must check the `nav-etterlevelse-mcp.write-enabled` Unleash feature toggle before executing.
- Write tools must require `lock_document` to have been called in the current session before proceeding.

## 🏗️ Architecture — BLOCKING

- **Replicas must stay at `max: 1`** unless the in-memory `authStore` in `src/auth/store.ts` is replaced with a shared store (Redis/Valkey). Flag any change to `replicas.max` that increases it beyond 1.
- **ESM imports** must use `.js` extensions on all relative imports. Missing extensions will break at runtime.

## 🧩 MCP tool quality — Advisory

- Each new tool must have a `description` that clearly explains what it does, what parameters it takes, and what it returns. This description is read by the LLM.
- Input schemas must be typed (Zod or JSON Schema). Avoid loose `string` types where an enum or structured type is appropriate.
- Tool responses should be structured JSON, not free-form strings.
- New tools should be documented in `README.md` under the correct section (les/skriv, correct API group).

## 📦 Dependencies — Advisory

- Prefer adding functionality using existing dependencies before introducing new ones.
- New `dependencies` (not `devDependencies`) increase the container image size and attack surface — justify them in the PR description.
- `engines.node` is `>=22`. Do not downgrade.

## 🚀 Nais manifest — Advisory

- Do not add CPU limits (`resources.limits.cpu`). Only `requests` are appropriate in Nais.
- New environment variables should have sensible defaults in `src/config.ts` where possible, not just hard-fail.
- `allowAllUsers: true` is intentional — this is an internal tool for all Nav employees. Do not change without team discussion.

## 📋 General

- Changes to `src/config.ts` require a check that all new `requireEnv()` calls are documented and available in both Nais manifests (app.yaml and app-dev.yaml) or have defaults.
- Changes to the OAuth/auth flow (`src/auth/`) require extra scrutiny — involve a security champion if the change touches token issuance or validation.
