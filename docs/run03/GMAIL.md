# RUN 03 – Gmail integration (architektura, provoz, testy)

Stav 2026-11-25: implementováno na `feature/run03-gmail` (základ `run02-complete` = `ca6cd29`), lokální checkpoint `run03-mock-complete`.
Ověřeno proti skutečnému lokálnímu Supabase stacku a skutečné Next.js aplikaci s **deterministickým Gmail mockem**. **Proti skutečnému
Gmailu NEOVĚŘENO** (vyžaduje kroky vlastníka v Google Cloud: `LIVE_ACCEPTANCE.md`). Rozhodnutí: `ARCHITECTURE_DECISION.md`; soukromí: `PRIVACY_AND_SECURITY.md`.

## 1. Co uživatel dostane
* **Propojené účty** (`/settings`): jeden účet Google, služby zvlášť – *Google Disk* a *Gmail (jen čtení)*: stav, „Připojit Gmail“
  (inkrementální souhlas), „Vypnout Gmail v ClearSpace“ (volitelně i smazat své připojené e-maily), „Odpojit Google účet“ (celý grant).
* **Soubory a e-maily projektu** (ikona v toolbaru, dříve „Soubory projektu“): sekce *E-maily projektu* pod soubory z Disku, přehled e-mailů u úkolů.
* **Detail úkolu**: sekce *E-maily* pod Google Diskem.
* **Výběr**: dialog „Připojit e-mail z Gmailu“ – Konverzace / Jednotlivé zprávy, hledání + Odesílatel + Předmět + Od/Do data,
  stránkování, výběr max. 10, vysvětlení, co se sdílí. **Nic se nepřipojí bez potvrzení.**
* **Řádek**: ikona zpráva/konverzace, předmět, „Konverzace · 3 zprávy · od Jana Dvořáková · 12. 11. 2026 · 2 přílohy · připojil(a) Alena“, stav (koš / smazáno).
  Vlastník odkazu: *Náhled* (jen pro něj), *Obnovit informace*; editor: *Odebrat* (jen asociace).
* **Aktivita**: „připojil(a) k projektu e-mailovou konverzaci z Gmailu“ (bez předmětu). Vše live přes realtime.

## 2. Architektura
```
browser ──Bearer──> /api/google/oauth/start {service:'gmail'}  -> scopes openid email gmail.readonly, include_granted_scopes, login_hint
           Google ──> /api/google/oauth/callback (beze změny) -> /oauth/google -> /api/google/oauth/complete (služba ze state)
/api/google/connection        GET: services {drive, gmail}, gmailAvailable      DELETE: odpojení (revokace celého grantu)
/api/google/picker-token      vždy samostatný token OMEZENÝ na Drive scopes
/api/gmail/search             GET  vlastní schránka, 1 stránka ≤ 20, metadata (threads|messages.list + get format=metadata)
/api/gmail/links              POST připojit ≤ 10 vybraných (server znovu načte metadata tokenem volajícího)
/api/gmail/links/:id/preview  GET  jen vlastník; format=full -> text (MIME, charset, HTML->text); obnoví sdílené počty
/api/gmail/links/:id/refresh  POST jen vlastník; metadata + stav (trashed/deleted)
/api/gmail/connection         DELETE vypnout Gmail v ClearSpace [?purge=1 smazat moje e-mailové odkazy]
```
Soubory: `src/lib/google/{config,oauth,server}.ts` (rozšíření), `src/lib/google/{gmail,mime,gmailLinks}.ts`, `src/lib/resources/contract.ts`,
`src/services/gmailService.ts`, `src/components/gmail/{GmailLinksPanel,GmailPickerModal}.tsx`, `src/components/drive/GoogleConnectionCard.tsx`.
Migrace `supabase/migrations/20261127001300_gmail.sql` (+ rollback). Žádná nová závislost (Node `crypto`, `TextDecoder`, `fetch`).

### 2.1 Datový model (aditivní)
* `external_resource_links`: provider + `gmail_message|gmail_thread`; `web_url` NULL pro Gmail (CHECK), `provider_state` + `deleted`,
  sloupce `email_from`, `email_count`, `email_attachments` (CHECK: jen u Gmail řádků). Drive řádky beze změny (ověřeno upgrade testem).
* `gmail_link_sources` (soukromá): `link_id` (PK, FK cascade), `owner_user_id`, `google_sub`, `kind`, `gmail_id`, `thread_id` (hex).
* `integration_audit.event` + `service_added`, `service_removed` (detail `gmail`).
* RPC (server secret + session, nikdy anon): `gmail_link_add`, `gmail_link_source`, `gmail_link_refresh`, `gmail_links_purge_mine`,
  `google_service_remove`, `google_service_audit`, `google_connection_sub`. `external_links_events` rozlišuje Drive / Gmail.

### 2.2 Gmail API (jen čtení)
`threads.list` / `messages.list` (`q`, `maxResults ≤ 20`, `pageToken`) → `get?format=metadata&metadataHeaders=From,Subject,Date`
(4 souběžně) → normalizace (duplicitní id jednou, smazané mezi list a get přeskočeny). Náhled `format=full`. Timeout 8 s, 1 retry s jitterem
na 429/5xx, 401 → jeden vynucený refresh, odpověď omezena (1 MB metadata, 5 MB obsah), `redirect: 'error'`, jen ověřená hex id v cestě.
Chyby: 429 / 403 rateLimit → „Příliš mnoho požadavků na Gmail“, 403 → „Gmail přístup odmítl (… správce Workspace)“, 404/400 → „není ve schránce“.

