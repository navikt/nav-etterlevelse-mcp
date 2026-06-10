import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  authCodeTtlSeconds,
  config,
  getAzureAuthorizeEndpoint,
  getOAuthCallbackUrl,
  mcpAccessTokenTtlSeconds,
  mcpRefreshTokenTtlSeconds,
  mcpScope,
} from '../config.js';
import { type AuthCodeRecord, authStore, type McpTokenData } from './store.js';

interface AzureTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

interface JwtClaims {
  name?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
  unique_name?: string;
  groups?: string[];
}

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }

  return typeof value === 'string' ? value : undefined;
}

function bodyString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[key];
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }

  return typeof value === 'string' ? value : undefined;
}

function bodyStringArray(body: unknown, key: string): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const value = (body as Record<string, unknown>)[key];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

function setNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function setCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST');
}

function sendJsonError(res: Response, status: number, error: string, errorDescription: string): void {
  setNoStore(res);
  res.status(status).json({ error, error_description: errorDescription });
}

function redirectClientError(
  res: Response,
  redirectUri: string,
  state: string | undefined,
  error: string,
  errorDescription: string,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  target.searchParams.set('error_description', errorDescription);
  if (state) {
    target.searchParams.set('state', state);
  }
  res.redirect(302, target.toString());
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function calculateAzureExpiry(expiresInSeconds?: number): number {
  return Date.now() + Math.max((expiresInSeconds ?? 3600) - 60, 60) * 1000;
}

function parseJwtClaims(token: string | undefined): JwtClaims {
  if (!token) {
    return {};
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as JwtClaims;
  } catch {
    return {};
  }
}

function getUserIdentity(tokenResponse: AzureTokenResponse): Pick<McpTokenData, 'userEmail' | 'userName' | 'userGroups'> {
  const claims = parseJwtClaims(tokenResponse.id_token ?? tokenResponse.access_token);
  return {
    userEmail:
      claims.preferred_username ?? claims.email ?? claims.upn ?? claims.unique_name ?? 'ukjent@nav.no',
    userName: claims.name ?? claims.preferred_username ?? 'Ukjent bruker',
    userGroups: Array.isArray(claims.groups) ? claims.groups : [],
  };
}

function buildAuthorizationServerMetadata() {
  return {
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [mcpScope],
  };
}

function buildProtectedResourceMetadata() {
  return {
    resource: `${config.baseUrl}/mcp`,
    authorization_servers: [config.baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: [mcpScope],
  };
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const digest = createHash('sha256').update(codeVerifier).digest('base64url');
  return digest === codeChallenge;
}

async function exchangeAzureToken(params: URLSearchParams): Promise<AzureTokenResponse> {
  const response = await fetch(config.azure.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params,
  });

  const responseText = await response.text();
  let payload: unknown = undefined;
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = responseText;
  }

  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error(
      `Azure token exchange failed (${response.status}): ${
        typeof payload === 'string' ? payload : JSON.stringify(payload)
      }`,
    );
  }

  return payload as AzureTokenResponse;
}

export async function ensureFreshAzureTokens(tokenData: McpTokenData): Promise<void> {
  if (tokenData.azureExpiresAt > Date.now() + 60_000) {
    return;
  }

  const etterlevelseTokenResponse = await exchangeAzureToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refreshToken,
      client_id: config.azure.clientId,
      client_secret: config.azure.clientSecret,
      scope: config.azure.etterlevelseScope,
    }),
  );

  const latestRefreshToken = etterlevelseTokenResponse.refresh_token ?? tokenData.refreshToken;
  const behandlingskatalogTokenResponse = await exchangeAzureToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: latestRefreshToken,
      client_id: config.azure.clientId,
      client_secret: config.azure.clientSecret,
      scope: config.azure.behandlingskatalogScope,
    }),
  );

  tokenData.etterlevelseToken = etterlevelseTokenResponse.access_token;
  tokenData.bkToken = behandlingskatalogTokenResponse.access_token;
  tokenData.refreshToken = behandlingskatalogTokenResponse.refresh_token ?? latestRefreshToken;
  tokenData.azureExpiresAt = calculateAzureExpiry(etterlevelseTokenResponse.expires_in);
}

function buildAuthCodeRecord(
  session: {
    clientId: string;
    clientState?: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
  },
  mcpAccessToken: string,
  mcpRefreshToken: string,
): AuthCodeRecord {
  return {
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    clientState: session.clientState,
    codeChallenge: session.codeChallenge,
    codeChallengeMethod: session.codeChallengeMethod,
    mcpAccessToken,
    mcpRefreshToken,
  };
}

