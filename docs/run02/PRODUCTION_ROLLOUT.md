# RUN 02 – Google Drive: produkční rollout (runbook)

Stav 2026-11-25: **nic z tohoto dokumentu ještě neproběhlo.** Implementace je na větvi `feature/run02-google-drive`
(lokálně, nepushnuto, tag `run02-complete`). Produkce = stav RUN 01 (`clearspace-ai.vercel.app`, Supabase `twjlnsxjtuntujarwner`,
migrace 0100–0700, 0900, 1000, 1100). Vzor: `docs/collaboration/PRODUCTION_ROLLOUT.md` (RUN 01).
Architektura a bezpečnost: `docs/run02/GOOGLE_DRIVE.md`.

## 1. Rozhodnutí, která potřebuji od vás (blokery)
1. **Google Cloud projekt** (bezplatný; žádná placená služba se nezapíná): doporučuji **dva projekty** –
   `clearspace-dev` (localhost) a `clearspace-prod` (produkce). Důvod: odvolání oprávnění u Googlu ruší grant celého
   *projektu* pro daný účet Google, takže testy na localhostu by jinak mohly odpojit produkční připojení; a produkční
   consent screen nebude mít localhost URI. Gmail (RUN 03) a Kalendář (RUN 04) pak použijí **tytéž** projekty.
2. **Režim consent screenu:** *Testing* (do 100 testovacích uživatelů, refresh token **vyprší po 7 dnech** – každý
   týden „Znovu připojit účet“) vs. *In production* (potřeba ověření značky: veřejná domovská stránka, zásady ochrany
   osobních údajů na ověřené doméně; pro `drive.file` + `openid` + `email` **bez bezpečnostního auditu**).
   Doporučení: začít v *Testing* jen s vašimi účty; portfolio aplikace pak nesmí slibovat „Google Disk pro všechny“
   (UI to netvrdí; připojit se může jen testovací uživatel).
3. Schválení produkční migrace 1200 a nasazení (jedno souhrnné schválení, §6).

## 2. Google Cloud – přesná konfigurace (dělá vlastník; vyžaduje přihlášení do Google)
Pro každý projekt (dev / prod):
1. *APIs & Services → Library*: zapnout **Google Drive API** a **Google Picker API**. Nic jiného.
2. *Google Auth Platform → Branding*: název „ClearSpace“, support e-mail, (prod) domovská stránka a zásady ochrany
   osobních údajů, *Authorized domains*: `clearspace-ai.vercel.app` je subdoména `vercel.app` – Google ověření
   vlastnictví domény `vercel.app` nedovolí; **pro publikování (In production) je potřeba vlastní doména** (např.
   `clearspace.luffast.com`, ověřená v Search Console) a `APP_BASE_URL` na ni. V režimu *Testing* to nutné není.
3. *Audience*: User type **External**; *Testing* + Test users = vaše účty Google (prod), testovací účet (dev).
4. *Data access → Scopes*: přesně `openid`, `…/auth/userinfo.email` (= `email`), `…/auth/drive.file`. Žádné další.
5. *Clients → Create client → Web application*:
   * Authorized JavaScript origins: prod `https://clearspace-ai.vercel.app` · dev `http://127.0.0.1:3441`, `http://localhost:3441`
   * Authorized redirect URIs (přesně, bez zástupných znaků): prod `https://clearspace-ai.vercel.app/api/google/oauth/callback`
     · dev `http://127.0.0.1:3441/api/google/oauth/callback`
6. *Credentials → Create credentials → API key* (Picker): omezit na **Google Picker API**; *Application restrictions:
   Websites* = `https://clearspace-ai.vercel.app/*` a `https://docs.google.com/*` (dev: `http://127.0.0.1:3441/*`, `https://docs.google.com/*`).
7. Poznamenat **číslo projektu** (*Project settings → Project number*, číslo, ne ID).
Tajemství nikdy nevkládejte do konverzace ani do repozitáře.

## 3. Proměnné prostředí (Vercel `clearspace`, Production) – bez hodnot
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (Sensitive), `GOOGLE_SERVER_SECRET` (Sensitive, generuje
skript), `GOOGLE_TOKEN_ENCRYPTION_KEY` (Sensitive, generuje skript), `GOOGLE_PICKER_API_KEY`,
`GOOGLE_CLOUD_PROJECT_NUMBER`. `APP_BASE_URL` už existuje (e-mail). **Nic `NEXT_PUBLIC_*`** → žádná změna
`--build-env` (Monograph příznak beze změny: `NEXT_PUBLIC_ENABLE_MONOGRAPH=1`). Nastavení jedním příkazem se skrytými
výzvami (nic se nenasazuje, vypíše jen SHA-256 serverového tajemství):
```bash
frontend/scripts/set-google-keys.sh
```
Lokální vývoj se skutečným Googlem (dev projekt): stejné proměnné v shellu/`.env.local` mimo repozitář, bez
`GOOGLE_API_MOCK_BASE`, `APP_BASE_URL=http://127.0.0.1:3441`; `server_trust('google')` na lokálním zásobníku registruje
`scripts/drive-stack.sh up` jen pro vygenerované lokální tajemství – pro vlastní hodnotu registrujte její SHA-256.