## 3. Konfigurace
| Proměnná | Pozn. |
|---|---|
| `GMAIL_INTEGRATION_ENABLED` | `1` = Gmail zapnutý; cokoli jiného = vypnutý (výchozí). Nezávislé na Drive. |
| ostatní `GOOGLE_*`, `APP_BASE_URL` | beze změny z RUN 02 (stejný OAuth klient, stejné šifrování) |
| `GOOGLE_API_MOCK_BASE` | jen lokální testy (mock teď obsahuje i `/gmail/v1`) |

## 4. Lokální vývoj
```
frontend/scripts/gmail-stack.sh up          # izolovaný stack cs-gmail-sb (55550-55559, mail 55564/55565), migrace vč. 1300
frontend/scripts/gmail-stack.sh mock        # Google + Gmail MOCK na 127.0.0.1:55591 (SIMULACE)
frontend/scripts/gmail-stack.sh app         # http://127.0.0.1:3451/settings?login=auto  (DEV login, Gmail zapnutý, Monograph k dispozici)
frontend/scripts/gmail-live.sh verify|app   # tatáž aplikace proti SKUTEČNÉMU Googlu (Keychain z RUN 02B) – viz LIVE_ACCEPTANCE.md
eval "$(frontend/scripts/gmail-stack.sh env)"
```
Po změně migrace spusťte znovu `gmail-stack.sh up` (PostgREST si načte schéma). Pro E2E aplikaci spusťte s `DEV_AUTO_LOGIN=0`.
Pokud Playwright hlásí chybějící Chromium jiné revize: `PW_CHROMIUM_PATH=<cesta k chrome-headless-shell>`.

## 5. Testy (2026-11-25, vše proti MOCKU, nic z toho není živý Gmail)
| Vrstva | Příkaz | Výsledek |
|---|---|---|
| Unit (vše) | `npx vitest run` | **1319/1319** (88 souborů; nové `src/__tests__/gmail/*`: MIME, HTML→text, charsety, dotazy, id, odesílatel, klient API, scopes, služby, downscoping, UI role/privacy/picker/preview, nastavení, kontrakt PI) |
| DB harness | `supabase/tests/run.sh` | **2301** SQL asercí PASS (Gmail `collab/93_gmail.sql` 70) + upgrade 1200→1300 (Drive řádky bajtově shodné), rollback 1300 odmítnut při datech, katalog po rollbacku == 1200, re-apply |
| Gmail HTTP + adversarial | `node supabase/tests/gmail_http.mjs` | **23/23** skupin |
| Browser E2E (3 uživatelé, realtime) | `e2e/gmail.spec.ts` | **PASS Klasika i Monograph** (desktop light + mobil dark) |
| Regrese Drive | `drive_http.mjs` / `e2e/google-drive.spec.ts` | **28/28** / PASS Klasika + Monograph |
| Regrese RUN 01 | `collab_realtime` · `realtime_check` · `invite_email` · E2E `collaboration` + `01b` + `supabase-runtime` + `task-resources` | 64/64 · PASS · 41/41 · 10 passed, 2 failed = **TD-1, TD-2** (baseline) |
| Real stack (pristine) | `supabase/tests/real_stack.sh` | PASS (SQL 519, HTTP 29/29) |
| DEV login | `e2e/dev-login-stack.spec.ts`, `local-auth-preflight.mjs` | 3/3, OK |
| Demo-mode Playwright | `npx playwright test` | 27 passed, 118 skipped (potřebují stack), 0 failed |
| Typecheck / lint / build / guard | `next typegen && tsc`, `eslint`, `next build` s DEV příznaky, `check-production-bundle.sh` | 0 / 0 chyb (3 stará varování) / OK / **65/65**; `next start`: `/api/dev/login` 404 |

**Mock ≠ Google.** `scripts/google-mock.mjs` simuluje: granulární souhlas s Gmail checkboxem, `include_granted_scopes` (union), refresh se
zúženým `scope`, revokaci celého grantu, schránky po účtech (česká syntetická data: vlákno o 3 zprávách, faktura multipart + přílohy, HTML
newsletter s pixelem/skriptem/iframe/formulářem, windows-1250, rozbité UTF-8, dlouhá a prázdná zpráva, smazaná mezi list/get, duplicitní id,
XSS předmět, prompt-injection text), `q` (from/subject/after/before/text), stránkování, 401/403/404/429/503. V UI vše označeno „simulace“.

## 6. Známá omezení
1. Živý Gmail neověřen (kroky vlastníka). Restricted scope ⇒ veřejně jen po ověření + CASA.
2. Odkaz „Otevřít v Gmailu“ (`/mail/u/0/#all/<threadId>`) není oficiálně dokumentovaný a otevírá účet 0 prohlížeče.
3. Počet příloh se zjistí až při prvním náhledu vlastníkem (vyhledávání a připojení používají jen `format=metadata`).
4. Stejný e-mail připojený dvěma lidmi = dva odkazy (různé schránky, různá id; deduplikace přes Message-ID je LATER).
5. Odebraný člen, který byl v projektu Čtenářem, nemůže své odkazy v tom projektu smazat sám (viewer guard) – purge je hlásí jako přeskočené.
6. `GOOGLE_SERVER_SECRET` je i klíč HMAC odkazů: po jeho rotaci se nové připojení téhož e-mailu nerozpozná jako duplicita starého.
7. Demo/E2E: Next 16 dovolí jen jeden `next dev` na adresář (demo sada Playwrightu neběží souběžně s aplikací 3451).
