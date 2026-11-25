# RUN 04 – produkční nasazení Google Calendar základu (Kalendář VYPNUTÝ) – záznam

Datum: 2026-11-25/26. Schválení: RUN_PROMPT §0 (konsolidace + nasazení s vypnutým Kalendářem po splnění bran). Produkce `https://clearspace.luffast.com`,
Supabase `twjlnsxjtuntujarwner`, Vercel `clearspace`. Google `clearspace-prod` **beze změny**.

## Výsledek
| | |
|---|---|
| Produkční deployment | **`dpl_FeGsSgZxxG2D87Tmx5bEo8b1MFMv`** (READY, promote 2026-11-25), zdroj = čistý `git archive` merge commitu **`19a0c6b`** |
| Předchozí (rollback bod) | `dpl_3wGY3njTQ2LWJsaxG7H6Kuitq8ur` (RUN 03C, `e9aefbc`) – s migrací 1400 prokazatelně funguje (G4, G8) |
| Produkční DB | markery do **`20261128001400_google_calendar`**; záloha `public` před migrací: `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-pre-calendar` (576 KB, SHA256SUMS OK, `pg_restore --list` 31 tabulek) |
| Kalendář v produkci | **vypnutý**: `CALENDAR_INTEGRATION_ENABLED=0` (Production, plain; Preview nemá); Gmail dál vypnutý (`GMAIL_INTEGRATION_ENABLED=0`) |

## Brány (v pořadí)
| # | Krok | Důkaz | Výsledek |
|---|---|---|---|
| G1 | Preflight | produkce `dpl_3wGY3njT…` z `e9aefbc`; `vercel.json git.deploymentEnabled=false`; DB markery do 1300, žádné Calendar objekty, 1 Drive odkaz, 1 aktivní spojení (bez Calendar scope) | PASS |
| G2 | Revize diffu `run03c-complete..HEAD` (veřejné repo) | žádné tajemství, token, ID dev projektu ani client id; nalezená část e-mailu vlastníka v živém testu odstraněna z kódu **i z historie větve** (nepushnuté commity přepsány); zbývá jen git autor (jako dosud) | PASS |
| G3 | `rehearse-calendar-prod.sh` | replika A (řetězec do 1300) == produkce; replika B (produkční DDL + syntetická Drive i Gmail data) → apply v 1 transakci, počty + otisky beze změny; 92 (73) + 93 (70) + 94 (77) asercí na produkčním DDL + 1400; rollback odmítnut při Calendar auditu; čistý rollback = katalog 1300; re-apply | PASS |
| G4 | Kód RUN 03C proti DB s 1400 | `git archive run03c-complete`: Drive HTTP **28/28**, Gmail HTTP **23/23**, Drive + Gmail E2E PASS | PASS |
| G5 | Finální regrese + živě | Vitest 1373/1373, DB 2378, Calendar HTTP 18/18 + OFF 1/1, Gmail 23/23, Drive 28/28, E2E Klasika + Monograph, RUN 01 (jen TD-1/TD-2), real stack 519 + 29/29, demo 27/120/0, build + guard 77/77, `/api/dev/login` 404 ×5; živá brána PASS na finálním SHA | PASS |
| G6 | `CALENDAR_INTEGRATION_ENABLED=0` (Production) | Vercel API: plain `'0'`, jen production | PASS |
| G7 | **Migrace 1400 na produkci** (`apply-calendar-hosted.sh`) | 1 transakce; počty řádků beze změny; otisk `external_resource_links`/`gmail_link_sources`/`google_connections`/`integration_audit`/`server_trust` beze změny; `marker=1 rls=1 client_source_access=0 anon_exec=0 calendar_links=0 calendar_sources=0` | PASS |
| G8 | Starý build na 1400 | `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1) **115/115**; `hosted-verify.sh` **17/17** (+1 přeskočen = Calendar test) + realtime PASS, 0 zbytků | PASS |
| 9 | Merge `feature/run04-google-calendar` → `main` | `--no-ff` merge **`19a0c6b`** (strom == ověřená větev) | PASS |
| 10 | Staged build + brány | `dpl_FeGsSgZx…` (skip-domain); preflight PASS (1200/1300/1400, obě přepínače explicitně jen Production); `deploy-drive-staged.sh check` **123** ok / 0 FAIL; build.env proti produkci: jediný rozdíl `CALENDAR_INTEGRATION_ENABLED` | PASS |
| 11 | Promote | `vercel promote` → produkce = `dpl_FeGsSgZx…`, `releaseCommit=19a0c6b` | PASS |
| 12 | Produkce po promote | `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 EXPECT_CALENDAR_OFF=1) **122/122**; `hosted-verify.sh` (E2E_EXPECT_GMAIL=off E2E_EXPECT_CALENDAR=off) **18/18** + realtime PASS, 0 zbytků | PASS |
| 13 | Monograph | `monograph-prodcheck.mjs` (odhlášeně): `data-style=monograph` před `<body>`, Klasika respektována, fonty, motiv nezávislý | PASS (přepínač/rail v navbaru NOT VERIFIED – vyžaduje přihlášenou stránku, jako v RUN 03C) |
| 14 | Runtime logy (hned po promote) | 3 záznamy, 0 chyb, 0 tokenů/kódů/adres | PASS |
| 15 | Data vlastníka | otisk Google řádků po nasazení == před migrací; spojení `active`, bez Calendar scope; žádné Calendar odkazy | PASS |

## Calendar containment (nezávislé na UI)
* Anonymně: `GET /api/calendar/events`, `POST /api/calendar/links`, `POST …/refresh`, `GET …/open` → **503 `calendar_disabled`** (přepínač první); `oauth/start` (calendar) → 401.
* Přihlášený jednorázový uživatel: `oauth/start service=calendar` → **503 `calendar_disabled`**, žádná URL Google; Drive consent bez Calendar scope; všechny Calendar trasy 503; `calendarAvailable:false`.
* `/privacy`: „Google Kalendář není na tomto serveru zapnutý“ (`privacy-calendar-off`); `/about` bez sekce Kalendář.
* Klientský bundle: žádné `auth/calendar`, `www.googleapis.com/calendar`, `CALENDAR_INTEGRATION_ENABLED`, `calendar_link_source`, `attendees(responseStatus)`.
* DB: `calendar_link_sources` = 0, žádný odkaz `google_calendar_event`.
