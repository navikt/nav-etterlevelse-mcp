import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { McpTokenData } from './store.js';

const MAX_BEARER_LENGTH = 16 * 1024;
const INTROSPECTION_TIMEOUT_MS = 5_000;

export interface GatewayLocals {
  tokenData: McpTokenData;
  navIdent: string;
}

export interface GatewayAuthOptions {
  introspectionEndpoint?: string;
  gatewayClientId?: string | null;
}

interface IntrospectionResponse {
  active?: boolean;
  idtyp?: string;
  roles?: unknown;
  NAVident?: unknown;
  azp?: unknown;
  preferred_username?: unknown;
  name?: unknown;
  groups?: unknown;
  exp?: unknown;
}

class GatewayAuthError extends Error {
  constructor(
    public readonly status: 401 | 403 | 502 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader || authorizationHeader.length > MAX_BEARER_LENGTH) {
    return null;
  }
  const spaceIdx = authorizationHeader.indexOf(' ');
  if (spaceIdx <= 0) {
    return null;
  }
  const scheme = authorizationHeader.slice(0, spaceIdx);
  if (scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  const token = authorizationHeader.slice(spaceIdx + 1).trim();
  if (!token || /[\s\r\n]/.test(token)) {
    return null;
  }
  return token;
}

/**
 * Henter fleet-gateway sin Entra clientId i gjeldende cluster fra AZURE_APP_PRE_AUTHORIZED_APPS.
 * Feiler lukket (returnerer null) ved manglende cluster, null eller flere treff, og kaster ved
 * ugyldig JSON.
 */
export function getGatewayClientId(
  raw: string | undefined = process.env.AZURE_APP_PRE_AUTHORIZED_APPS,
  cluster: string | undefined = process.env.NAIS_CLUSTER_NAME,
): string | null {
  const trimmedCluster = cluster?.trim() ?? '';
  const trimmedRaw = raw?.trim() ?? '';
  if (!trimmedRaw || !trimmedCluster) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedRaw);
  } catch {
    throw new Error('Kunne ikke tolke AZURE_APP_PRE_AUTHORIZED_APPS som JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('AZURE_APP_PRE_AUTHORIZED_APPS må være en JSON-liste');
  }

  const expectedName = `${trimmedCluster}:copilot:fleet-gateway`;
  const matches: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const { name, clientId } = entry as { name?: unknown; clientId?: unknown };
    if (name === expectedName && typeof clientId === 'string' && clientId.trim() !== '') {
      matches.push(clientId.trim());
    }
  }

  return matches.length === 1 ? matches[0]! : null;
}

export async function introspectGatewayToken(
  token: string,
  introspectionEndpoint: string,
  gatewayClientId: string,
): Promise<{ tokenData: McpTokenData; navIdent: string }> {
  let response: globalThis.Response;
  try {
    response = await fetch(introspectionEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        identity_provider: 'entra_id',
        token,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
    });
  } catch {
    throw new GatewayAuthError(502, 'bad_gateway', 'Texas token introspection request failed');
  }

  if (!response.ok) {
    throw new GatewayAuthError(502, 'bad_gateway', `Texas introspection returned status ${response.status}`);
  }

  let claims: IntrospectionResponse;
  try {
    claims = (await response.json()) as IntrospectionResponse;
  } catch {
    throw new GatewayAuthError(502, 'bad_gateway', 'Invalid JSON from Texas introspection');
  }

  if (claims.active !== true) {
    throw new GatewayAuthError(401, 'unauthorized', 'Inactive or expired token');
  }

  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  if (
    (typeof claims.idtyp === 'string' && claims.idtyp.toLowerCase() === 'app') ||
    roles.includes('access_as_application')
  ) {
    throw new GatewayAuthError(403, 'forbidden', 'Application tokens are not accepted');
  }

  const navIdent = typeof claims.NAVident === 'string' ? claims.NAVident.trim() : '';
  if (!navIdent) {
    throw new GatewayAuthError(403, 'forbidden', 'Missing NAVident claim');
  }

  const azp = typeof claims.azp === 'string' ? claims.azp : '';
  if (!safeEqual(azp, gatewayClientId)) {
    throw new GatewayAuthError(403, 'forbidden', 'Token azp does not match fleet-gateway');
  }

  const userEmail =
    typeof claims.preferred_username === 'string' && claims.preferred_username.trim()
      ? claims.preferred_username.trim()
      : navIdent;
  const userName =
    typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : navIdent;
  const userGroups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const azureExpiresAt =
    typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : Date.now() + 3600 * 1000;

  return {
    navIdent,
    tokenData: {
      userToken: token,
      refreshToken: null,
      azureExpiresAt,
      userEmail,
      userName,
      userGroups,
    },
  };
}

function sendGatewayAuthError(res: Response, status: number, error: string, description: string): void {
  if (status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="nav-etterlevelse-mcp"');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error, error_description: description });
}

export function createGatewayAuthMiddleware(options?: GatewayAuthOptions) {
  return async function requireGatewayBearerToken(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      sendGatewayAuthError(res, 401, 'unauthorized', 'Missing or malformed Bearer token');
      return;
    }

    const introspectionEndpoint =
      options?.introspectionEndpoint?.trim() ??
      process.env.NAIS_TOKEN_INTROSPECTION_ENDPOINT?.trim() ??
      '';

    let gatewayClientId: string | null;
    try {
      gatewayClientId =
        options?.gatewayClientId !== undefined ? options.gatewayClientId : getGatewayClientId();
    } catch {
      console.log('Gateway auth configuration error: invalid AZURE_APP_PRE_AUTHORIZED_APPS');
      sendGatewayAuthError(res, 503, 'service_unavailable', 'Gateway authentication is not configured');
      return;
    }

    if (!introspectionEndpoint || !gatewayClientId) {
      sendGatewayAuthError(res, 503, 'service_unavailable', 'Gateway authentication is not configured');
      return;
    }

    try {
      const { tokenData, navIdent } = await introspectGatewayToken(
        token,
        introspectionEndpoint,
        gatewayClientId,
      );
      const locals = res.locals as GatewayLocals;
      locals.tokenData = tokenData;
      locals.navIdent = navIdent;
      next();
    } catch (error) {
      if (error instanceof GatewayAuthError) {
        if (error.status === 502) {
          console.log('Texas introspection failed:', error.message);
        }
        sendGatewayAuthError(res, error.status, error.code, error.message);
        return;
      }
      console.log('Unexpected gateway auth error:', error);
      sendGatewayAuthError(res, 502, 'bad_gateway', 'Failed to validate token');
    }
  };
}
