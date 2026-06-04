import type { NextFunction, Request, Response } from 'express';
import { ensureFreshAzureTokens } from './oauth.js';
import { authStore, type McpTokenData } from './store.js';

export interface AuthenticatedLocals {
  tokenData: McpTokenData;
  mcpAccessToken: string;
}

function unauthorized(res: Response, message: string): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="nav-etterlevelse-mcp"');
  res.status(401).json({ error: 'unauthorized', error_description: message });
}

export async function requireMcpBearerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authorizationHeader = req.headers.authorization;
  if (!authorizationHeader?.startsWith('Bearer ')) {
    unauthorized(res, 'Missing Bearer token');
    return;
  }

  const mcpAccessToken = authorizationHeader.slice('Bearer '.length).trim();
  const tokenData = authStore.getMcpToken(mcpAccessToken);
  if (!tokenData) {
    unauthorized(res, 'Unknown or expired MCP access token');
    return;
  }

  try {
    await ensureFreshAzureTokens(tokenData);
  } catch (error) {
    console.error('Failed to refresh Azure tokens for MCP request', error);
    if (tokenData.azureExpiresAt <= Date.now()) {
      unauthorized(res, 'Azure access token has expired');
      return;
    }
  }

  (res.locals as AuthenticatedLocals).tokenData = tokenData;
  (res.locals as AuthenticatedLocals).mcpAccessToken = mcpAccessToken;
  next();
}
