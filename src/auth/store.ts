import { randomBytes } from 'node:crypto';
import {
  authCodeTtlSeconds,
  authSessionTtlSeconds,
  deviceCodeTtlSeconds,
  mcpAccessTokenTtlSeconds,
  mcpRefreshTokenTtlSeconds,
} from '../config.js';

export interface AuthSession {
  clientId: string;
  clientState?: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** Satt for device code-flyt. Etter Azure AD-callback lagres tokens under denne device_code. */
  deviceCode?: string;
}

export interface McpTokenData {
  etterlevelseToken: string;
  bkToken: string;
  refreshToken: string;
  azureExpiresAt: number;
  userEmail: string;
  userName: string;
  /** Entra ID gruppe-UUID-er fra groups-claim i Azure AD-token. Brukes for team-eiersjekk ved lock_document. */
  userGroups: string[];
  /** UUID for etterlevelseDokumentasjonen sesjonen er låst til for skriveoperasjoner. */
  lockedDocumentId?: string;
  /** UUID for PVK-dokumentet knyttet til låst etterlevelsesdokumentasjon, hvis det finnes. */
  lockedPvkDokumentId?: string;
  /** Tittel på det låste dokumentet — brukes i feilmeldinger. */
  lockedDocumentTitle?: string;
}

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
  clientIdIssuedAt: number;
}

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  mcpAccessToken: string;
  mcpRefreshToken: string;
}

export interface RefreshTokenRecord {
  clientId: string;
  tokenData: McpTokenData;
}

export interface DeviceAuthSession {
  clientId: string;
  userCode: string;
  status: 'pending' | 'complete';
  /** Satt når status blir 'complete' etter vellykket Azure AD-innlogging. */
  mcpAccessToken?: string;
  mcpRefreshToken?: string;
}

interface TimedEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory OAuth session store. All state lives in the Node.js process heap.
 *
 * Single-replica constraint: this store is not shared across pods. The
 * deployment (`.nais/app.yaml`) must keep `replicas.max: 1` to ensure every
 * request hits the same instance. To support horizontal scaling, replace this
 * class with a Redis/Valkey-backed implementation.
 */
class InMemoryAuthStore {
  private readonly authSessions = new Map<string, TimedEntry<AuthSession>>();
  private readonly authCodes = new Map<string, TimedEntry<AuthCodeRecord>>();
  private readonly mcpTokens = new Map<string, TimedEntry<McpTokenData>>();
  private readonly refreshTokens = new Map<string, TimedEntry<RefreshTokenRecord>>();
  private readonly clientRegistrations = new Map<string, ClientRegistration>();
  private readonly deviceAuthSessions = new Map<string, TimedEntry<DeviceAuthSession>>();
  /** user_code → device_code (hjelpeindeks for oppslag fra /device-siden) */
  private readonly deviceUserCodeIndex = new Map<string, string>();

  constructor() {
    const cleanupHandle = setInterval(() => this.cleanupExpiredEntries(), 5 * 60 * 1000);
    cleanupHandle.unref?.();
  }

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    const clientId = randomBytes(24).toString('base64url');
    const client: ClientRegistration = {
      clientId,
      clientName: input.clientName,
      redirectUris: [...input.redirectUris],
      grantTypes: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      clientIdIssuedAt: Math.floor(Date.now() / 1000),
    };

