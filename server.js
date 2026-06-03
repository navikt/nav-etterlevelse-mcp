import http from 'http';

// Minimal HTTP-server. Formålet med denne appen er Azure AD-registrering via NAIS
// slik at den lokale etterlevelse-brokeren (navikt/dab-copilot-config) kan bruke
// OAuth2 device-code-flyt mot etterlevelse-api.intern.nav.no.
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}).listen(8080, () => console.log('Listening on :8080'));
