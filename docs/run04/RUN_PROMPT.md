# ClearSpace V1 – RUN 04 Google Calendar: MASTER RUN (konsolidovaný prompt)

TRUTH MODE + SCOPE MODE. Jeden dlouhý **autonomní** běh: ověření architektury → implementace → mock akceptace → živá akceptace proti skutečnému Googlu →
nápravy → regrese → konsolidace do `main` → řízené produkční nasazení s **vypnutým** Kalendářem → dokumentace a handoff.

**Autonomie.** Mezi běžnými fázemi nečekej na schválení. Běžná architektonická, implementační, databázová, testovací a UX rozhodnutí v rámci
schváleného rozsahu dělej sám: zvol nejbezpečnější rozumné řešení, zapiš ho do `docs/run04/DECISIONS.md` (rozhodnutí · varianty · důvod · dopad) a pokračuj.
Nekonči po mock akceptaci, pokud živá akceptace a produkční konsolidace mohou bezpečně pokračovat. Mezikroky ukládej jako checkpointy (tagy
`run04-mock-complete`, `run04-live-complete`, `run04-complete`) a pokračuj dál.

**Pravdivost.** Každé tvrzení = příkaz + výstup / počet; jinak **NOT VERIFIED**. Mock ≠ Google: nic z mocku se nepočítá jako živé ověření.
Živou akceptaci lze prohlásit jen na **finálním commitu** (po všech nápravách znovu spustit živou bránu a dotčené body).

## 0. Schválení vlastníka (platí jen toto)
| Oblast | Stav |
|---|---|
| Google Cloud **`clearspace-dev`**: Calendar API, Calendar scope v Data Access, redirect/origin/Picker referrer pro 3461 | **SCHVÁLENO** |
| Živá akceptace proti skutečnému Googlu (dev projekt, Testing, test účet(y) vlastníka) | **SCHVÁLENO** |
| Produkční migrace 1400, merge `--no-ff` do `main`, staged deploy + promote s `CALENDAR_INTEGRATION_ENABLED=0`, push `main` + tagy | **SCHVÁLENO**, pokud projdou všechny povinné bezpečnostní, migrační, regresní a nasazovací brány (§3 Phase 7) |
| Produkční Kalendář zapnutý (pilot), jakákoli změna `clearspace-prod`, publikování consent screen | **NESCHVÁLENO** – produkční Kalendář zůstává vypnutý |
| Ukládání Meet URL nebo jiného soukromého obsahu události | **NESCHVÁLENO** (chybí schválený privacy model) |

## 1. Ověřený výchozí stav
* Repo `/Volumes/WORKSPACE/Dev/Apps/ClearSpace/V1`; `main` = `9b64ad5` = tag **`run03c-complete`** (nasazený kód `e9aefbc`).
* Produkce `https://clearspace.luffast.com` = `dpl_3wGY3njTQ2LWJsaxG7H6Kuitq8ur`; Supabase `twjlnsxjtuntujarwner`, DB markery do **1300**; Gmail OFF
  (`GMAIL_INTEGRATION_ENABLED=0`); OAuth Testing; Google projekty `clearspace-dev` / `clearspace-prod`. Vercel auto-deploy vypnutý (`git.deploymentEnabled:false`);
  nasazuje jen `deploy-drive-staged.sh` + `vercel promote`. Rollback bod kódu: `dpl_3wGY3njT…`.
* Baseline: Vitest **1338/1338**, DB harness **2301**, Gmail HTTP 23/23, Drive HTTP 28/28, prod `check-deployment.sh` **110/110**, `hosted-verify.sh` **17/17**,
  bundle guard 65/65. Známé E2E pády **TD-1, TD-2** (`docs/TECH_DEBT.md`) nejsou regrese.
* Návrh: `/Volumes/WORKSPACE/Dev/Apps/ClearSpace/RUN04_CALENDAR/RUN04_DESIGN.md` – závazný pro rozsah (MUST M1–M10 / LATER), data, privacy a role.
* Čti nejdřív: `docs/run03/{HANDOFF_NEXT_RUNS,ARCHITECTURE_DECISION,GMAIL,PRIVACY_AND_SECURITY,LIVE_ACCEPTANCE,PRODUCTION_ROLLOUT,PRODUCTION_ACCEPTANCE}.md`,
  `docs/run02/HANDOFF_NEXT_RUNS.md`, `docs/ROADMAP.md`, `docs/TECH_DEBT.md`, `docs/LOCAL_DEV.md`; kód `frontend/src/lib/google/*`, `src/app/api/{google,gmail}/**`,
  `src/components/{gmail,drive}/*`, `src/components/board/CalendarView.tsx`, migrace 1200/1300 a skripty `gmail-stack`, `gmail-live`, `google-mock.mjs`,
  `rehearse-gmail-prod`, `apply-gmail-hosted`, `deploy-drive-staged`, `check-deployment`, `check-production-bundle`, `hosted-verify`.

