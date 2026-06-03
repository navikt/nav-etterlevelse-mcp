# nav-etterlevelse-broker

Minimal NAIS-app som eksisterer utelukkende for å få en Azure AD-appregistrering
via NAIS, slik at den lokale etterlevelse-brokeren kan bruke OAuth2 device-code-flyt
mot `etterlevelse-api.intern.nav.no`.

**Den faktiske broker-koden** (som kjøres lokalt) finnes i
[navikt/dab-copilot-config](https://github.com/navikt/dab-copilot-config/tree/main/tools/etterlevelse-broker).

## Hvordan det henger sammen

```
[Copilot CLI] → [lokal broker på localhost:9876] → [etterlevelse-api.intern.nav.no]
                        ↑
              bruker klient-ID fra denne NAIS-appen
              for OAuth2 device-code-flyt mot Entra
```

Denne NAIS-appen gjør ingenting annet enn å svare på helsesjekker.
Azure AD-registreringen (og klient-IDen) holdes i live så lenge appen er deployet.

## Etter første deploy

1. Hent klient-IDen:
   ```bash
   kubectl get secret nav-etterlevelse-broker -n dab \
     -o jsonpath='{.data.AZURE_APP_CLIENT_ID}' | base64 -d
   ```

2. Be datajegerne (team-etterlevelse) legge til inbound-regel i `etterlevelse-backend`:
   ```yaml
   accessPolicy:
     inbound:
       rules:
         - application: nav-etterlevelse-broker
           namespace: dab
   ```
   Og aktivere «Allow public client flows» i app-registreringen i Entra-portalen.

3. Hardkod klient-IDen i den lokale brokeren:
   ```bash
   BROKER_CLIENT_ID=<klient-id> node broker.js
   ```

## Oppsett av repo i NAIS Console

Før første deploy må repoet autoriseres:
1. Gå til [console.nav.cloud.nais.io](https://console.nav.cloud.nais.io)
2. Velg team **dab** → **Repositories**
3. Legg til `navikt/nav-etterlevelse-broker`
