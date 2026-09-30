# Metrikker

nav-etterlevelse-mcp eksponerer Prometheus-metrikker på `/metrics`, og Nais scraper dem (se `prometheus` i `.nais/app.yaml`). Metrikkene er definert i `src/metrics.ts`. Dashboardet ligger i `grafana/dashboard.json`.

## Spørsmål metrikkene svarer på

| Spørsmål | Metrikk | Panel |
|----------|---------|-------|
| Hvor mange krav godkjenner man om gangen? | `etterlevelse_work_session_krav` | Krav per arbeidsøkt (7d) |
| Hvor mange SK-er dokumenterer man om gangen? | `etterlevelse_work_session_suksesskriterier` | Suksesskriterier per arbeidsøkt (7d) |
| Hvor lange er arbeidsøktene, og hvordan slutter de? | `etterlevelse_work_session_*` | Arbeidsøkter: antall og median per avslutningsårsak (7d) |
| Hvilke krav og SK-er krever flest runder? | `etterlevelse_sk_gjennomgang_total` | Iterasjoner per krav og SK (30d), SK-gjennomgang per krav og SK: alle hendelser (30d) |
| Hvilke SK-er får oftest svaret sitt endret? | `etterlevelse_writes_total{write_type}` | Andel reviderte SK-svar per krav og SK (30d) |
| Skriver agenten SK-er uten at brukeren har sett forslaget? | `sk_review_write_outcome_total`, `sk_review_begin_total` | SK-gjennomgang: startet og skrevet per time, SK-skriving: utfall siste 24 timer |

Vi måler ikke om brukeren går krav for krav eller får generert en hel rapport. Rapporten er et obligatorisk steg i `nav-etterlevelse`-skillen, og `write_suksesskriterium` skriver ett SK om gangen med en reviewToken fra `begin_sk_review`.

## Arbeidsøkt

En arbeidsøkt er én bruker som jobber på ett etterlevelsesdokument. Logikken ligger i `src/mcp/workSessionTracker.ts`.

- Økta starter ved første `lock_document`, `begin_sk_review` eller skriving på dokumentet.
- Ny låsing av samme dokument fortsetter økta. Låsen må ofte opprettes på nytt, så økta er ikke knyttet til den.
- Økta slutter når brukeren låser et annet dokument (`end_reason="dokumentbytte"`) eller etter 60 minutter uten aktivitet (`end_reason="inaktiv"`). Grensen er lengre enn reviewToken-TTL-en på 45 minutter.
- Når økta slutter, observeres de tre histogrammene. Økter uten godkjent skriving blir ikke observert.

Brukeren identifiseres med en hash av e-postadressen. Hashen ligger bare i minnet og brukes aldri som label.

## Hendelser i SK-gjennomgangen

`etterlevelse_sk_gjennomgang_total` har labelen `hendelse`:

| Hendelse | Når |
|----------|-----|
| `presentert` | Hvert kall til `begin_sk_review` |
| `presentert_paa_nytt` | `begin_sk_review` for samme SK mens forrige token var ubrukt (ny runde eller utløpt token) |
| `forlatt` | En ubrukt token ble erstattet av en token for et annet SK (brukeren hoppet over eller avbrøt) |
| `skrevet_g` | Godkjent skriving der brukeren godtok forslaget uendret |
| `skrevet_r` | Godkjent skriving der brukeren redigerte forslaget |
| `omskrevet_i_okt` | SK-et var allerede skrevet i samme arbeidsøkt |

Panelet «Iterasjoner per krav og SK» summerer `presentert_paa_nytt`, `skrevet_r` og `omskrevet_i_okt`. En mørk celle betyr at SK-et krevde flere runder.

`write_type` på `etterlevelse_writes_total` er et annet signal. `revised` betyr at SK-et hadde en begrunnelse fra før, også hvis den ble skrevet i etterlevelsesløsningen. Signalet blander dermed oppdatering av gammel dokumentasjon og nye forsøk i samme økt.

## Alle metrikker

I tillegg til metrikkene under eksporterer appen standardmetrikkene fra `collectDefaultMetrics` (minne, CPU, event loop).

