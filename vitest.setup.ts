// Setter dummy-verdier for de miljøvariablene src/config.ts krever ved import.
// Kjøres av vitest før testfiler lastes — se vitest.config.ts (setupFiles).
process.env.BASE_URL ??= 'https://test.local';
process.env.AZURE_APP_CLIENT_ID ??= 'test-client-id';
process.env.AZURE_APP_CLIENT_SECRET ??= 'test-client-secret';
process.env.AZURE_APP_TENANT_ID ??= 'test-tenant-id';
process.env.AZURE_OPENID_CONFIG_TOKEN_ENDPOINT ??= 'https://test.local/token';
process.env.AZURE_OPENID_CONFIG_ISSUER ??= 'https://test.local/issuer';
