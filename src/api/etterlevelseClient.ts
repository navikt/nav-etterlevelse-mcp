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

  return JSON.stringify(value ?? '').toLowerCase().includes(filter.toLowerCase());
}

function matchesTaggerFilter(value: unknown, filter: string[] | undefined): boolean {
  if (!filter || filter.length === 0) {
    return true;
  }

  const normalizedValue = extractStringArray(value).map((entry) => entry.toLowerCase());
  return filter.every((tag) => normalizedValue.includes(tag.toLowerCase()));
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Etterlevelse API svarte 404');
}

export interface BehandlingensLivsloepFil {
  navn: string;
  type: 'image/png' | 'image/jpeg' | 'application/pdf';
  innhold: string;
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
    let payload: unknown;

    if (input.team) {
      // Slå opp team-UUID fra navn, deretter bruk dedikert team-søk-endepunkt
      const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let teamId: string;
      if (UUID_PATTERN.test(input.team)) {
        teamId = input.team;
      } else {
        const teamSearch = await this.get(`/team/search/${encodeURIComponent(input.team)}`);
        const teamItems = extractArray<Record<string, unknown>>(teamSearch);
        if (teamItems.length === 0) {
          return [];
        }
        teamId = asString(teamItems[0]!['id']) ?? '';
      }
      payload = await this.get(`/etterlevelsedokumentasjon/search/team/${teamId}`, {
        pageNumber: 0,
        pageSize: 200,
      });
    } else {
      payload = await this.get('/etterlevelsedokumentasjon', {
        sistRedigert: 10,
        pageNumber: 0,
        pageSize: 50,
      });
    }

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
        return matchesFilter(searchHaystack, input.search);
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

  async getEtterlevelseDokumentasjonRaw(id: string): Promise<any> {
    return this.get(`/etterlevelsedokumentasjon/${id}`);
  }

  async updateEtterlevelseDokumentasjon(id: string, body: object): Promise<any> {
    return this.put(`/etterlevelsedokumentasjon/${id}`, body);
  }

