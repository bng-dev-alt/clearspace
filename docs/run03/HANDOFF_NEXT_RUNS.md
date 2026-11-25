# Handoff RUN 03 → RUN 03B (Gmail live), RUN 04 (Google Calendar)

Stav 2026-11-25 (po RUN 03B): větev `feature/run03-gmail` (obsahuje merge `run02c-complete`), worktree `V1-gmail`, tagy `run03-mock-complete` a
**`run03-complete`** (lokálně, nepushnuto, nenasazeno). Živá akceptace PASS 20/20 (`LIVE_ACCEPTANCE.md` §E).
Start: `GMAIL.md` (provoz + testy), `ARCHITECTURE_DECISION.md`, `PRIVACY_AND_SECURITY.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ROLLOUT.md`.

## RUN 03B – hotovo
Dev projekt `clearspace-dev`: Gmail API, `gmail.readonly`, redirect/origin 3451 a Picker referrer 3451 nastaveny. Živě ověřeno vč. kritické
brány: Google na refresh se `scope` skutečně vydá užší token (tokeninfo bez Gmailu, Gmail API 403) – vzor `getNarrowAccessToken` je pro další
služby (Calendar) použitelný. Opakovatelné: `gmail-live.sh app|revoke-check`, `node supabase/tests/gmail_live_gate.mjs [expect-no-gmail]`.

## RUN 03C – hotovo (produkce)
`main` = merge `e9aefbc` (+ dokumentace), produkce `dpl_3wGY3njT…`, DB markery do 1300, Gmail **vypnutý**. Záznam: `PRODUCTION_ACCEPTANCE.md`.
Nástroje pro další migrace téhož typu: `rehearse-gmail-prod.sh` + `apply-gmail-hosted.sh` (vzor pro 1400), `deploy-drive-staged.sh`
(`RELEASE_BRANCH`, `EXPECT_GMAIL_MIGRATION`), `check-deployment.sh` (`EXPECT_GMAIL_OFF`), `hosted-verify.sh` (`E2E_EXPECT_GMAIL=off`).

## RUN 04 (Google Calendar) – připravenost: **GO**
* Před startem RUN 04: nová větev z **`main` (tag `run03c-complete`)**, nový worktree a stack (vzor `gmail-stack.sh`, port 3461).
* Produkční migrace 1400 (Calendar) půjde stejným pořadím jako 1300: nácvik na replice → apply se zálohou → starý build ověřit → staged → promote.
  Calendar kód nesmí rozbít Gmail-off produkci: `check-deployment.sh EXPECT_GMAIL_OFF=1` musí dál projít.
* Google Cloud dev: zapnout Calendar API, přidat scope (Phase 0: ověřit klasifikaci `calendar.events.readonly`/`calendar.readonly` = sensitive),
  redirect/origin + Picker referrer pro nový port – vše jen v `clearspace-dev`.
* Živá brána RUN 04: zkopírovat `gmail_live_gate.mjs` → Picker token nesmí nést Calendar ani Gmail.

## RUN 04 – Google Calendar: co znovu použít (bez přepisování)
| Potřeba | Hotové místo |
|---|---|
| Další scope inkrementálně | `config.ts`: přidat `CALENDAR_*_SCOPE`, `SERVICE_SCOPE.calendar`, `SERVICE_SCOPES.calendar`; typ `GoogleService`; `start` route už bere `service` (doplnit validaci) |
| Ukládání jen povolených služeb | `oauth/complete` (`keep` = identita + služby povolené zde) – funguje pro libovolnou službu |
| Odmítnutí scope bez škody | `oauth/complete` (žádná revokace, `google_service_audit`), `account_mismatch` |
| Token jen pro danou službu | `getAccessToken(db, cfg, { service })`, `withGmailToken` vzor (zobecnit na `withServiceToken`) |
| Token do prohlížeče | `getNarrowAccessToken(db, cfg, scopes, service)` – vždy zúžit |
| Vypnout službu v ClearSpace | `google_service_remove` (rozšířit whitelist scope) + `DELETE /api/<svc>/connection` vzor |
| Šifrování, refresh lease, revokace | beze změny z RUN 02 (`crypto.ts`, `server.ts`, `google_*` RPC) |
| Sdílená vs. soukromá data | `external_resource_links` (sdílené, CHECK per provider) + soukromá tabulka zdroje (`gmail_link_sources` vzor) |
| Audit | `integration_audit` (+ události `service_added/removed`, detail = služba) |
| Realtime + aktivita | `external_links_events` (větvení podle provideru, signál jen s id), `activityText.ts` |
| Mock | `google-mock.mjs` (granulární checkboxy podle scope, union grantů, zúžený refresh, revokace celého grantu) – přidat `/calendar/v3` |
| Lokální stack + DEV login | `gmail-stack.sh` je 20řádkový vzor nad `drive-stack.sh` (`*_OVERRIDE`), `gmail-live.sh` nad `google-live.sh` |
| Bundle guard | `check-production-bundle.sh` – přidat Calendar RPC/host/scope |
| Project Intelligence | `src/lib/resources/contract.ts` (`ResourceDocument`, citace `<provider>:<linkId>#n`, `aiUse: 'not_consented'`) |

Calendar `calendar.events` / `calendar.readonly` jsou *sensitive* (ověření, ale bez CASA) – ověřit aktuální klasifikaci v Phase 0.

## Poučení z RUN 03
* Po změně migrace během běhu: `gmail-stack.sh up` (re-apply) + PostgREST reload, jinak chybí nové RPC (projevilo se jako revokace – opraveno na fail-closed).
* Next 16: jeden `next dev` na adresář; produkční build zastavte dev server (sdílené `.next`).
* Playwright: revize Chromia v cache se může lišit → `PW_CHROMIUM_PATH`.
* Mock `__control/fail {count:0}` znamená 1 (výchozí) – v testech používat přesné počty.

## Omezení, která platí dál
Žádný push/merge/deploy bez schválení; V2/Artform/RUN 01/RUN 02 worktree a stacky se nemění; žádná placená AI volání; tajemství jen Keychain/Vercel Sensitive;
DEV login jen v explicitně povoleném lokálním vývoji; restricted scope ⇒ veřejně jen po rozhodnutí vlastníka (`PRODUCTION_ROLLOUT.md` §0).