### Trafikk og drift

| Metrikk | Type | Labels | Innhold |
|---------|------|--------|---------|
| `mcp_requests_total` | counter | `tool`, `status` | MCP tool-kall |
| `mcp_request_duration_seconds` | histogram | `tool` | Responstid per tool-kall |
| `mcp_active_sessions` | gauge | | Åpne MCP-sesjoner |
| `mcp_errors_total` | counter | `tool`, `error_type` | Feil per tool og feiltype |
| `texas_obo_errors_total` | counter | | Feil ved OBO-veksling via Texas |
| `upstream_errors_total` | counter | `backend` | Feil mot downstream-systemer |
| `auth_refreshes_total` | counter | | Token-refresh |

### Lesing og skriving

| Metrikk | Type | Labels | Innhold |
|---------|------|--------|---------|
| `etterlevelse_writes_total` | counter | `kravnummer`, `kravversjon`, `suksesskriterium_id`, `suksesskriterium_status`, `write_type` | Skriving per krav og SK. `write_type` er `created` eller `revised` |
| `etterlevelse_docs_created_total` | counter | | Nye etterlevelsesdokumenter |
| `pvk_operations_total` | counter | `operation`, `status` | PVK-operasjoner (risikoscenarioer og tiltak) |
| `navet_reads_total` | counter | `fagomrade`, `operation` | Lesing fra Navet |
| `behandlingskatalog_reads_total` | counter | `operation` | Lesing fra Behandlingskatalogen |

### SK-gjennomgang

| Metrikk | Type | Labels | Innhold |
|---------|------|--------|---------|
| `sk_review_begin_total` | counter | | Kall til `begin_sk_review` |
| `sk_review_write_outcome_total` | counter | `outcome`, `bruker_godkjenning` | Utfall av `write_suksesskriterium`: `accepted`, `missing_token`, `invalid_token` eller `mismatched_sk`. `bruker_godkjenning` er `G` eller `R` |
| `etterlevelse_sk_gjennomgang_total` | counter | `kravnummer`, `suksesskriterium_id`, `hendelse` | Se [Hendelser i SK-gjennomgangen](#hendelser-i-sk-gjennomgangen) |

### Arbeidsøkter

| Metrikk | Type | Labels | Innhold |
|---------|------|--------|---------|
| `etterlevelse_work_session_krav` | histogram | `end_reason` | Ulike krav med minst én godkjent SK-skriving eller krav-status per økt |
| `etterlevelse_work_session_suksesskriterier` | histogram | `end_reason` | Ulike SK-er skrevet per økt |
| `etterlevelse_work_session_duration_seconds` | histogram | `end_reason` | Tid fra første til siste aktivitet i økta |

## Kjente begrensninger

- Arbeidsøkter som pågår, går tapt ved pod-restart. Det holder for et grovt bilde av hvordan teamene jobber.
- Den siste tokenen i en økt blir aldri erstattet, og telles derfor ikke som `forlatt`.
- Vi ser om brukeren redigerte forslaget (`R`), men ikke hvor mange redigeringsrunder det tok.
- `increase()` mister den første hendelsen i en ny tidsserie. Ved lite trafikk viser panelene for lave tall.

## Alarmer

Alarmene ligger i `.nais/alerts.yaml` (prod) og `.nais/alerts-dev.yaml` (dev). Dev har i tillegg `EtterlevelseMcpSkReviewTokenAvvisninger`, som varsler ved mange avviste SK-tokenforsøk.

## Dashboard

Importer `grafana/dashboard.json` i Grafana via **Dashboards → New → Import**. Velg Prometheus-datakilde for dev-gcp eller prod-gcp i variabelen «Datakilde».

Gjør endringer i fila og importer den på nytt, slik at repoet er fasit.

## Legge til en metrikk

1. Definer metrikken i `src/metrics.ts` med `registers: [registry]`.
2. Bruk labels med et begrenset sett verdier. Aldri e-post, navn, fødselsnummer, token eller fritekst som label.
3. Legg metrikken inn i tabellen over, og i dashboardet hvis den skal vises der.
