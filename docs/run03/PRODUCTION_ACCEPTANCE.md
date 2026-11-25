# RUN 03C – produkční nasazení Gmail základu (Gmail VYPNUTÝ) – záznam

Datum: 2026-11-25. Schválení vlastníka: konsolidace do `main` a řízené produkční nasazení s vypnutým Gmailem (zadání RUN 03C).
Produkce: `https://clearspace.luffast.com`, Supabase `twjlnsxjtuntujarwner`, Vercel projekt `clearspace`. `clearspace-prod` (Google) **beze změny**.

## Výsledek
| | |
|---|---|
| Produkční deployment | **`dpl_3wGY3njTQ2LWJsaxG7H6Kuitq8ur`** (READY, promote 2026-11-25), zdroj = čistý `git archive` merge commitu **`e9aefbc`** |
| Předchozí (rollback bod) | `dpl_26oNU69rEMtEazEZpMk1pgf7hV8k` (RUN 02C, `32eb451`) – s migrací 1300 prokazatelně funguje |
| Produkční DB | markery do **`20261127001300_gmail`**; záloha `public` před migrací: `/Volumes/WORKSPACE/_G2_BACKUP/20261125-v1-pre-gmail` (505 KB, SHA256SUMS OK, `pg_restore --list` 30 tabulek) |
| Gmail v produkci | **vypnutý**: `GMAIL_INTEGRATION_ENABLED=0` (Production, plain; Preview nemá); Gmail API ani scope v `clearspace-prod` nejsou |

## Brány (v pořadí provedení)
| # | Krok | Důkaz | Výsledek |
|---|---|---|---|
| 1 | Preflight Git/Vercel/DB | `origin/main` = `1c57ced`; produkce `dpl_26oNU69r…`; DB markery do 1200, 1 aktivní Google spojení, 1 Drive odkaz; existující řádky splňují nové CHECKy 1300 (0 porušení); `vercel.json git.deploymentEnabled=false`, všechny produkční buildy `src=cli` | PASS |
| 2 | Revize změn (veřejný repozitář) | žádné tajemství, token ani e-mailová adresa v `run02c-complete..HEAD`; ID dev GCP projektu odstraněno z dokumentace (zůstává jen v historii commitu `0e905ab`, není to přihlašovací údaj) | PASS |
| 3 | Nácvik `rehearse-gmail-prod.sh` | replika = produkční DDL (katalog == produkce) + syntetická data vč. Drive řádků; apply v 1 transakci, otisk Google řádků beze změny; `92_google_drive` 73 + `93_gmail` 70 asercí na produkčním DDL + 1300; rollback odmítnut při Gmail auditu, čistý rollback = katalog 1200, re-apply | PASS |
| 4 | Kompatibilita kódu RUN 02C s 1300 | `run02c-complete` (export) proti DB s 1300: Drive HTTP **28/28**, Drive E2E PASS | PASS |
| 5 | Real-stack harness (finální kód) | SQL **519**, HTTP **29/29**, dočasný stack smazán | PASS |
| 6 | Regrese finálního kódu | Vitest **1338/1338**, DB **2301**, Gmail HTTP **23/23**, Drive HTTP **28/28**, Gmail + Drive E2E Klasika i Monograph, build + guard **65/65**, `/api/dev/login` 404 (5 metod) | PASS |
| 7 | `GMAIL_INTEGRATION_ENABLED=0` (Production) | Vercel API | PASS |
| 8 | **Migrace 1300 na produkci** (`apply-gmail-hosted.sh`) | 1 transakce; počty řádků beze změny; otisk `external_resource_links`/`google_connections`/`integration_audit`/`server_trust` beze změny; `marker=1 rls=1 client_source_access=0 anon_exec=0 gmail_links=0 gmail_sources=0` | PASS |
| 9 | Starý build na 1300 | `check-deployment.sh` (EXPECT_DRIVE=1) **104/104**; `hosted-verify.sh` **16/16** (+1 přeskočen = Gmail test) + realtime PASS, 3 jednorázové účty smazány, 0 zbytků | PASS |
| 10 | Merge `feature/run03-gmail` → `main` | `--no-ff` merge commit `e9aefbc` (strom == ověřený `ca7872e`) | PASS |
| 11 | Staged build + brány | `dpl_3wGY3njT…` (skip-domain); `deploy-drive-staged.sh check` **111** ok / 0 FAIL; build.env proti produkci: jediný rozdíl `GMAIL_INTEGRATION_ENABLED` | PASS |
| 12 | Promote | `vercel promote` → produkce = `dpl_3wGY3njT…`, `releaseCommit=e9aefbc` | PASS |
| 13 | Produkce po promote | `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1) **110/110**; `hosted-verify.sh` s `E2E_EXPECT_GMAIL=off` **17/17** + realtime PASS, 0 zbytků; staré domény 308 | PASS |
| 14 | Monograph výchozí | `monograph-prodcheck.mjs` (odhlášeno): čerstvý prohlížeč `data-style=monograph` před `<body>`, Klasika respektována, fonty, motiv nezávislý | PASS (přepínač/rail v navbaru NOT VERIFIED – vyžaduje přihlášenou stránku) |
| 15 | Runtime logy (Hobby ~1 h) | nový deployment: 1 záznam (OAuth config: režim real, jen formát secretu, maskované číslo projektu, správný redirect); 0 chyb, 0 tokenů/kódů/adres | PASS |
| 16 | Data vlastníka | po nasazení otisk Google řádků == před migrací; spojení `active`, bez Gmail scope; žádný refresh ani revokace | PASS |

## Gmail containment (důkazy nezávislé na UI)
* Anonymně (black-box): `GET /api/gmail/search`, `POST /api/gmail/links`, `GET …/preview`, `POST …/refresh` → **503 `gmail_disabled`** (kontrola přepínače
  je první, před autentizací i konfigurací Google); `POST /api/google/oauth/start` (gmail) → 401.
* Přihlášený jednorázový uživatel (`supabase-hosted.spec.ts`): oauth/start `service=gmail` → **503 `gmail_disabled`**, žádná URL Google; oauth/start
  pro Disk → `scope` = přesně `openid email drive.file` (žádný Gmail); všechny Gmail trasy 503; `picker-token` bez spojení → 409, žádný token;
  `/api/google/connection` → `gmailAvailable: false`.
* `/privacy`: sekce „Gmail není na tomto serveru zapnutý“ (`privacy-gmail-off`), detailní Gmail sekce se nevykresluje.
* Klientský bundle: žádné `auth/gmail`, `gmail.googleapis.com`, `GMAIL_INTEGRATION_ENABLED`, `gmail_link_source` (+ guard 65 vzorů lokálně).
* DB: `gmail_link_sources` = 0, žádný odkaz `gmail_*`; AI trasy beze změny (firewall 403 na `/api/ai/*`, owner trasy 401/405).

## Rollback (nepoužit)
Kód: `vercel promote https://clearspace-<RUN02C>…` → `dpl_26oNU69rEMtEazEZpMk1pgf7hV8k` (funguje s 1300, brána 9). DB 1300 **nevracet**, dokud běží kód,
který ji používá; poté jen `supabase/rollback/20261127001300_gmail.down.sql` (odmítne při Gmail datech/auditu). Záloha viz výše.
