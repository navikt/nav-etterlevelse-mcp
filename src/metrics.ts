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
  labelNames: ['kravnummer', 'kravversjon', 'suksesskriterium_id', 'suksesskriterium_status', 'write_type'] as const,
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

// --- Per-SK-godkjenning (begin_sk_review / write_suksesskriterium-takting) ---

export const skReviewBeginTotal = new Counter({
  name: 'sk_review_begin_total',
  help: 'Antall begin_sk_review-kall (per-SK presentasjon startet, reviewToken utstedt)',
  registers: [registry],
});

export const skReviewWriteOutcomeTotal = new Counter({
  name: 'sk_review_write_outcome_total',
  help:
    'Utfall av write_suksesskriterium sett opp mot reviewToken/brukerGodkjenning. ' +
    'Sammenlign "accepted" mot sk_review_begin_total for å avdekke drift der agenten ' +
    'skriver uten forutgående presentasjon (skrivinger uten tilhørende review).',
  labelNames: ['outcome', 'bruker_godkjenning'] as const,
  registers: [registry],
});

export const skGjennomgangTotal = new Counter({
  name: 'etterlevelse_sk_gjennomgang_total',
  help:
    'Hendelser i per-SK-gjennomgangen per krav og SK, som mål på hvilke SK-er som krever mest iterasjon. ' +
    'presentert: begin_sk_review. presentert_paa_nytt: begin_sk_review for samme SK mens forrige token ' +
    'var ubrukt (ny runde eller utløpt token). forlatt: ubrukt token erstattet av et annet SK (H eller ' +
    'avbrutt). skrevet_g/skrevet_r: godkjent skriving. omskrevet_i_okt: SK-et var allerede skrevet i ' +
    'samme arbeidsøkt.',
  labelNames: ['kravnummer', 'suksesskriterium_id', 'hendelse'] as const,
  registers: [registry],
});

// --- Arbeidsøkter (én bruker × ett dokument, se mcp/workSessionTracker.ts) ---
// Observeres når økta avsluttes. Siden skriving skjer ett SK om gangen, er dette målet
// for hvor mye man godkjenner og dokumenterer i én runde.

export const workSessionKrav = new Histogram({
  name: 'etterlevelse_work_session_krav',
  help: 'Antall ulike krav med minst én godkjent SK-skriving eller krav-status per arbeidsøkt',
  labelNames: ['end_reason'] as const,
  buckets: [1, 2, 3, 5, 8, 13, 20, 30, 50],
  registers: [registry],
});

export const workSessionSuksesskriterier = new Histogram({
  name: 'etterlevelse_work_session_suksesskriterier',
  help: 'Antall ulike suksesskriterier skrevet (G/R) per arbeidsøkt',
  labelNames: ['end_reason'] as const,
  buckets: [1, 2, 3, 5, 10, 20, 40, 80, 150],
  registers: [registry],
});

export const workSessionDurationSeconds = new Histogram({
  name: 'etterlevelse_work_session_duration_seconds',
  help: 'Tid fra første til siste aktivitet i en arbeidsøkt med minst én skriving',
  labelNames: ['end_reason'] as const,
  buckets: [60, 300, 900, 1800, 3600, 7200, 14400, 28800],
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