## 2. Pevná pravidla
1. **Znovupoužij, nepřepisuj.** Drive a Gmail kód, kryptografie, refresh lease, revokace, `oauth/callback` a logika `oauth/complete` zůstávají. Povolena jsou jen aditivní
   rozšíření z návrhu §5. `withServiceToken` smí vzniknout zobecněním `withGmailToken` (alias zůstane), jen pokud Gmail chování zůstane shodné (Gmail HTTP 23/23 + E2E).
   Žádná nová npm závislost.
2. **Minimální oprávnění:** `openid email` + jeden Calendar scope (Phase 0). Žádné zápisové volání Calendar API (test grepem).
3. **Izolace služeb:** každá Calendar trasa nejdřív `calendarFeatureEnabled()` (503 `calendar_disabled`), pak auth, pak token jen `service:'calendar'` volajícího.
   Picker token jen Drive. Vypnutí, odmítnutí ani chyba Kalendáře nesmí ovlivnit Drive ani Gmail.
4. **Soukromý obsah:** neukládej ani nevracej jiným uživatelům popis, místo, adresy účastníků, `hangoutLink`/`conferenceData`/Meet URL, přílohy ani `htmlLink`.
5. **Prostředí:** dev = `clearspace-dev` + lokální stack; prod jen dle §0. `GOOGLE_API_MOCK_BASE` nikdy mimo loopback. Tajemství jen Keychain / Vercel Sensitive přes skrytý
   prompt; nikdy v chatu, souboru, logu ani commitu (repo je veřejné).
6. **DEV login:** jediný odkaz `http://127.0.0.1:3461/settings?login=auto` ze skriptu stacku; nikdy nežádej přihlašovací údaje. E2E hosta s `DEV_AUTO_LOGIN=0`.
7. **Design:** Monograph výchozí, Classic (`clearspace-style=existing`) funkční; E2E v obou (desktop light + mobil dark). Jen tokeny.
8. **Rozsah:** jen MUST M1–M10. LATER neimplementuj ani nescaffolduj. **V RUN 04 žádné nahrávání, přepis, automatické připojování ke schůzkám, vytváření porad
   ani AI zpracování.** V2, Artform, redesign a ostatní worktree/stacky (`V1-gmail`, `V1-drive`, …) neměň. Žádná placená AI volání (Soniox ani Gemini).
