# Agents

This repository contains GitHub Copilot agent configurations in `.github/agents/`.

## Available agents

| Agent | File | Use for |
|-------|------|---------|
| **nav-pilot** | `nav-pilot.agent.md` | Planning new features, architecture decisions, Nais config |
| **nais** | `nais.agent.md` | Nais manifest, GCP resources, kubectl troubleshooting |
| **security-champion** | `security-champion.agent.md` | Threat modeling, OWASP, security assessments |
| **observability** | `observability.agent.md` | Prometheus metrics, Grafana, alerting |

## Project context

**nav-etterlevelse-mcp** is a TypeScript MCP server (Model Context Protocol) that gives AI agents
(GitHub Copilot CLI, OpenCode) structured, schema-validated access to:
- `etterlevelse-backend.teamdatajegerne` — Nav's compliance documentation system
- `behandlingskatalog-backend.teamdatajegerne` — Nav's data processing catalogue

Authentication: Azure AD OAuth 2.1 PKCE — users log in via browser, the server holds
the user's token (`aud=nav-etterlevelse-mcp`) in memory. On each MCP request, downstream
tokens are obtained via NAIS Texas OBO (on-behalf-of) sidecar, preserving user identity
for auditing in both downstream systems.

Stack: **TypeScript · Node.js 22 · Express · MCP SDK · Unleash**
Deployed on: **Nais prod-gcp and dev-gcp, namespace `dab`**
