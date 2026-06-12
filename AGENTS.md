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

**nav-etterlevelse-mcp** is a TypeScript MCP server (Model Context Protocol) that gives GitHub Copilot CLI structured, schema-validated access to:
- [etterlevelse-api.intern.nav.no](https://etterlevelse-api.intern.nav.no) — Nav's compliance documentation system
- [behandlingskatalog.ansatt.nav.no](https://behandlingskatalog.ansatt.nav.no) — Nav's data processing catalogue

Authentication: Azure AD OAuth 2.1 PKCE — users log in once in the browser, and the server holds tokens in memory for the session.

Stack: **TypeScript · Node.js 22 · Express · MCP SDK · Unleash**
Deployed on: **Nais prod-gcp, namespace `dab`**
