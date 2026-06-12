import { startUnleash, type Unleash } from 'unleash-client';

export const TOGGLE_WRITE_ENABLED = 'nav-etterlevelse-mcp.write-enabled';

let unleashInstance: Unleash | null = null;

export async function initUnleash(): Promise<void> {
  const url = process.env.UNLEASH_SERVER_API_URL;
  const token = process.env.UNLEASH_SERVER_API_TOKEN;

  if (!url || !token) {
    console.warn(
      'UNLEASH_SERVER_API_URL eller UNLEASH_SERVER_API_TOKEN mangler — feature-toggles deaktivert, alle writes tillatt.',
    );
    return;
  }

  unleashInstance = await startUnleash({
    url: `${url}/api`,
    appName: 'nav-etterlevelse-mcp',
    customHeaders: { Authorization: token },
  });
}

export function isWriteEnabled(): boolean {
  if (!unleashInstance) return true; // fallback: tillatt hvis Unleash ikke er konfigurert
  return unleashInstance.isEnabled(TOGGLE_WRITE_ENABLED);
}
