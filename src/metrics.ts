import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from '@prometheus-io/client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// --- Generell MCP-trafikk ---

export const mcpRequestsTotal = new Counter({
  name: 'mcp_requests_total',
  help: 'Totalt antall MCP tool-kall',
  labelNames: ['tool', 'status'] as const,
  registers: [registry],
});

export const mcpRequestDuration = new Histogram({
  name: 'mcp_request_duration_seconds',
  help: 'Responstid per MCP tool-kall',
  labelNames: ['tool'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const mcpActiveSessions = new Gauge({
  name: 'mcp_active_sessions',
  help: 'Antall aktive MCP-sesjoner akkurat nå',
  registers: [registry],
});

// --- Forretningsmetrikker ---

export const etterlevelseWritesTotal = new Counter({
  name: 'etterlevelse_writes_total',
  help: 'Skriveoperasjoner mot etterlevelse per krav og SK',
  labelNames: ['kravnummer', 'kravversjon', 'suksesskriterium_id', 'suksesskriterium_status'] as const,
  registers: [registry],
});

export const etterlevelseDocsCreatedTotal = new Counter({
  name: 'etterlevelse_docs_created_total',
  help: 'Antall nye etterlevelsesdokumentasjoner opprettet',
  registers: [registry],
});

export const pvkOperationsTotal = new Counter({
  name: 'pvk_operations_total',
  help: 'PVK-operasjoner (risikoscenarioer, tiltak, dokumenter)',
  labelNames: ['operation', 'status'] as const,
  registers: [registry],
});

export const navetReadsTotal = new Counter({
  name: 'navet_reads_total',
  help: 'Lesing fra Navet per fagområde',
  labelNames: ['fagomrade', 'operation'] as const,
  registers: [registry],
});

export const behandlingskatalogReadsTotal = new Counter({
  name: 'behandlingskatalog_reads_total',
  help: 'Lesing fra behandlingskatalog per operasjon',
  labelNames: ['operation'] as const,
  registers: [registry],
});

// --- Selvrapportert arbeidsflyt (skill-telemetri) ---

// Ren telemetri fra skillen selv — ikke MCP-observerte fakta. Brukes til å måle
// om den påkrevde interaktive gjennomgangsprosessen (ett SK om gangen, rapport
// før opplasting) faktisk følges, siden dette er usynlig for MCP-serveren som
// bare ser tool-kall, ikke samtaleflyten rundt dem.
export const reviewWorkflowEventsTotal = new Counter({
  name: 'review_workflow_events_total',
  help: 'Selvrapporterte arbeidsflyt-hendelser fra etterlevelse-/PVK-skillen',
  labelNames: ['event', 'decision'] as const,
  registers: [registry],
});

// --- Tekniske feil og drift ---

export const mcpErrorsTotal = new Counter({
  name: 'mcp_errors_total',
  help: 'Feil per MCP tool og feiltype',
  labelNames: ['tool', 'error_type'] as const,
  registers: [registry],
});

export const texasOboErrorsTotal = new Counter({
  name: 'texas_obo_errors_total',
  help: 'Feil ved OBO-veksling via Texas',
  registers: [registry],
});

export const upstreamErrorsTotal = new Counter({
  name: 'upstream_errors_total',
  help: 'Feil mot downstream-systemer',
  labelNames: ['backend'] as const,
  registers: [registry],
});

export const authRefreshesTotal = new Counter({
  name: 'auth_refreshes_total',
  help: 'Antall token-refresh operasjoner',
  registers: [registry],
});