export function registerOAuthRoutes(app: Express): void {
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    setNoStore(res);
    res.json(buildAuthorizationServerMetadata());
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    setNoStore(res);
    res.json(buildProtectedResourceMetadata());
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    setNoStore(res);
    res.json(buildProtectedResourceMetadata());
  });

  app.options('/register', (_req, res) => {
    setCors(res);
    res.sendStatus(204);
  });

  app.post('/register', (req, res) => {
    setCors(res);
    setNoStore(res);

    const redirectUris = bodyStringArray(req.body, 'redirect_uris');
    if (redirectUris.length === 0) {
      sendJsonError(res, 400, 'invalid_client_metadata', 'redirect_uris is required');
      return;
    }

    const clientName = bodyString(req.body, 'client_name');
    const tokenEndpointAuthMethod = bodyString(req.body, 'token_endpoint_auth_method');
    if (tokenEndpointAuthMethod && tokenEndpointAuthMethod !== 'none') {
      sendJsonError(res, 400, 'invalid_client_metadata', 'Only public clients are supported');
      return;
    }

    const client = authStore.registerClient({ clientName, redirectUris });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: client.clientIdIssuedAt,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    });
  });

  app.get('/oauth/authorize', (req, res) => {
    const responseType = firstQueryValue(req.query.response_type);
    const clientId = firstQueryValue(req.query.client_id);
    const redirectUri = firstQueryValue(req.query.redirect_uri);
    const clientState = firstQueryValue(req.query.state);
    const codeChallenge = firstQueryValue(req.query.code_challenge);
    const codeChallengeMethod = firstQueryValue(req.query.code_challenge_method);

    if (!clientId || !redirectUri) {
      sendJsonError(res, 400, 'invalid_request', 'client_id and redirect_uri are required');
      return;
    }

    const client = authStore.getClient(clientId);
    if (!client || !authStore.isRedirectUriAllowed(clientId, redirectUri)) {
      sendJsonError(res, 400, 'invalid_client', 'Unknown client or redirect_uri');
      return;
    }

    if (responseType !== 'code') {
      redirectClientError(res, redirectUri, clientState, 'unsupported_response_type', 'Only code is supported');
      return;
    }

    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      redirectClientError(res, redirectUri, clientState, 'invalid_request', 'PKCE with S256 is required');
      return;
    }

    const internalState = randomToken();
    authStore.saveAuthSession(internalState, {
      clientId,
      clientState,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
    });

    const azureAuthorizeUrl = new URL(getAzureAuthorizeEndpoint());
    azureAuthorizeUrl.searchParams.set('client_id', config.azure.clientId);
    azureAuthorizeUrl.searchParams.set('response_type', 'code');
    azureAuthorizeUrl.searchParams.set('redirect_uri', getOAuthCallbackUrl());
    azureAuthorizeUrl.searchParams.set('scope', config.azure.etterlevelseScope);
    azureAuthorizeUrl.searchParams.set('state', internalState);
    azureAuthorizeUrl.searchParams.set('code_challenge', codeChallenge);
    azureAuthorizeUrl.searchParams.set('code_challenge_method', 'S256');

    res.redirect(302, azureAuthorizeUrl.toString());
  });

  app.get('/oauth/callback', async (req, res) => {
    const authorizationCode = firstQueryValue(req.query.code);
    const internalState = firstQueryValue(req.query.state);
    const callbackError = firstQueryValue(req.query.error);
    const callbackErrorDescription = firstQueryValue(req.query.error_description);

    if (callbackError) {
      res.status(400).send(`OAuth callback failed: ${callbackErrorDescription ?? callbackError}`);
      return;
    }

    if (!authorizationCode || !internalState) {
      sendJsonError(res, 400, 'invalid_request', 'Missing code or state');
      return;
    }

    const session = authStore.consumeAuthSession(internalState);
    if (!session) {
      sendJsonError(res, 400, 'invalid_request', 'Unknown or expired authorization session');
      return;
    }

    try {
      const etterlevelseTokenResponse = await exchangeAzureToken(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: authorizationCode,
          redirect_uri: getOAuthCallbackUrl(),
          client_id: config.azure.clientId,
          client_secret: config.azure.clientSecret,
          scope: config.azure.etterlevelseScope,
        }),
      );

      if (!etterlevelseTokenResponse.refresh_token) {
        throw new Error('Azure AD did not return a refresh token');
      }

      const behandlingskatalogTokenResponse = await exchangeAzureToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: etterlevelseTokenResponse.refresh_token,
          client_id: config.azure.clientId,
          client_secret: config.azure.clientSecret,
          scope: config.azure.behandlingskatalogScope,
        }),
      );

      const tokenData: McpTokenData = {
        etterlevelseToken: etterlevelseTokenResponse.access_token,
        bkToken: behandlingskatalogTokenResponse.access_token,
        refreshToken:
          behandlingskatalogTokenResponse.refresh_token ?? etterlevelseTokenResponse.refresh_token,
        azureExpiresAt: calculateAzureExpiry(etterlevelseTokenResponse.expires_in),
        ...getUserIdentity(etterlevelseTokenResponse),
      };

      const mcpAccessToken = randomToken();
      const mcpRefreshToken = randomToken();
      const mcpAuthorizationCode = randomToken();

      authStore.saveMcpSession(mcpAccessToken, mcpRefreshToken, session.clientId, tokenData);
      authStore.saveAuthCode(
        mcpAuthorizationCode,
        buildAuthCodeRecord(session, mcpAccessToken, mcpRefreshToken),
      );

      const redirectTarget = new URL(session.redirectUri);
      redirectTarget.searchParams.set('code', mcpAuthorizationCode);
      if (session.clientState) {
        redirectTarget.searchParams.set('state', session.clientState);
      }

      res.redirect(302, redirectTarget.toString());
    } catch (error) {
      console.error('OAuth callback error', error);
      res.status(500).send('Kunne ikke fullføre OAuth-innloggingen');
    }
  });

  app.options('/oauth/token', (_req, res) => {
    setCors(res);
    res.sendStatus(204);
  });

  app.post('/oauth/token', async (req, res) => {
    setCors(res);
    setNoStore(res);

    const grantType = bodyString(req.body, 'grant_type');
    const clientId = bodyString(req.body, 'client_id');

    if (!grantType) {
      sendJsonError(res, 400, 'invalid_request', 'grant_type is required');
      return;
    }

    if (!clientId || !authStore.getClient(clientId)) {
      sendJsonError(res, 400, 'invalid_client', 'Unknown client_id');
      return;
    }

    if (grantType === 'authorization_code') {
      const code = bodyString(req.body, 'code');
      const redirectUri = bodyString(req.body, 'redirect_uri');
      const codeVerifier = bodyString(req.body, 'code_verifier');

      if (!code || !redirectUri || !codeVerifier) {
        sendJsonError(res, 400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
        return;
      }

      const authCode = authStore.consumeAuthCode(code);
      if (!authCode) {
        sendJsonError(res, 400, 'invalid_grant', 'Unknown or expired authorization code');
        return;
      }

      if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
        sendJsonError(res, 400, 'invalid_grant', 'Authorization code does not match client');
        return;
      }

      if (!verifyPkce(codeVerifier, authCode.codeChallenge)) {
        sendJsonError(res, 400, 'invalid_grant', 'PKCE verification failed');
        return;
      }

      const tokenData = authStore.getMcpToken(authCode.mcpAccessToken);
      const refreshTokenRecord = authStore.getRefreshToken(authCode.mcpRefreshToken);
      if (!tokenData || !refreshTokenRecord) {
        sendJsonError(res, 400, 'invalid_grant', 'Authorization code is no longer valid');
        return;
      }

      res.json({
        access_token: authCode.mcpAccessToken,
        token_type: 'Bearer',
        expires_in: mcpAccessTokenTtlSeconds,
        refresh_token: authCode.mcpRefreshToken,
        refresh_token_expires_in: mcpRefreshTokenTtlSeconds,
        scope: mcpScope,
      });
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = bodyString(req.body, 'refresh_token');
      if (!refreshToken) {
        sendJsonError(res, 400, 'invalid_request', 'refresh_token is required');
        return;
      }

      const refreshTokenRecord = authStore.getRefreshToken(refreshToken);
      if (!refreshTokenRecord) {
        sendJsonError(res, 400, 'invalid_grant', 'Unknown or expired refresh token');
        return;
      }

      if (refreshTokenRecord.clientId !== clientId) {
        sendJsonError(res, 400, 'invalid_grant', 'Refresh token does not belong to the client');
        return;
      }

      try {
        await ensureFreshAzureTokens(refreshTokenRecord.tokenData);
      } catch (error) {
        console.error('Failed to refresh Azure tokens during MCP refresh', error);
        sendJsonError(res, 502, 'server_error', 'Could not refresh upstream Azure tokens');
        return;
      }

      authStore.deleteRefreshToken(refreshToken);

      const newAccessToken = randomToken();
      const newRefreshToken = randomToken();
      authStore.saveMcpSession(
        newAccessToken,
        newRefreshToken,
        clientId,
        refreshTokenRecord.tokenData,
      );

      res.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: mcpAccessTokenTtlSeconds,
        refresh_token: newRefreshToken,
        refresh_token_expires_in: mcpRefreshTokenTtlSeconds,
        scope: mcpScope,
      });
      return;
    }

    sendJsonError(res, 400, 'unsupported_grant_type', `Unsupported grant type ${grantType}`);
  });
}