## 4. Pořadí (stejný osvědčený postup jako RUN 01)
1. **Nácvik na kopii produkčních dat** (lokální kontejner, role `postgres`): `REHEARSAL_CONTAINER=<kontejner>
   CONFIRM_DRIVE=rehearsal frontend/scripts/apply-drive-hosted.sh`, pak rollback a porovnání katalogu
   (`snapshot_catalog.sql`). Lokálně provedeno na syntetických datech i na datech zásobníku RUN 01 (v transakci
   s ROLLBACK): počty řádků beze změny, katalog po rollbacku shodný. Kopie produkce zatím **neproběhla** (vyžaduje
   read-only přístup k produkci, viz §6).
2. Read-only kontrola produkce: markery končí 1100, vlastník `cards`/`projects` = `postgres`.
3. **Migrace:** `CONFIRM_DRIVE=twjlnsxjtuntujarwner GOOGLE_SERVER_SECRET_SHA256=<z kroku §3> frontend/scripts/apply-drive-hosted.sh`
   (pojistky: čistý strom, kontrolní součty migrace/rollbacku, markery, vlastnictví, `pg_dump` zálohy, jedna transakce,
   ověření: počty řádků, RLS na 4 tabulkách, žádný klientský přístup k tokenům, žádné anonymní RPC, 0 odkazů).
   Migrace je aditivní; stávající aplikace (RUN 01) ji ignoruje → bezpečné provést před nasazením kódu.
4. Proměnné ve Vercelu (§3).
5. **Staged build** přes CLI (push do Gitu nenasazuje): `vercel deploy --prod --skip-domain --build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1 …`
   a před promote **porovnat `build.env` s předchozí produkcí** (`vercel api /v13/deployments/<id>`).
6. Kontroly na staged URL: `scripts/check-deployment.sh`, bundle guard (`scripts/check-production-bundle.sh` na buildu),
   `scripts/hosted-verify.sh` (RUN 01 regrese s jednorázovými `@example.test` účty).
   Pozor: staged URL není v redirect URI Googlu → OAuth se testuje až po promote na produkční doméně.
7. **Promote**, živá akceptace (§5), záznam do tohoto dokumentu.

## 5. Živá akceptace (po promote, jen vaše účty a testovací složka)
Připravte v Google Disku složku „ClearSpace test“ s 2–3 nesenzitivními dokumenty (Dokument, Tabulka, PDF). Jiné
soubory nevybírejte – aplikace stejně uvidí jen vybrané.
1. Propojené účty → Připojit Google Disk → souhlas → „Účet Google je připojený.“, správný e-mail.
2. Projekt → Soubory projektu → Přidat soubor z Disku → skutečný Google Picker → vybrat 2 soubory → zobrazí se.
3. Úkol → Google Disk → přidat 1 soubor; znovu tentýž → „Soubor už je připojený.“
4. Druhý prohlížeč (jiný člen projektu, i bez Googlu): soubory se objeví bez obnovení; Aktivita projektu je obsahuje.
5. Otevřít na Disku (vlastník: otevře se; člen bez sdílení v Drive: stránka Googlu „Požádat o přístup“).
6. Náhled textu dokumentu (vlastník) → text; Obnovit informace po přejmenování souboru v Drive → nový název.
7. Odebrat přílohu → zmizí u obou; soubor v Drive zůstává.
8. Odpojit Google účet → v https://myaccount.google.com/permissions ClearSpace zmizí; soubory v projektu zůstanou.
9. Kontrola DB (read-only): `google_connections` obsahuje jen šifrované obálky `v1.…`; `integration_audit` má connected/disconnected.

## 6. Souhrnná žádost o schválení (až budete chtít)
„Schvaluji: (a) read-only kopii produkce pro nácvik migrace 1200 a její smazání, (b) migraci 1200 na
`twjlnsxjtuntujarwner` skriptem `apply-drive-hosted.sh`, (c) staged build + promote větve RUN 02 s nezměněnými
`--build-env`, (d) živou akceptaci podle §5 s mými účty.“ Push / merge do `main` je samostatné rozhodnutí.

