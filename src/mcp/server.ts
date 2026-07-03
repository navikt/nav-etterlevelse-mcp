import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BehandlingskatalogClient } from '../api/behandlingskatalogClient.js';
import { EtterlevelseClient } from '../api/etterlevelseClient.js';
import { NavetClient } from '../api/navetClient.js';
import { config, mcpServerInfo } from '../config.js';
import { type McpTokenData } from '../auth/store.js';
import { registerBehandlingskatalogTools } from './tools/behandlingskatalog.js';
import { registerEtterlevelseTools } from './tools/etterlevelse.js';
import { registerNavetTools } from './tools/navet.js';

export interface SessionContext {
  tokenData: McpTokenData;
  mcpAccessToken: string;
  etterlevelseClient: EtterlevelseClient;
}

/** Exchanger userToken via Texas OBO til et downstream-token. */
async function exchangeViaTexas(userToken: string, targetScope: string): Promise<string | null> {
  try {
    const response = await fetch(config.api.texasTokenExchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: targetScope,
        identity_provider: 'entra_id',
        user_token: userToken,
      }),
    });
    if (!response.ok) {
      console.log(`Texas OBO exchange failed for ${targetScope}:`, response.status, await response.text());
      return null;
    }
    const data = await response.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (error) {
    console.log(`Texas OBO exchange error for ${targetScope}:`, error);
    return null;
  }
}

/** Henter et app-token (client credentials / M2M) via Texas for tjenester som ikke bruker OBO. */
async function getAppTokenViaTexas(targetScope: string): Promise<string | null> {
  try {
    const response = await fetch(config.api.texasTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: targetScope,
        identity_provider: 'azuread',
      }),
    });
    if (!response.ok) {
      console.log(`Texas M2M token failed for ${targetScope}:`, response.status, await response.text());
      return null;
    }
    const data = await response.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (error) {
    console.log(`Texas M2M token error for ${targetScope}:`, error);
    return null;
  }
}

export function createMcpServer(ctx: SessionContext, behandlingskatalogClient: BehandlingskatalogClient, navetClient: NavetClient | null): McpServer {
  const server = new McpServer(mcpServerInfo);

  registerEtterlevelseTools(server, ctx);
  registerBehandlingskatalogTools(server, behandlingskatalogClient);
  if (navetClient) {
    registerNavetTools(server, navetClient);
  }

  return server;
}

export async function handleMcpHttpRequest(
  req: Request,
  res: Response,
  tokens: { tokenData: McpTokenData; mcpAccessToken: string },
): Promise<void> {
  const userToken = tokens.tokenData.userToken;

  // Exchange userToken via Texas OBO for downstream tokens
  const [etterlevelseToken, bkToken, navetToken] = await Promise.all([
    exchangeViaTexas(userToken, config.azure.etterlevelseScope),
    exchangeViaTexas(userToken, config.azure.behandlingskatalogScope),
    getAppTokenViaTexas('https://graph.microsoft.com/.default'),
  ]);

  if (!etterlevelseToken) {
    res.status(502).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Kunne ikke hente etterlevelse-token via Texas OBO' },
      id: null,
    });
    return;
  }

  const ctx: SessionContext = {
    tokenData: tokens.tokenData,
    mcpAccessToken: tokens.mcpAccessToken,
    etterlevelseClient: new EtterlevelseClient(etterlevelseToken),
  };

  const behandlingskatalogClient = new BehandlingskatalogClient(bkToken);
  const navetClient = navetToken ? new NavetClient(navetToken) : null;
  if (!navetClient) {
    console.log('Navet-token ikke tilgjengelig — list_navet_pages og get_navet_page er ikke aktive');
  }
  const server = createMcpServer(ctx, behandlingskatalogClient, navetClient);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.allSettled([transport.close(), server.close()]);
  };

  res.on('close', () => { void cleanup(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.log('Error while handling MCP request', error);
    await cleanup();
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}