  async listKrav(input: {
    relevansFor?: string;
    tema?: string;
    etterlevelseDokumentasjonId?: string;
    tagger?: string[];
  }): Promise<unknown[]> {
    if (input.etterlevelseDokumentasjonId) {
      const filterParts = [
        'gjeldendeKrav: true',
        `etterlevelseDokumentasjonId: "${input.etterlevelseDokumentasjonId}"`,
        ...(input.tagger && input.tagger.length > 0
          ? [`tagger: [${input.tagger.map((tag) => `"${tag}"`).join(', ')}]`]
          : []),
      ].join(', ');
      const query = `{ krav(filter: {${filterParts}}) {
          content { kravNummer kravVersjon navn status tagger relevansFor { code shortName } }
        } }`;
      const data = await this.graphql(query);
      if (isRecord(data) && isRecord(data['krav'])) {
        return extractArray<Record<string, unknown>>(data['krav']['content'])
          .filter((item) => matchesJsonFilter(item.relevansFor, input.relevansFor));
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
      .filter((item) => matchesTaggerFilter(item.tagger, input.tagger))
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
    const payload = await this.get(
      `/etterlevelse/etterlevelseDokumentasjon/${input.etterlevelseDokumentasjonId}/${input.kravNummer}`,
    );
    // Filter client-side på kravVersjon
    const items = extractArray<Record<string, unknown>>(payload);
    return items.find((item) => Number(item.kravVersjon) === input.kravVersjon) ?? null;
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

    // Etterlevelse-status: UNDER_REDIGERING er gyldig for det øverste statusfeltet.
    // UNDER_ARBEID er kun gyldig for suksesskriterieStatus.
    const etterlevelseStatus = input.status === 'UNDER_ARBEID' ? 'UNDER_REDIGERING' : input.status;

    const body: Record<string, unknown> = {
      etterlevelseDokumentasjonId: input.etterlevelseDokumentasjonId,
      kravNummer: input.kravNummer,
      kravVersjon: input.kravVersjon,
      etterleves: input.status !== 'IKKE_RELEVANT',
      status: etterlevelseStatus,
      statusBegrunnelse: input.statusBegrunnelse ?? '',
      suksesskriterieBegrunnelser: input.suksesskriterieBegrunnelser,
    };

    if (isRecord(existing) && typeof existing.id === 'string') {
      // Inkluder version for optimistisk låsing — uten dette får vi 403 Forbidden
      if (typeof existing.version === 'number') {
        body.version = existing.version;
      }
      return this.put(`/etterlevelse/${existing.id}`, body);
    }

    return this.post('/etterlevelse', body);
  }

  async getPvkDokument(etterlevelseDokumentasjonId: string): Promise<unknown | null> {
    try {
      return await this.get(`/pvkdokument/etterlevelsedokument/${etterlevelseDokumentasjonId}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async createPvkDokument(etterlevelseDokumentasjonId: string): Promise<unknown> {
    return this.post('/pvkdokument', { etterlevelseDokumentId: etterlevelseDokumentasjonId });
  }

  async getPvkDokumentById(pvkDokumentId: string): Promise<unknown> {
    return this.get(`/pvkdokument/${pvkDokumentId}`);
  }

  async patchPvkDokument(pvkDokumentId: string, patch: Record<string, unknown>): Promise<unknown> {
    const existing = await this.getPvkDokumentById(pvkDokumentId);
    if (!isRecord(existing)) {
      throw new Error(`Fant ikke PVK-dokument med id ${pvkDokumentId}`);
    }

    // Skill-gotcha: strip read-only-felter som backend avviser i PUT
    const { changeStamp: _cs, currentEtterlevelseDokumentVersjon: _cev, ...cleaned } = existing;

    // Skill-gotcha: ytterligereEgenskaper returneres som [{code, ...}] fra GET
    // men MÅ sendes som ['KODE1', 'KODE2'] — ellers 400 deserialization-feil
    if (Array.isArray(cleaned.ytterligereEgenskaper)) {
      cleaned.ytterligereEgenskaper = cleaned.ytterligereEgenskaper.map((e: unknown) =>
        isRecord(e) ? asString(e.code) : e,
      ).filter(Boolean);
    }

    // Skill-gotcha: antallInnsendingTilPvo MÅ være 0, ikke null
    if (cleaned.antallInnsendingTilPvo === null || cleaned.antallInnsendingTilPvo === undefined) {
      cleaned.antallInnsendingTilPvo = 0;
    }

    const body = {
      ...cleaned,
      ...patch,
      id: asString(existing.id) ?? pvkDokumentId,
      update: true,
    };

    return this.put(`/pvkdokument/${pvkDokumentId}`, body);
  }

  async getBehandlingensLivsloep(etterlevelseDokumentasjonId: string): Promise<unknown | null> {
    try {
      return await this.get(`/behandlingenslivslop/etterlevelsedokument/${etterlevelseDokumentasjonId}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async upsertBehandlingensLivsloep(
    etterlevelseDokumentasjonId: string,
    beskrivelse: string,
    filer?: BehandlingensLivsloepFil[],
  ): Promise<unknown> {
    const existing = await this.getBehandlingensLivsloep(etterlevelseDokumentasjonId);
    const existingId =
      existing && isRecord(existing) && typeof existing.id === 'string' ? existing.id : undefined;
    const isUpdate = Boolean(existingId);

    const reqBody: Record<string, unknown> = {
      etterlevelseDokumentasjonId,
      beskrivelse,
      update: isUpdate,
      // Skill-gotcha: backend krasjer med NullPointerException hvis filer er null/undefined
      filer: [],
      ...(existingId ? { id: existingId } : {}),
    };

    const formData = new FormData();
    formData.append('request', new Blob([JSON.stringify(reqBody)], { type: 'application/json' }));

    // Backend merge semantics for PUT without filer parts may require callers to resend files
    // when existing attachments must be preserved.
    for (const fil of filer ?? []) {
      formData.append(
        'filer',
        new Blob([Buffer.from(fil.innhold, 'base64')], { type: fil.type }),
        fil.navn,
      );
    }

    const url = new URL(
      isUpdate
        ? `${this.baseUrl}/behandlingenslivslop/${existingId}`
        : `${this.baseUrl}/behandlingenslivslop`,
    );
    const response = await fetch(url, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: formData,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Etterlevelse API svarte ${response.status}: ${bodyText}`);
    }

    if (!bodyText) {
      return null;
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return bodyText;
    }
  }

  async getBehandlingensArtOgOmfang(etterlevelseDokumentasjonId: string): Promise<unknown | null> {
    try {
      return await this.get(
        `/behandlingens-art-og-omfang/etterlevelsedokument/${etterlevelseDokumentasjonId}`,
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async upsertBehandlingensArtOgOmfang(
    etterlevelseDokumentasjonId: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const existing = await this.getBehandlingensArtOgOmfang(etterlevelseDokumentasjonId);
    const existingId =
      existing && isRecord(existing) && typeof existing.id === 'string' ? existing.id : undefined;
    const isUpdate = Boolean(existingId);

    const body = {
      etterlevelseDokumentasjonId,
      ...data,
      update: isUpdate,
      ...(existingId ? { id: existingId } : {}),
    };

    return isUpdate
      ? this.put(`/behandlingens-art-og-omfang/${existingId}`, body)
      : this.post('/behandlingens-art-og-omfang', body);
  }

  async getRisikoscenarioer(pvkDokumentId: string): Promise<unknown[]> {
    const payload = await this.get(`/risikoscenario/pvkdokument/${pvkDokumentId}/ALL`);
    return extractArray(payload);
  }

  async getRisikoscenario(id: string): Promise<unknown | null> {
    try {
      return await this.get(`/risikoscenario/${id}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async createRisikoscenario(request: object): Promise<unknown> {
    return this.post('/risikoscenario', request);
  }

  async updateRisikoscenario(id: string, request: object): Promise<unknown> {
    return this.put(`/risikoscenario/${id}`, request);
  }

  async createTiltak(risikoscenarioId: string, request: object): Promise<unknown> {
    return this.post(`/tiltak/risikoscenario/${risikoscenarioId}`, request);
  }

  async getTiltakForPvkDokument(pvkDokumentId: string): Promise<any[]> {
    const payload = await this.get(`/tiltak/pvkdokument/${pvkDokumentId}`, { pageSize: 200 });
    return extractArray(payload);
  }

  async updateTiltak(id: string, request: object): Promise<unknown> {
    return this.put(`/tiltak/${id}`, request);
  }

  async getTiltak(id: string): Promise<unknown | null> {
    try {
      return await this.get(`/tiltak/${id}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async linkKravToRisikoscenarioer(kravnummer: number, risikoscenarioIder: string[]): Promise<any> {
    return this.put('/risikoscenario/update/addRelevantKrav', { kravnummer, risikoscenarioIder });
  }

  async getMyTeams(): Promise<Array<{ id: string; name: string; productAreaName?: string }>> {
    const payload = await this.get('/team', { myTeams: 'true' });
    const items = extractArray<Record<string, unknown>>(payload);
    return items.map((item) => ({
      id: asString(item.id) ?? '',
      name: asString(item.name) ?? asString(item.navn) ?? '',
      productAreaName: asString(item.productAreaName),
    }));
  }

  async createEtterlevelseDokumentasjon(body: object): Promise<any> {
    return this.post('/etterlevelsedokumentasjon', body);
  }
}
