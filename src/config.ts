const ETTERLEVELSE_SCOPE =
  process.env.ETTERLEVELSE_SCOPE ??
  'api://prod-gcp.teamdatajegerne.etterlevelse-backend/.default';
const BEHANDLINGSKATALOG_SCOPE =
  process.env.BEHANDLINGSKATALOG_SCOPE ??
  'api://prod-gcp.teamdatajegerne.behandlingskatalog-backend/.default';
// Interne Kubernetes-serviceadresser (app-navn fra Azure-scope: api://prod-gcp.{namespace}.{app}/.default).
// Overstyr med env-variabler hvis tjenestenavnene avviker fra scope-navnene.
const ETTERLEVELSE_API_BASE_URL =
  process.env.ETTERLEVELSE_API_BASE_URL ?? 'http://etterlevelse-backend.teamdatajegerne/api';
const BEHANDLINGSKATALOG_API_BASE_URL =
  process.env.BEHANDLINGSKATALOG_API_BASE_URL ?? 'http://behandlingskatalog-backend.teamkatalog/api';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export const config = {
  port: Number(process.env.PORT ?? '8080'),
  baseUrl: stripTrailingSlash(requireEnv('BASE_URL')),
  logLevel: process.env.LOG_LEVEL ?? 'INFO',
  azure: {
    clientId: requireEnv('AZURE_APP_CLIENT_ID'),
    clientSecret: requireEnv('AZURE_APP_CLIENT_SECRET'),
    tenantId: requireEnv('AZURE_APP_TENANT_ID'),
    tokenEndpoint: requireEnv('AZURE_OPENID_CONFIG_TOKEN_ENDPOINT'),
    issuer: requireEnv('AZURE_OPENID_CONFIG_ISSUER'),
    etterlevelseScope: ETTERLEVELSE_SCOPE,
    behandlingskatalogScope: BEHANDLINGSKATALOG_SCOPE,
  },
  api: {
    etterlevelseBaseUrl: ETTERLEVELSE_API_BASE_URL,
    behandlingskatalogBaseUrl: BEHANDLINGSKATALOG_API_BASE_URL,
  },
} as const;

export const mcpServerInfo = {
  name: 'nav-etterlevelse-mcp',
  version: '0.1.0',
} as const;

export const mcpAccessTokenTtlSeconds = 60 * 60;
export const mcpRefreshTokenTtlSeconds = 24 * 60 * 60;
export const authCodeTtlSeconds = 10 * 60;
export const authSessionTtlSeconds = 10 * 60;
export const deviceCodeTtlSeconds = 10 * 60;
export const deviceCodePollIntervalSeconds = 5;
export const mcpScope = 'mcp';

export function getAzureAuthorizeEndpoint(): string {
  return `https://login.microsoftonline.com/${config.azure.tenantId}/oauth2/v2.0/authorize`;
}

export function getOAuthCallbackUrl(): string {
  return `${config.baseUrl}/oauth/callback`;
}
