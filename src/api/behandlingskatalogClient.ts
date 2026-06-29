import { config } from '../config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function extractArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (!isRecord(payload)) {
    return [];
  }

  for (const key of ['content', 'items', 'data', 'results']) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate as T[];
    }
  }

  return [];
}

function extractStringArray(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry];
        }
        if (typeof entry === 'number') {
          return [String(entry)];
        }
        if (isRecord(entry)) {
          return [
            asString(entry.name),
            asString(entry.navn),
            asString(entry.shortName),
            asString(entry.number),
          ].filter((item): item is string => Boolean(item));
        }
        return [];
      })
      .filter(Boolean);
  }

  if (isRecord(value)) {
    return extractStringArray(Object.values(value));
  }

  const text = asString(value);
  return text ? [text] : [];
}

function matches(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

export class BehandlingskatalogClient {
  constructor(
    private readonly accessToken: string | null,
    private readonly baseUrl: string = config.api.behandlingskatalogBaseUrl,
  ) {}

  private async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    if (!this.accessToken) {
      throw new Error('Behandlingskatalog-token ikke tilgjengelig. Legg til nav-etterlevelse-mcp i inbound access policy for behandlingskatalog-backend.');
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    const bodyText = await response.text();
    let payload: unknown = null;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = bodyText;
      }
    }

    if (!response.ok) {
      throw new Error(`Behandlingskatalog API svarte ${response.status}: ${bodyText}`);
    }

    return payload;
  }

  async searchBehandlinger(search: string): Promise<unknown[]> {
    // Skill-gotcha: bruk dedikert søkeendepunkt — ikke hent alle og filtrer client-side
    const payload = await this.get(`/process/search/${encodeURIComponent(search)}`);

    const items = extractArray<Record<string, unknown>>(payload);
    return items.map((item) => ({
      id: asString(item.id) ?? '',
      number: asString(item.number) ?? '',
      name: asString(item.name) ?? asString(item.navn) ?? 'Uten navn',
      purposes: extractStringArray(item.purposes ?? item.formaal),
      status: asString(item.status) ?? '',
    }));
  }

  async getBehandling(id: string): Promise<unknown> {
    if (/^B\d+$/i.test(id.trim())) {
      // Skill-gotcha: bruk søkeendepunkt for B-nummer-oppslag — ikke hent alle og filtrer
      const payload = await this.get(`/process/search/${encodeURIComponent(id.trim())}`);
      const items = extractArray<Record<string, unknown>>(payload);
      const match = items.find((item) => asString(item.number)?.toLowerCase() === id.toLowerCase());
      if (!match) {
        throw new Error(`Fant ikke behandling med nummer ${id}`);
      }

      const processId = asString(match.id);
      if (!processId) {
        throw new Error(`Fant behandling ${id}, men mangler UUID i API-responsen`);
      }

      const fullPayload = await this.get(`/process/${processId}`);
      return isRecord(fullPayload) ? this.mapBehandling(fullPayload) : fullPayload;
    }

    const payload = await this.get(`/process/${id}`);
    if (!isRecord(payload)) {
      return payload;
    }

    return this.mapBehandling(payload);
  }

  async getProcessor(id: string): Promise<unknown> {
    const payload = await this.get(`/processor/${id}`);
    if (!isRecord(payload)) {
      return payload;
    }

    const mapped = {
      id: asString(payload.id) ?? id,
      name: asString(payload.name) ?? asString(payload.navn),
      contract: payload.contract ?? payload.dataProcessorAgreement ?? null,
      contractOwner: payload.contractOwner ?? null,
      operationalContractManagers: payload.operationalContractManagers ?? [],
      note: payload.note ?? payload.notes ?? null,
      outsideEU: payload.outsideEU ?? payload.outsideEu ?? false,
      raw: payload,
    };

    return mapped;
  }

  private mapBehandling(payload: Record<string, unknown>): Record<string, unknown> {
    return {
      id: asString(payload.id) ?? null,
      number: asString(payload.number) ?? null,
      name: asString(payload.name) ?? asString(payload.navn) ?? null,
      purposes: payload.purposes ?? payload.formaal ?? [],
      legalBases: payload.legalBases ?? payload.legalBasis ?? [],
      policies: payload.policies ?? [],
      retention: payload.retention ?? null,
      dataProcessing: payload.dataProcessing ?? payload.dataBehandling ?? null,
      dpia: payload.dpia ?? null,
      raw: payload,
    };
  }
}
