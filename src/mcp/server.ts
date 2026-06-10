import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BehandlingskatalogClient } from '../api/behandlingskatalogClient.js';
import { EtterlevelseClient } from '../api/etterlevelseClient.js';
import { GraphClient } from '../api/graphClient.js';
import { mcpServerInfo } from '../config.js';
import { authStore, type McpTokenData } from '../auth/store.js';
import { registerBehandlingskatalogTools } from './tools/behandlingskatalog.js';
import { registerEtterlevelseTools } from './tools/etterlevelse.js';

export interface SessionContext {
  tokenData: McpTokenData;
  mcpAccessToken: string;
  etterlevelseClient: EtterlevelseClient;
  graphClient: GraphClient;
}

export function createMcpServer(ctx: SessionContext): McpServer {
  const server = new McpServer(mcpServerInfo);
  const behandlingskatalogClient = new BehandlingskatalogClient(ctx.tokenData.bkToken);

  registerEtterlevelseTools(server, ctx);
  registerBehandlingskatalogTools(server, behandlingskatalogClient);

  return server;
}

export async function handleMcpHttpRequest(
  req: Request,
  res: Response,
  tokens: { etterlevelseToken: string; bkToken: string; tokenData: McpTokenData; mcpAccessToken: string },
): Promise<void> {
  const ctx: SessionContext = {
    tokenData: tokens.tokenData,
    mcpAccessToken: tokens.mcpAccessToken,
    etterlevelseClient: new EtterlevelseClient(tokens.etterlevelseToken),
    graphClient: new GraphClient(tokens.etterlevelseToken),
  };

  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    await Promise.allSettled([transport.close(), server.close()]);
  };

  res.on('close', () => {
    void cleanup();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error while handling MCP request', error);
    await cleanup();

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
}
