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
      .flatMap((item) => {
        if (typeof item === 'string') {
          return [item];
        }
        if (typeof item === 'number') {
          return [String(item)];
        }
        if (isRecord(item)) {
          return [
            asString(item.name),
            asString(item.navn),
            asString(item.team),
            asString(item.value),
            asString(item.code),
          ].filter((entry): entry is string => Boolean(entry));
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

function matchesFilter(value: string | undefined, filter: string | undefined): boolean {
  if (!filter) {
    return true;
  }

  return (value ?? '').toLowerCase().includes(filter.toLowerCase());
}

function matchesJsonFilter(value: unknown, filter: string | undefined): boolean {
  if (!filter) {
    return true;
  }

  return JSON.stringify(value).toLowerCase().includes(filter.toLowerCase());
}

export class EtterlevelseClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl: string = config.api.etterlevelseBaseUrl,
  ) {}

  private async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
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
      throw new Error(`Etterlevelse API svarte ${response.status}: ${bodyText}`);
    }

    return payload;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Etterlevelse API svarte ${response.status}: ${bodyText}`);
    }
    return bodyText ? (JSON.parse(bodyText) as unknown) : null;
  }

  private async put(path: string, body: unknown): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Etterlevelse API svarte ${response.status}: ${bodyText}`);
    }
    return bodyText ? (JSON.parse(bodyText) as unknown) : null;
  }

  private async graphql(query: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl.replace(/\/api\/?$/, '')}/graphql`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ query }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Etterlevelse GraphQL svarte ${response.status}: ${bodyText}`);
    }

    let payload: unknown = null;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch {
        payload = bodyText;
      }
    }

    if (isRecord(payload) && payload['errors']) {
      throw new Error(`GraphQL-feil: ${JSON.stringify(payload['errors'])}`);
    }

    return isRecord(payload) ? payload['data'] : payload;
  }

  async listEtterlevelseDokumentasjoner(input: { search?: string; team?: string }): Promise<unknown[]> {
    const payload = await this.get('/etterlevelsedokumentasjon', {
      sistRedigert: 10,
      pageNumber: 0,
      pageSize: 50,
    });

    const items = extractArray<Record<string, unknown>>(payload);
    return items
      .map((item) => {
        const title = asString(item.title) ?? asString(item.navn) ?? 'Uten tittel';
        const etterlevelseNummer = asString(item.etterlevelseNummer) ?? '';
        const teams = extractStringArray(item.teams ?? item.team);

        return {
          id: asString(item.id) ?? '',
          title,
          etterlevelseNummer,
          teams,
        };
      })
      .filter((item) => {
        const searchHaystack = `${item.id} ${item.title} ${item.etterlevelseNummer}`;
        const teamHaystack = item.teams.join(' ');
        return matchesFilter(searchHaystack, input.search) && matchesFilter(teamHaystack, input.team);
      });
  }

  async getEtterlevelseDokumentasjon(id: string): Promise<unknown> {
    const data = await this.graphql(
      `{ etterlevelseDokumentasjon(filter: {id: "${id}"}) { content {
          id title etterlevelseNummer teams
          behandlinger { id navn }
          etterlevelser {
            id kravNummer kravVersjon etterleves status statusBegrunnelse
            suksesskriterieBegrunnelser {
              suksesskriterieId begrunnelse suksesskriterieStatus
              veiledning veiledningsTekst veiledningsTekst2
            }
          }
        } } }`,
    );
    if (isRecord(data) && isRecord(data['etterlevelseDokumentasjon'])) {
      const content = extractArray(data['etterlevelseDokumentasjon']['content']);
      return content[0] ?? null;
    }
    return data;
  }

  async listKrav(input: { relevansFor?: string; tema?: string; etterlevelseDokumentasjonId?: string }): Promise<unknown[]> {
    if (input.etterlevelseDokumentasjonId) {
      const data = await this.graphql(
        `{ krav(filter: {gjeldendeKrav: true, etterlevelseDokumentasjonId: "${input.etterlevelseDokumentasjonId}"}) {
            content { kravNummer kravVersjon navn status tema relevansFor }
          } }`,
      );
      if (isRecord(data) && isRecord(data['krav'])) {
        return extractArray<Record<string, unknown>>(data['krav']['content'])
          .filter((item) => matchesJsonFilter(item.relevansFor, input.relevansFor))
          .filter((item) => matchesJsonFilter(item.tema, input.tema));
      }
      return [];
    }

    const payload = await this.get('/krav', {
      status: 'AKTIV',
      pageNumber: 0,
      pageSize: 200,
    });

    const items = extractArray<Record<string, unknown>>(payload);
    return items
      .filter((item) => matchesJsonFilter(item.relevansFor, input.relevansFor))
      .filter((item) => matchesJsonFilter(item.tema, input.tema))
      .map((item) => ({
        id: asString(item.id) ?? '',
        kravNummer: Number(item.kravNummer ?? 0),
        kravVersjon: Number(item.kravVersjon ?? 0),
        navn: asString(item.navn) ?? asString(item.name) ?? 'Uten navn',
        status: asString(item.status) ?? '',
        tema: extractStringArray(item.tema),
      }));
  }

  async getKrav(id: string): Promise<unknown> {
    const kravnummerMatch = /^K?(\d+)\.(\d+)$/i.exec(id.trim());
    if (kravnummerMatch) {
      const [, nummer, versjon] = kravnummerMatch;
      return this.get(`/krav/kravnummer/${nummer}/${versjon}`);
    }

    return this.get(`/krav/${id}`);
  }

  async getEtterlevelse(input: {
    etterlevelseDokumentasjonId: string;
    kravNummer: number;
    kravVersjon: number;
  }): Promise<unknown> {
    return this.get('/etterlevelse', {
      etterlevelseDokumentasjonId: input.etterlevelseDokumentasjonId,
      kravNummer: input.kravNummer,
      kravVersjon: input.kravVersjon,
    });
  }

  async upsertEtterlevelse(input: {
    etterlevelseDokumentasjonId: string;
    kravNummer: number;
    kravVersjon: number;
    status: 'UNDER_ARBEID' | 'IKKE_RELEVANT';
    statusBegrunnelse?: string;
    suksesskriterieBegrunnelser: Array<{
      suksesskriterieId: number;
      begrunnelse: string;
      suksesskriterieStatus: 'UNDER_ARBEID' | 'IKKE_RELEVANT' | 'IKKE_OPPFYLT';
    }>;
  }): Promise<unknown> {
    const existing = await this.getEtterlevelse({
      etterlevelseDokumentasjonId: input.etterlevelseDokumentasjonId,
      kravNummer: input.kravNummer,
      kravVersjon: input.kravVersjon,
    });
    const items = extractArray<Record<string, unknown>>(existing);
    const existingItem = items[0];

    const body = {
      etterlevelseDokumentasjonId: input.etterlevelseDokumentasjonId,
      kravNummer: input.kravNummer,
      kravVersjon: input.kravVersjon,
      etterleves: input.status !== 'IKKE_RELEVANT',
      status: input.status,
      statusBegrunnelse: input.statusBegrunnelse ?? '',
      suksesskriterieBegrunnelser: input.suksesskriterieBegrunnelser,
    };

    if (existingItem && typeof existingItem.id === 'string') {
      return this.put(`/etterlevelse/${existingItem.id}`, body);
    }

    return this.post('/etterlevelse', body);
  }
}