9. Commity malé, popisné, s `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; žádný rebase sdílené historie.

## 3. Fáze (autonomně za sebou)

### Phase 0 – příprava, ověření architektury, jedno sezení s vlastníkem
1. `git -C V1 worktree add ../V1-calendar -b feature/run04-google-calendar run03c-complete`; zkopíruj návrh → `docs/run04/DESIGN.md`, založ `docs/run04/DECISIONS.md`.
2. Ověř volné porty (3461, 55570–55579, mock 55592); vytvoř `scripts/calendar-stack.sh` (vzor `gmail-stack.sh`) a `calendar-live.sh` (vzor `gmail-live.sh`).
3. **Meeting Intelligence průzkum (jen čtení):** migrace `20261118000700_meeting_audio.sql`, `…0800_stt_stabilization_repair.sql`, `…0900_meeting_creator_erasure.sql`
   (+ `meetings`/`meeting_transcripts` z 0500), kód `src/lib/stt/*`, `src/lib/intelligence/*`, `src/services/meetingService.ts`, `src/components/meetings/*`,
   `docs/intelligence/{ARCHITECTURE,HARDENING_RELEASE_CANDIDATE,SONIOX_API_VERIFICATION}.md`. Výstup `docs/run04/MEETING_INTELLIGENCE_COMPAT.md`: co je znovupoužitelné
   (souhlas `consent_at/by`, `stt_jobs`, `server_trust`, audio retence, citace `meeting:<id>#seg`, kontrakt `ResourceDocument`), co chybí, a **navržená provider-neutral vazba**
   porada ↔ externí událost přes `external_resource_links(id)` (ne přes Google event id; doporučení: budoucí spojovací tabulka `meeting_resource_links(meeting_id, link_id)`).
   V RUN 04 se tato vazba **neimplementuje**; RUN 04 jen nesmí udělat nic, co by ji blokovalo (stabilní `link_id`, čas začátku/konce ve sdíleném řádku, nic Google-specifického v `meetings`).
4. **Jediné sezení s vlastníkem (OWNER SESSION – sloučit všechny nutné interakce do jednoho bloku):**
   připrav předem skripty, aplikaci a přesný checklist, pak požádej najednou o:
   (a) kroky v Google Cloud `clearspace-dev`, které nemůžeš provést sám (Calendar API, scope, redirect `http://127.0.0.1:3461/api/google/oauth/callback`, origin + Picker referrer 3461);
   (b) přihlášení test účtu a udělení souhlasů ve skutečné Google obrazovce (heslo a 2FA zadává jen vlastník);
   (c) přípravu testovacích událostí ve skutečném kalendáři podle seznamu (opakovaná + upravený výskyt, celodenní, vícedenní, jiné pásmo, přes DST, private, confidential, zrušená);
   (d) druhý Google účet, pokud ho má (jinak body s ním = NOT VERIFIED).
   Během sezení rovnou proveď živou sondu (bod 5) a co nejvíc živých bodů, které nevyžadují finální kód; zbytek živé akceptace pak běží bez vlastníka na udělených tokenech.
5. **Klasifikace a živá sonda scope:** odečti třídu Calendar scopes v konzoli (Data Access) a z oficiální dokumentace (stránka scopes ji neuvádí); zapiš s datem a zdrojem.
   Ověř `calendar.events.owned.readonly` na `calendarId=primary`: `events.list` (`q`, `timeMin/timeMax`, `singleEvents=true`, `orderBy=startTime`, `pageToken`) a `events.get`
   včetně výskytu a upraveného výskytu; tvar skutečných id (`^[A-Za-z0-9_]{5,1024}$`); `visibility`. Neprojde-li → `calendar.events.readonly`, důvod do ADR.
   **Je-li scope restricted, nezastavuj se**: zapiš důsledky pro budoucí publikování (ověření + CASA), dev/Testing pokračuje, produkce zůstává vypnutá.
6. `docs/run04/ARCHITECTURE_DECISION.md` (fakta + zdroje, zvolený scope, varianty, důsledky).

### Phase 1 – DB migrace 1400
`supabase/migrations/20261128001400_google_calendar.sql` + `supabase/rollback/…down.sql` podle návrhu §6; preflight „1300 přítomna“; `CREATE OR REPLACE`
`google_service_remove`/`google_service_audit` přijímají staré i nové hodnoty. Unikátnost odkazu = stávající index `(project_id, card_id, provider, external_id)`.
Test `supabase/tests/collab/94_google_calendar.sql` (vzor `93_gmail.sql`): CHECKy, RLS, žádný klientský přístup ke `calendar_link_sources`, anon bez EXECUTE, role, viewer guard,
purge, aktivita bez názvu, duplicity, upgrade 1300→1400 (Drive + Gmail řádky bajtově shodné), rollback odmítnut při datech, katalog po rollbacku == 1300, re-apply.

### Phase 2 – server
Podle návrhu §5: `config.ts`, `server.ts`, `oauth/start` (validace `service`), `connection` route, `src/lib/google/calendar.ts`, `calendarLinks.ts`,
`/api/calendar/{events,links,links/:id/refresh,links/:id/open,connection}`. Normalizace viz §4 (edge cases). Request log ignoruje `/api/calendar/*`. Vlastní české texty chyb.

### Phase 3 – UI
`GoogleConnectionCard` (řádek Kalendář), `CalendarView` (vrstva připojených událostí + přepínač „Můj Google kalendář – vidíte jen vy“), `CalendarPickerModal`,
`CalendarLinksPanel` (projekt + detail úkolu), `activityText`, `/privacy` + `/about` (sekce jen se zapnutým přepínačem). Klávesnice, aria, prázdné/chybové stavy, mobil; Classic i Monograph.

### Phase 4 – mock a automatické testy → checkpoint `run04-mock-complete`
`google-mock.mjs` + `/calendar/v3` a granulární checkbox Kalendáře; syntetická česká data pokrývající **každý řádek §4**. Testy: Vitest (`src/__tests__/calendar/*`), DB 94,
`supabase/tests/calendar_http.mjs` (role, cross-account, podvržené id, meze, logy, grep na zápisová volání), `e2e/calendar.spec.ts` (3 uživatelé, realtime, Classic + Monograph),
regrese Drive + Gmail (HTTP + E2E), RUN 01 sady, `real_stack.sh`, typecheck, lint, build, `check-production-bundle.sh` (+ `auth/calendar`, `www.googleapis.com/calendar`,
`CALENDAR_INTEGRATION_ENABLED`, `calendar_link_source`), `/api/dev/login` 404 v `next start`.

### Phase 5 – živá akceptace (skutečný Google, `clearspace-dev`) → checkpoint `run04-live-complete`
`calendar-live.sh verify|app|revoke-check`, `node supabase/tests/calendar_live_gate.mjs [expect-no-calendar]` (vzor `gmail_live_gate.mjs`). Projdi **každý živý řádek §4** a
body níže; záznam `docs/run04/LIVE_ACCEPTANCE.md` (bod · důkaz · PASS/FAIL/NOT VERIFIED):
inkrementální souhlas jen s Calendar scope · Disk a Gmail dál fungují · osobní vrstva se skutečnými událostmi · hledání · připojení a pohled druhého člena (síťové odpovědi bez
soukromého obsahu) · viewer/odebraný člen · Obnovit · Otevřít jen vlastník · Vypnout Kalendář (grant zůstává) · purge · Odpojit účet (revokace prokázána) · přepínač OFF → 503 všude ·
logy bez citlivých dat · screenshoty Classic + Monograph.

### Phase 6 – nápravy a finální regrese
Každý FAIL oprav, přidej regresní test, zopakuj dotčené mock i **živé** body na finálním commitu. Celá sada z Phase 4 + živá brána znovu na finálním SHA.

### Phase 7 – konsolidace a produkce (sekvence RUN 03C, Kalendář VYPNUTÝ)
Nejdřív na feature větvi: `deploy-drive-staged.sh` (`EXPECT_CALENDAR_MIGRATION`), `check-deployment.sh` (`EXPECT_CALENDAR_OFF`), `hosted-verify.sh`/`supabase-hosted.spec.ts`
(`E2E_EXPECT_CALENDAR`), nové `rehearse-calendar-prod.sh` + `apply-calendar-hosted.sh` – analogicky Gmail, Gmail chování beze změny. Pak brány v pořadí:
* **G1** preflight: Git, Vercel, DB markery do 1300, existující řádky splní nové CHECKy, `deploymentEnabled:false`, produkce = `dpl_3wGY3njT…`.
* **G2** revize diffu `run03c-complete..HEAD` (veřejné repo): žádná tajemství, tokeny, e-maily, ID test událostí.
* **G3** `rehearse-calendar-prod.sh`: replika = produkční DDL + syntetická data Drive/Gmail; testy 92/93/94 na produkčním DDL + 1400; rollback a re-apply.
* **G4** kompatibilita starého buildu: export `run03c-complete` proti DB s 1400 – Drive HTTP 28/28, Gmail HTTP 23/23, Drive E2E.
* **G5** finální regrese z Phase 6 PASS + živá brána na finálním SHA PASS.
* **G6** Production env `CALENDAR_INTEGRATION_ENABLED=0` výslovně (Preview nemá).
* **G7** `CONFIRM_CALENDAR=twjlnsxjtuntujarwner scripts/apply-calendar-hosted.sh`: záloha `pg_dump` → `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-calendar` + SHA256SUMS,
  1 transakce, otisk `external_resource_links`/`google_connections`/`integration_audit`/`server_trust` beze změny.
* **G8** starý build na 1400: `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1) + `E2E_EXPECT_GMAIL=off hosted-verify.sh`.
* Merge `--no-ff` → `main`; `RELEASE_BRANCH=main EXPECT_GMAIL_MIGRATION=1 EXPECT_CALENDAR_MIGRATION=1 CONFIRM_DRIVE_DEPLOY=<sha> deploy-drive-staged.sh deploy` → `check <staged>`
  (Calendar containment: všechny Calendar trasy 503 `calendar_disabled`, `oauth/start` calendar 503, `calendarAvailable:false`, bundle bez Calendar řetězců, `/privacy` „není zapnutý“;
  `build.env` vs. produkce: jediný nový rozdíl `CALENDAR_INTEGRATION_ENABLED`).
* `vercel promote` → `check-deployment.sh` (EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 **EXPECT_CALENDAR_OFF=1**) + `E2E_EXPECT_GMAIL=off E2E_EXPECT_CALENDAR=off hosted-verify.sh`
  + `monograph-prodcheck.mjs` + runtime logy hned (Hobby ~1 h) + data vlastníka beze změny → push `main` + tagy (`run04-complete`).
* Selže-li brána: oprav příčinu a opakuj; nelze-li bezpečně, **před** produkční změnou zastav, **po** ní rollback dle runbooku (kód: `vercel promote dpl_3wGY3njT…`; DB 1400 nevracet,
  dokud ji používá běžící kód) a zapiš.

### Phase 8 – dokumentace a handoff
`docs/run04/{DESIGN,DECISIONS,ARCHITECTURE_DECISION,CALENDAR,PRIVACY_AND_SECURITY,MEETING_INTELLIGENCE_COMPAT,LIVE_ACCEPTANCE,PRODUCTION_ROLLOUT,PRODUCTION_ACCEPTANCE,HANDOFF_NEXT_RUNS}.md`,
aktualizace `docs/ROADMAP.md`, `docs/TECH_DEBT.md`. Handoff: přesné kroky pro případný produkční pilot (co v `clearspace-prod`, privacy, publikování), LATER seznam, vstupní body Meeting/Project Intelligence.

## 4. Povinné edge cases (každý řádek = automatický test proti mocku **a** živý bod, kde to jde; jinak NOT VERIFIED s důvodem)
| # | Případ | Očekávané chování |
|---|---|---|
| E1 | Opakovaná událost a jednotlivé výskyty | `singleEvents=true`; připojuje se konkrétní výskyt (`event_recurring=true`, `recurring_event_id` soukromě); dva výskyty = dva odkazy |
| E2 | Upravený výskyt (výjimka: jiný čas/název, `originalStartTime`) | zobrazí a připojí se upravená verze; Obnovit převezme další změnu výjimky; série beze změny |
| E3 | Celodenní a vícedenní | `start.date`/`end.date` bez převodu pásma, `end.date` exkluzivní; vícedenní přes hranici měsíce i týdne ve mřížce |
| E4 | Pásma a DST (Europe/Prague) | `timestamptz`; událost v jiném `timeZone` se štítkem; přes půlnoc; přechody 2027-03-28 a 2027-10-31 (+ minulý 2026-10-25 živě, je-li v kalendáři); opakovaná přes DST drží místní čas |
| E5 | Zrušená, smazaná, přeplánovaná | `status=cancelled` / 404 / 410 → `provider_state='deleted'`, náhled ani Otevřít se nenabízí; přeplánovaná → Obnovit aktualizuje čas (i mimo zobrazený rozsah) |
| E6 | Private a confidential | ve vlastní vrstvě vlastníka ano; připojení odmítnuto (409, srozumitelná hláška); žádná data do sdílené tabulky |
| E7 | Duplicitní odkazy | stejný uživatel, stejná událost, stejný projekt/úkol → jednou (stávající unikátní index, hláška „už připojeno“); projekt vs. úkol smí koexistovat; dva uživatelé = dva odkazy (zdokumentovat; dedup přes `iCalUID` = LATER) |
| E8 | Stránkování a hranice rozsahu | `pageToken` přes > 1 stránku bez duplicit/děr; událost začínající přesně na `timeMax` není, končící přesně na `timeMin` není, přesahující do rozsahu je; rozsah > 42 dní → 400; obrácený rozsah → 400 |
| E9 | OAuth expirace, revokace, odmítnutý souhlas | `invalid_grant` na refresh → stav „znovu připojit“, nic se nemaže, Drive/Gmail hláška stejná jako dnes; revokace u Googlu (myaccount) → všechny služby „znovu připojit“; odškrtnutý/odmítnutý Calendar → připojení beze změny, žádná revokace, audit `scope_denied`. 7denní expirace Testing živě jen pokud nastane během běhu, jinak NOT VERIFIED (mock + revokace jako náhrada) |
| E10 | Izolace tokenů Drive a Gmail | Picker token bez Calendar i Gmail (tokeninfo + Calendar API 403); Calendar trasy odmítnou bez Calendar scope (409) i když je Drive/Gmail; Gmail trasy beze změny; vypnutí Kalendáře neodebere Drive/Gmail scopes z `google_connections.scopes`; účet A nikdy nečte data účtu B |

## 5. Kdy se zastavit (jediné případy)
(a) OWNER SESSION v Phase 0 (jednou, sloučeně) · (b) krok vyžaduje změnu mimo schválení §0 (např. `clearspace-prod`, zapnutí produkčního Kalendáře, ukládání soukromého obsahu) ·
(c) produkční brána selže a oprava není bezpečně možná · (d) oprava by vyžadovala změnit chování Drive nebo Gmail. Ve všech ostatních případech rozhodni, zapiš a pokračuj.

## 6. Závěrečná zpráva (česky, stručně)
Tabulka fází: výsledek · důkaz (příkaz, počty). Rozhodnutí (odkaz na `DECISIONS.md`). Tabulka E1–E10: mock / živě / NOT VERIFIED. Stav produkce (deployment id, commit, DB marker,
přepínače Gmail/Kalendář). Omezení, zbývající technický dluh, skutečně neověřené případy. Co rozhoduje vlastník dál (produkční pilot).
