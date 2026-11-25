# Handoff RUN 03 → RUN 03B (Gmail live), RUN 04 (Google Calendar)

Stav 2026-11-25: větev `feature/run03-gmail`, worktree `V1-gmail`, tag `run03-mock-complete` (lokálně, nepushnuto, nenasazeno).
Start: `GMAIL.md` (provoz + testy), `ARCHITECTURE_DECISION.md`, `PRIVACY_AND_SECURITY.md`, `LIVE_ACCEPTANCE.md`, `PRODUCTION_ROLLOUT.md`.

## RUN 03B – živá akceptace Gmailu
Kroky vlastníka v Google Cloud (`LIVE_ACCEPTANCE.md` §A: Gmail API, scope na consent screen, redirect URI 3451) → `gmail-live.sh app` → checklist §C.
Nejrizikovější živé body: (8) zúžení tokenu pro Picker, (2) redirect URI 3451, (7) URL „Otevřít v Gmailu“.

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
