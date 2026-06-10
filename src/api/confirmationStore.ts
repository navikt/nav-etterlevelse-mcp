import { randomUUID } from 'crypto';

export interface SuksesskriterieBegrunnelse {
  suksesskriterieId: number;
  begrunnelse: string;
  suksesskriterieStatus: 'UNDER_ARBEID' | 'IKKE_RELEVANT' | 'IKKE_OPPFYLT';
}

export interface PendingWrite {
  etterlevelseDokumentasjonId: string;
  kravNummer: number;
  kravVersjon: number;
  status: 'UNDER_ARBEID' | 'IKKE_RELEVANT';
  statusBegrunnelse?: string;
  suksesskriterieBegrunnelser: SuksesskriterieBegrunnelse[];
  previewText: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;
const store = new Map<string, PendingWrite>();

function cleanup(): void {
  const now = Date.now();
  for (const [key, value] of store.entries()) {
    if (value.expiresAt < now) {
      store.delete(key);
    }
  }
}

export function storeConfirmation(data: Omit<PendingWrite, 'expiresAt'>): string {
  cleanup();
  const token = randomUUID();
  store.set(token, { ...data, expiresAt: Date.now() + TTL_MS });
  return token;
}

export function consumeConfirmation(token: string): PendingWrite | null {
  const entry = store.get(token);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return null;
  }

  store.delete(token);
  return entry;
}
