import express, { type NextFunction, type Request, type Response } from 'express';
import { createGatewayAuthMiddleware, type GatewayLocals } from './auth/gateway.js';
import { requireMcpBearerToken, type AuthenticatedLocals } from './auth/middleware.js';
import { registerOAuthRoutes } from './auth/oauth.js';
import { config } from './config.js';
import { handleGatewayMcpRequest, handleMcpHttpRequest } from './mcp/server.js';
import { registry } from './metrics.js';
import { initUnleash } from './unleash.js';

void initUnleash();

const app = express();

// NAIS kjører bak en ingress som legger til X-Forwarded-For.
// trust proxy=1 betyr at Express stoler på første proxy-hopp (NAIS-ingressen)
// slik at express-rate-limit bruker riktig klient-IP, ikke proxy-IP.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

registerOAuthRoutes(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/metrics', (_req, res, next) => {
  Promise.resolve(registry.metrics())
    .then((m) => {
      res.set('Content-Type', registry.contentType);
      res.send(m);
    })
    .catch(next);
});

const mcpHandler = async (req: Request, res: Response): Promise<void> => {
  const { tokenData, mcpAccessToken } = res.locals as AuthenticatedLocals;
  await handleMcpHttpRequest(req, res, { tokenData, mcpAccessToken });
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

const requireGatewayBearerToken = createGatewayAuthMiddleware();

app.post('/mcp/gw', requireGatewayBearerToken, (req, res, next) => {
  const { tokenData } = res.locals as GatewayLocals;
  void handleGatewayMcpRequest(req, res, tokenData).catch(next);
});

app.get('/mcp/gw', requireGatewayBearerToken, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'method_not_allowed' });
});

app.delete('/mcp/gw', requireGatewayBearerToken, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'method_not_allowed' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: number }).status === 400
  ) {
    if (req.path === '/mcp/gw') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    res.status(400).json({ error: 'invalid_json', message: 'Invalid JSON request body' });
    return;
  }

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