## 7. Rollback
* Kód: `vercel promote <předchozí deployment>` (RUN 01 build migraci 1200 ignoruje).
* Databáze: nejdřív uživatelé odpojí účty (revokace u Googlu), pak `psql --single-transaction -f
  frontend/supabase/rollback/20261126001200_google_drive.down.sql` jako vlastník. Skript **odmítne** (nic nezmění),
  dokud existují odkazy nebo připojení (`SET clearspace.rollback_allow_data_loss = 'on'` jen vědomě). Lokálně ověřeno:
  katalog po rollbacku = katalog 1100 (bit po bitu), migrace jde znovu aplikovat. Záloha z kroku §4.3.
* Úplné vypnutí bez rollbacku: smazat `GOOGLE_OAUTH_CLIENT_ID` ve Vercelu → integrace se sama vypne (fail closed).

## 8. Blokery vydání
* Google Cloud projekt, consent screen a klient (§2) – **jen vlastník**.
* Skutečné ověření OAuth + Picker + Drive API proti Googlu: **provedeno v dev projektu** (RUN 02B, `GOOGLE_DRIVE.md` §13, CONDITIONAL PASS); produkční Google projekt a produkční živá akceptace (§5) zbývají.
* Režim *Testing*: 7denní platnost refresh tokenu – akceptovat, nebo vlastní doména + ověření značky.
* Nácvik na kopii produkce (vyžaduje schválení read-only přístupu).

## 9. RUN 02C – plán produkčního rolloutu (konkrétní)
Předpoklady (vlastník, mimo kód): **(a)** rozhodnutí *Testing* vs. *In production* (vlastní doména + ověření značky; `vercel.app` nelze ověřit), **(b)** založení
produkčního Google projektu `clearspace-prod` (§2: Drive API + Picker API, consent screen, Web klient, redirect URI
`https://clearspace-ai.vercel.app/api/google/oauth/callback`, Picker API key omezený na Picker API + referrer), **(c)** souhrnné schválení z §6.

| Fáze | Obsah | Kdo | Brána (musí být splněna, jinak STOP) |
|---|---|---|---|
| 0 | Preflight: čistý strom/tag `run02-complete`, `check-production-bundle.sh` na buildu, produkce read-only: markery končí 1100, vlastník tabulek `postgres` | agent | markery + vlastnictví sedí |
| 1 | Nácvik migrace 1200 na kopii produkčních dat (lokální kontejner), rollback, porovnání katalogu | agent | katalog po rollbacku = katalog 1100; počty řádků beze změny |
| 2 | Tajemství: `frontend/scripts/set-google-keys.sh` (skryté výzvy, Vercel Sensitive; `GOOGLE_*` jen server, nic `NEXT_PUBLIC_*`) | vlastník (zadání), agent (ověření SHA-256) | proměnné existují, tajemství nikdy v chatu |
| 3 | Migrace 1200 na `twjlnsxjtuntujarwner`: `CONFIRM_DRIVE=… apply-drive-hosted.sh` (záloha `pg_dump`, jedna transakce) | agent po schválení | 4 tabulky s RLS, žádné anonymní RPC, 0 odkazů; RUN 01 build migraci ignoruje |
| 4 | Staged build `vercel deploy --prod --skip-domain --build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1`, porovnat `build.env` s předchozí produkcí | agent | `build.env` shodný; bundle guard 48/48; `check-deployment.sh`; `hosted-verify.sh` (RUN 01 regrese) |
| 5 | Promote | agent po schválení | smoke: přihlášení, projekty, realtime |
| 6 | Živá akceptace (§5) jen s účty vlastníka a testovací složkou; navíc scénáře NOT VERIFIED z §14.5, které lze provést: **druhý skutečný Google účet**, odmítnutý souhlas | vlastník + agent | všech 9 kroků §5 PASS |
| 7 | Záznam do dokumentace, tag `run02c-complete`; push/merge do `main` až samostatným rozhodnutím | agent | – |

Rollback: §7 (kód: `vercel promote` předchozí; DB: odpojit účty → rollback skript; vypnutí: smazat `GOOGLE_OAUTH_CLIENT_ID`).
Rizika: režim *Testing* (7denní refresh token, max. 100 testovacích uživatelů, varování o neověřené aplikaci) · Google odvolává grant celého *projektu*
(proto oddělený dev/prod projekt) · staged URL není v redirect URI (OAuth se testuje až po promote) · zapomenutý `NEXT_PUBLIC_ENABLE_MONOGRAPH`.
