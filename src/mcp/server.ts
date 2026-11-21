import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BehandlingskatalogClient } from '../api/behandlingskatalogClient.js';
import { EtterlevelseClient } from '../api/etterlevelseClient.js';
import { NavetClient } from '../api/navetClient.js';
import { config, mcpServerInfo } from '../config.js';
import { type McpTokenData } from '../auth/store.js';
import { texasOboErrorsTotal, upstreamErrorsTotal, mcpActiveSessions } from '../metrics.js';
import { handleStatelessMcpRequest, type StatelessMcpServerBundle } from './mcp2026.js';
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
      texasOboErrorsTotal.inc();
      return null;
    }
    const data = await response.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (error) {
    console.log(`Texas OBO exchange error for ${targetScope}:`, error);
    texasOboErrorsTotal.inc();
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

/**
 * Øvre grense for antall array-elementer og objektnøkler i argumentene til ett verktøykall.
 * Tetter GHSA-46jr-4wx8-v453: uten grense kunne én forespørsel innenfor størrelsesgrensen bruke
 * opp minnet under validering. Den største inputen vi har, er lister med ID-er (under 50 elementer
 * i praksis). Filvedlegg er base64-strenger og teller ikke. Et kall over grensen får isError: true.
 * Størrelsesgrensen på selve forespørselen settes i express.json() i index.ts.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 1_000;

export function createMcpServer(ctx: SessionContext, behandlingskatalogClient: BehandlingskatalogClient, navetClient: NavetClient | null): McpServer {
  const server = new McpServer(mcpServerInfo, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });

  registerEtterlevelseTools(server, ctx);
  registerBehandlingskatalogTools(server, behandlingskatalogClient);
  if (navetClient) {
    registerNavetTools(server, navetClient);
  }

  return server;
}

/**
 * Oppretter en McpServer for gateway-stien (/mcp/gw) der kun leseverktøy (readOnlyHint === true)
 * registreres. Skriveverktøy og lock_document filtreres bort ved registrering slik at de verken
 * vises i tools/list eller kan kalles via gatewayen.
 */
export function createGatewayMcpServer(
  ctx: SessionContext,
  behandlingskatalogClient: BehandlingskatalogClient,
  navetClient: NavetClient | null,
): StatelessMcpServerBundle {
  const server = new McpServer(mcpServerInfo, { maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS });
  const allowedToolNames = new Set<string>();
  const blockedWriteToolNames = new Set<string>();

  const originalRegisterTool = server.registerTool.bind(server);
  const filteringServer = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (name: string, toolConfig: any, handler: any) => {
          if (toolConfig?.annotations?.readOnlyHint === true) {
            allowedToolNames.add(name);
            return originalRegisterTool(name, toolConfig, handler);
          }
          blockedWriteToolNames.add(name);
          return undefined;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  registerEtterlevelseTools(filteringServer, ctx);
  registerBehandlingskatalogTools(filteringServer, behandlingskatalogClient);
  if (navetClient) {
    registerNavetTools(filteringServer, navetClient);
  }

  return { server, allowedToolNames, blockedWriteToolNames };
}

export async function handleGatewayMcpRequest(
  req: Request,
  res: Response,
  tokenData: McpTokenData,
): Promise<void> {
  const userToken = tokenData.userToken;

  const placeholderCtx: SessionContext = {
    tokenData,
    mcpAccessToken: '',
    etterlevelseClient: new EtterlevelseClient(''),
  };

  mcpActiveSessions.inc();
  try {
    // Registrer verktøykatalogen uten å veksle nedstrømstokens på forhånd, slik at
    // server/discover, tools/list og header-validering ikke avhenger av Texas OBO.
    const bundle = createGatewayMcpServer(
      placeholderCtx,
      new BehandlingskatalogClient(null),
      new NavetClient(''),
    );

    bundle.resolveServerForToolCall = async () => {
      const [etterlevelseToken, bkToken, navetToken] = await Promise.all([
        exchangeViaTexas(userToken, config.azure.etterlevelseScope),
        exchangeViaTexas(userToken, config.azure.behandlingskatalogScope),
        getAppTokenViaTexas('https://graph.microsoft.com/.default'),
      ]);

      if (!etterlevelseToken) {
        return {
          ok: false,
          status: 502,
          message: 'Kunne ikke hente etterlevelse-token via Texas OBO',
        };
      }

      const liveCtx: SessionContext = {
        tokenData,
        mcpAccessToken: '',
        etterlevelseClient: new EtterlevelseClient(etterlevelseToken),
      };
      const liveBundle = createGatewayMcpServer(
        liveCtx,
        new BehandlingskatalogClient(bkToken),
        navetToken ? new NavetClient(navetToken) : null,
      );
      return { ok: true, server: liveBundle.server };
    };

    await handleStatelessMcpRequest(req, res, bundle);
  } catch (error) {
    console.log('Error while handling gateway MCP request', error);
    upstreamErrorsTotal.inc({ backend: 'mcp-server' });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  } finally {
    mcpActiveSessions.dec();
  }
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

  mcpActiveSessions.inc();

  const server = createMcpServer(ctx, behandlingskatalogClient, navetClient);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    mcpActiveSessions.dec();
    await Promise.allSettled([transport.close(), server.close()]);
  };

  res.on('close', () => { void cleanup(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.log('Error while handling MCP request', error);
    upstreamErrorsTotal.inc({ backend: 'mcp-server' });
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
