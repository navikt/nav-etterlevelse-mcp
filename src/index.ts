import express, { type NextFunction, type Request, type Response } from 'express';
import { requireMcpBearerToken, type AuthenticatedLocals } from './auth/middleware.js';
import { registerOAuthRoutes } from './auth/oauth.js';
import { config } from './config.js';
import { handleMcpHttpRequest } from './mcp/server.js';
import { initUnleash } from './unleash.js';

void initUnleash();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

registerOAuthRoutes(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const mcpHandler = async (req: Request, res: Response): Promise<void> => {
  const { tokenData, mcpAccessToken } = res.locals as AuthenticatedLocals;
  await handleMcpHttpRequest(req, res, {
    etterlevelseToken: tokenData.etterlevelseToken,
    bkToken: tokenData.bkToken,
    tokenData,
    mcpAccessToken,
  });
};

app.get('/mcp', requireMcpBearerToken, (req, res, next) => {
  void mcpHandler(req, res).catch(next);
});

app.post('/mcp', requireMcpBearerToken, (req, res, next) => {
  void mcpHandler(req, res).catch(next);
});

app.delete('/mcp', requireMcpBearerToken, (_req, res) => {
  res.status(204).end();
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.log('Unhandled application error', error);
  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    error: 'internal_server_error',
    message: error instanceof Error ? error.message : 'Unknown error',
  });
});

app.listen(config.port, () => {
  console.log(`nav-etterlevelse-mcp listening on :${config.port}`);
});