    this.clientRegistrations.set(clientId, client);
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clientRegistrations.get(clientId);
  }

  isRedirectUriAllowed(clientId: string, redirectUri: string): boolean {
    const client = this.clientRegistrations.get(clientId);
    return client ? client.redirectUris.includes(redirectUri) : false;
  }

  saveAuthSession(state: string, session: AuthSession): void {
    this.authSessions.set(state, this.withTtl(session, authSessionTtlSeconds));
  }

  consumeAuthSession(state: string): AuthSession | undefined {
    return this.takeValid(this.authSessions, state);
  }

  saveAuthCode(code: string, record: AuthCodeRecord): void {
    this.authCodes.set(code, this.withTtl(record, authCodeTtlSeconds));
  }

  consumeAuthCode(code: string): AuthCodeRecord | undefined {
    return this.takeValid(this.authCodes, code);
  }

  saveMcpSession(accessToken: string, refreshToken: string, clientId: string, tokenData: McpTokenData): void {
    this.mcpTokens.set(accessToken, this.withTtl(tokenData, mcpAccessTokenTtlSeconds));
    this.refreshTokens.set(
      refreshToken,
      this.withTtl({ clientId, tokenData }, mcpRefreshTokenTtlSeconds),
    );
  }

  getMcpToken(accessToken: string): McpTokenData | undefined {
    return this.getValid(this.mcpTokens, accessToken);
  }

  getRefreshToken(refreshToken: string): RefreshTokenRecord | undefined {
    return this.getValid(this.refreshTokens, refreshToken);
  }

  deleteRefreshToken(refreshToken: string): void {
    this.refreshTokens.delete(refreshToken);
  }

  deleteMcpToken(accessToken: string): void {
    this.mcpTokens.delete(accessToken);
  }

  updateMcpToken(accessToken: string, updates: Partial<McpTokenData>): boolean {
    const entry = this.mcpTokens.get(accessToken);
    if (!entry || entry.expiresAt <= Date.now()) {
      return false;
    }
    Object.assign(entry.value, updates);
    return true;
  }

  saveDeviceAuthSession(deviceCode: string, session: DeviceAuthSession): void {
    this.deviceAuthSessions.set(deviceCode, this.withTtl(session, deviceCodeTtlSeconds));
    this.deviceUserCodeIndex.set(session.userCode, deviceCode);
  }

  getDeviceAuthSession(deviceCode: string): DeviceAuthSession | undefined {
    return this.getValid(this.deviceAuthSessions, deviceCode);
  }

  getDeviceCodeByUserCode(userCode: string): string | undefined {
    const deviceCode = this.deviceUserCodeIndex.get(userCode);
    if (!deviceCode) return undefined;
    if (!this.getValid(this.deviceAuthSessions, deviceCode)) {
      this.deviceUserCodeIndex.delete(userCode);
      return undefined;
    }
    return deviceCode;
  }

  completeDeviceAuth(deviceCode: string, mcpAccessToken: string, mcpRefreshToken: string): void {
    const entry = this.deviceAuthSessions.get(deviceCode);
    if (entry && entry.expiresAt > Date.now()) {
      entry.value.status = 'complete';
      entry.value.mcpAccessToken = mcpAccessToken;
      entry.value.mcpRefreshToken = mcpRefreshToken;
    }
  }

  consumeDeviceAuth(deviceCode: string): void {
    const entry = this.deviceAuthSessions.get(deviceCode);
    if (entry) {
      this.deviceUserCodeIndex.delete(entry.value.userCode);
      this.deviceAuthSessions.delete(deviceCode);
    }
  }

  private withTtl<T>(value: T, ttlSeconds: number): TimedEntry<T> {
    return {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    this.cleanupMap(this.authSessions, now);
    this.cleanupMap(this.authCodes, now);
    this.cleanupMap(this.mcpTokens, now);
    this.cleanupMap(this.refreshTokens, now);
    for (const [deviceCode, entry] of this.deviceAuthSessions.entries()) {
      if (entry.expiresAt <= now) {
        this.deviceUserCodeIndex.delete(entry.value.userCode);
        this.deviceAuthSessions.delete(deviceCode);
      }
    }
  }

  private cleanupMap<T>(map: Map<string, TimedEntry<T>>, now: number): void {
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        map.delete(key);
      }
    }
  }

  private getValid<T>(map: Map<string, TimedEntry<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }

    return entry.value;
  }

  private takeValid<T>(map: Map<string, TimedEntry<T>>, key: string): T | undefined {
    const value = this.getValid(map, key);
    map.delete(key);
    return value;
  }
}

export const authStore = new InMemoryAuthStore();
