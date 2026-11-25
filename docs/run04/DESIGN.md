# ClearSpace V1 – RUN 04 Google Calendar: návrh (scope, architektura, bezpečnost)

Stav podkladů 2026-11-25: `main` = `9b64ad5` = tag `run03c-complete`; produkce `dpl_3wGY3njT…` z `e9aefbc`, DB do 1300, Gmail OFF.
Zdroj faktů: `docs/run02/HANDOFF_NEXT_RUNS.md`, `docs/run03/{HANDOFF_NEXT_RUNS,ARCHITECTURE_DECISION,GMAIL,PRIVACY_AND_SECURITY,PRODUCTION_ROLLOUT,PRODUCTION_ACCEPTANCE}.md`,
`docs/ROADMAP.md`, `docs/TECH_DEBT.md`, kód `frontend/src/lib/google/*`, migrace `…001200_google_drive.sql`, `…001300_gmail.sql`.

Značky: **[OVĚŘENO]** = z kódu/dokumentace repa nebo z oficiální stránky Google; **[NEOVĚŘENO]** = musí potvrdit Phase 0.

---

## 1. Princip (jedna věta)
Calendar = **třetí služba na existujícím Google připojení**, stejný vzor jako Gmail: inkrementální scope, jen čtení, vlastní výběr událostí,
**sdílená minimální metadata + soukromý zdroj**, osobní přehled vlastních událostí se **nikam neukládá**, přepínač funkce výchozí OFF.

## 2. Funkční rozsah

### MUST-HAVE (RUN 04)
| # | Funkce | Pozn. |
|---|---|---|
| M1 | **Připojit Google Kalendář** v `/settings` (karta Propojené účty: Disk · Gmail · Kalendář), inkrementální souhlas, „Vypnout Kalendář v ClearSpace“ (+ volitelně smazat mé odkazy), odpojení účtu = revokace celého grantu | vzor Gmail |
| M2 | **Osobní vrstva „Můj Google kalendář“** v projektovém pohledu Kalendář (přepínač nad mřížkou). Události **jen z primárního kalendáře přihlášeného uživatele**, jen pro něj, načtené na serveru na vyžádání pro viditelný rozsah (≤ 42 dní), `no-store`, **nic se neukládá** | čte se, nesynchronizuje |
| M3 | **Připojit událost k projektu / úkolu**: dialog „Připojit událost z Google Kalendáře“ – hledání (`q`) + rozsah dat, stránkování ≤ 20, výběr ≤ 10, vysvětlení co se sdílí, nic bez potvrzení. Také z osobní vrstvy („Připojit k projektu“) | vzor `GmailPickerModal` |
| M4 | **Připojené události ve sdíleném kalendáři projektu** (vidí všichni členové, vedle úkolů podle `dueDate`) + sekce *Události* v detailu úkolu + v panelu zdrojů projektu | realtime + aktivita |
| M5 | Vlastník odkazu: **Obnovit informace** (přesun/zrušení v Googlu → aktualizace), **Otevřít v Google Kalendáři** (`htmlLink`, jen vlastník, neukládá se). Editor: **Odebrat** (jen asociace) | vzor Gmail |
| M6 | **Aktivita** „připojil(a) k projektu událost z Google Kalendáře“ (bez názvu) + realtime signál jen s id | `external_links_events` |
| M7 | **Přepínač** `CALENDAR_INTEGRATION_ENABLED=1` (výchozí OFF), kontrolovaný jako první v každé Calendar trase (503 `calendar_disabled`), nezávislý na Drive/Gmail | vzor `gmailFeatureEnabled` |
| M8 | `/privacy` + `/about`: sekce Kalendář (zobrazí se jen se zapnutým přepínačem; jinak „Kalendář není na tomto serveru zapnutý“) | nutné před jakýmkoli zapnutím mimo dev |
| M9 | **Project Intelligence kontrakt**: `ResourceProvider` + `google_calendar_event` v `src/lib/resources/contract.ts`, `aiUse: 'not_consented'`, žádné AI volání | jen typ + test |
| M10 | Mock `/calendar/v3`, izolovaný stack, živá brána, DB/HTTP/E2E testy, bundle guard, produkční skripty (rehearse/apply 1400, kontroly OFF) | vzor RUN 03 |

### LATER (výslovně mimo RUN 04; nic z toho se nescaffolduje)
* **Zápis do Google Kalendáře** (termíny úkolů → událost, vytvoření porady s pozvánkami). Až bude potřeba: nejužší cesta je sekundární kalendář „ClearSpace“ přes `calendar.app.created` (klasifikaci ověřit tehdy), ne `calendar.events`.
* Výběr **dalších kalendářů** než primárního (vyžaduje `calendar.calendarlist.readonly`), sdílené/týmové kalendáře, zdroje (místnosti).
* **Free/busy týmu** a plánování schůzek (`calendar.events.freebusy` / `calendar.freebusy`).
* **Push notifikace / sync** (`events.watch` vyžaduje veřejný HTTPS webhook s platným certifikátem, kanály se neobnovují samy, notifikace „not 100% reliable“; `syncToken` + 410 Gone → plný resync). Pro MVP zbytečné – data se čtou na vyžádání.
* Připojení **celé série** opakované události (MVP připojuje konkrétní výskyt).
* Workspace-wide „Můj kalendář“ napříč projekty; drag karty na jiný den.
* **Meeting Intelligence**: „Vytvořit poradu z události“ (prefill `meetings.title`, `occurred_at`). Vazba **nezávislá na poskytovateli**: spojovací tabulka
  `meeting_resource_links(meeting_id → meetings, link_id → external_resource_links)` (aditivní migrace ≥ 1500), nikdy Google event id v `meetings`.
  Soniox přepis zůstává ruční se souhlasem (`consent_at/by`); jména účastníků se do Sonioxu **neposílají** (rozhodnutí hardening runu). Meet URL jen po schváleném privacy modelu.
  RUN 04 nic z toho neimplementuje; jen nesmí vazbu blokovat (stabilní `link_id`, čas ve sdíleném řádku). Průzkum 0700–0900: `docs/run04/MEETING_INTELLIGENCE_COMPAT.md`.
* **Project Intelligence**: události jako kontext briefu (termíny, milníky) – až po rozhodnutí o AI souhlasu; Meet nahrávky/přepisy (Meet API) mimo rozsah.
* Veřejná syntetická ukázka Kalendáře pro portfolio.

## 3. Vztah ke stávajícím částem ClearSpace
| Část | Dnes [OVĚŘENO] | RUN 04 |
|---|---|---|
| Projektový pohled **Kalendář** (`components/board/CalendarView.tsx`, měsíční mřížka, karty podle `cards.due_date`, klik → `TaskDetailDrawer`) | jen úkoly | + vrstva připojených událostí (sdílená) + přepínač osobní vrstvy (soukromá). Úkoly a jejich logika beze změny |
| **Úkoly** (`cards.due_date DATE`) | – | žádná automatická změna termínu z Googlu ani do Googlu |
| **Porady** (`meetings`: `project_id`, `title`, `occurred_at`, `source_kind text|audio`, Soniox přes `/api/ai/meetings/*`) | existuje | beze změny; jen se navrhne LATER vazba (výše) |
| **Zdroje** (`external_resource_links` + soukromé tabulky) | Drive, Gmail | + provider `google_calendar_event` + `calendar_link_sources` |
| **Projekty / role** (`owner/admin/member/viewer`, `is_project_member`, viewer guard) | existuje | stejná matice jako Gmail (§6) |

## 4. OAuth scopes

Oficiální seznam (developers.google.com/workspace/calendar/api/auth, čteno 2026-11-25) **neuvádí klasifikaci** sensitive/restricted. Handoff RUN 03
předpokládá „sensitive, bez CASA“ → **[NEOVĚŘENO]**, Phase 0 ji odečte v Google Cloud Console (Data Access ukazuje třídu u každého scope).

| Kandidát | Popis Google | Pro RUN 04 |
|---|---|---|
| **`calendar.events.owned.readonly`** | „See the events on Google calendars you own.“ | **Primární volba** – nejužší, primární kalendář uživatel vlastní. Podmínka: živě ověřit, že `events.list/get` na `calendarId=primary` (včetně `q`, `singleEvents=true`) projde |
| `calendar.events.readonly` | „View events on all your calendars.“ | **Fallback**, jen když owned.readonly v Phase 0 neprojde; rozhodnutí zapsat do ADR |
| `calendar.readonly`, `calendar.events`, `calendar`, `calendar.events.owned` | širší / zápis | **nežádat** |
| `calendar.calendarlist.readonly`, `calendar.app.created`, `*.freebusy` | | LATER (viz §2) |

Celkem žádané pro Kalendář: `openid email` + **jeden** Calendar scope. `SERVICE_SCOPE.calendar` = ten scope; logika `keep` v `oauth/complete`
(`Object.values(SERVICE_SCOPE)`) ho pak bere automaticky [OVĚŘENO v kódu].

Režim Testing [OVĚŘENO z RUN 03 ADR]: ≤ 100 test users, autorizace vyprší po 7 dnech; přidání scope mění souhlasovou obrazovku projektu.
Pokud je scope sensitive: veřejné publikování = ověření aplikace (brand + zdůvodnění + demo video), **bez CASA** – to platí jen pro restricted. [NEOVĚŘENO, Phase 0]

## 5. Architektura

```
browser ──Bearer──> POST /api/google/oauth/start {service:'calendar'}   (validace + 503 calendar_disabled; scopes openid email <CAL_SCOPE>)
           Google ──> /api/google/oauth/callback (beze změny) -> /oauth/google -> /api/google/oauth/complete (služba ze state, beze změny logiky)
/api/google/connection     GET: services {drive, gmail, calendar}, calendarAvailable
/api/google/picker-token   beze změny – vždy jen Drive scopes (živá brána: nenese Calendar ani Gmail)
/api/calendar/events       GET  ?from&to (≤ 42 dní) [&q&pageToken]  vlastní primární kalendář, singleEvents, orderBy startTime, ≤ 20/250 položek, no-store
/api/calendar/links        POST připojit ≤ 10 vybraných {projectId, cardId?, eventIds[]} – server znovu načte událost tokenem volajícího
/api/calendar/links/:id/refresh  POST jen vlastník; čas/název/stav (cancelled → 'deleted')
/api/calendar/links/:id/open     GET  jen vlastník; vrátí htmlLink (neukládá se)
/api/calendar/connection   DELETE vypnout Kalendář v ClearSpace [?purge=1]
```
Soubory (nové): `src/lib/google/calendar.ts` (klient API: timeout 8 s, 1 retry s jitterem na 429/5xx, 401 → 1 vynucený refresh, `redirect:'error'`,
limit velikosti odpovědi, validovaná id v cestě), `src/lib/google/calendarLinks.ts`, `src/app/api/calendar/**`, `src/services/calendarService.ts`,
`src/components/calendar/{CalendarLinksPanel,CalendarPickerModal,MyCalendarLayer}.tsx`.
Rozšíření (malá, aditivní): `config.ts` (`CALENDAR_*_SCOPE`, `GoogleService | 'calendar'`, `SERVICE_SCOPE(S)`, `endpoints.calendar`, mock endpoint,
`calendarFeatureEnabled`), `server.ts` (`withServiceToken` = zobecněný `withGmailToken`; `withGmailToken` zůstane jako alias → Gmail trasy beze změny;
`MSG.calendar_*`), `oauth/start` (validace služby), `connection` route, `GoogleConnectionCard.tsx`, `CalendarView.tsx`, `labels.ts`, `activityText.ts`,
`contract.ts`, `/privacy`, `/about`, `google-mock.mjs`, `check-production-bundle.sh`, `check-deployment.sh`, `hosted-verify.sh`/`supabase-hosted.spec.ts`.
**Nemění se**: `drive.ts`, `gmail.ts`, `mime.ts`, `crypto.ts`, `picker.ts`, Gmail/Drive trasy, kryptografie, refresh lease, revokace. Žádná nová závislost.

Časová pásma: ukládá se `timestamptz`; celodenní události (`start.date`) = `event_all_day=true`, datum bez převodu pásma, `end.date` exkluzivní.
Vykreslení v pásmu prohlížeče, štítek pásma u události s jiným `timeZone`. Povinné edge cases E1–E10 (opakované a upravené výskyty, celodenní/vícedenní,
pásma + DST Praha, zrušené/smazané/přeplánované, private/confidential, duplicity, stránkování a hranice rozsahu, expirace/revokace/odmítnutí, izolace tokenů):
`RUN04_PROMPT.md` §4.

## 6. Datový model – migrace 1400 (aditivní, idempotentní, + rollback)
`supabase/migrations/20261128001400_google_calendar.sql` (prefix navazuje na `20261127001300`), preflight „1300 přítomna“.
* `external_resource_links`: provider CHECK + `google_calendar_event`; nové sloupce jen pro Calendar řádky (CHECK): `event_start timestamptz`,
  `event_end timestamptz`, `event_all_day boolean`, `event_attendees int ≥ 0`, `event_recurring boolean`, `event_organizer text` (jméno, jinak jen doména);
  `name` = název (≤ 300, bez řídicích znaků), `web_url` NULL (CHECK), `provider_state` `ok|deleted`, `external_id` = HMAC `gcal:<sub>:<eventId>` (`GOOGLE_SERVER_SECRET`).
  Drive a Gmail řádky bajtově beze změny (upgrade test).
* `calendar_link_sources` (soukromá, RLS bez politik, žádné granty klientům): `link_id` PK FK cascade, `owner_user_id`, `google_sub`, `calendar_id` (CHECK = `'primary'` v MVP), `event_id` (`^[A-Za-z0-9_]{5,1024}$` – ověřit na živých id), `recurring_event_id`.
* RPC (server secret + session, nikdy anon): `calendar_link_add`, `calendar_link_source`, `calendar_link_refresh`, `calendar_links_purge_mine`;
  `CREATE OR REPLACE` `google_service_remove` (whitelist + Calendar scope) a `google_service_audit` (+ `'calendar'`) – **staré hodnoty dál platí** (kompatibilita s buildem RUN 03C).
* `external_links_events`: větev pro Calendar, aktivita `event_linked` / `event_unlinked` bez názvu.
* Rollback `supabase/rollback/…001400_google_calendar.down.sql`: odmítne při Calendar datech/auditu (`clearspace.rollback_allow_data_loss`), katalog po rollbacku == 1300.

## 7. Bezpečnostní a privacy hranice

| Vrstva | Obsah | Kdo vidí |
|---|---|---|
| Google kalendář uživatele | vše | jen vlastník (Google) |
| Osobní vrstva (M2) | název, začátek/konec, celodenní, stav, `htmlLink` | **jen přihlášený uživatel**, jen jeho primární kalendář, nic se neukládá |
| Sdílená metadata odkazu | název, začátek, konec, celodenní, opakovaná ano/ne, počet účastníků, organizátor (jméno, jinak doména), stav, kdo/kdy připojil | členové projektu (RLS) |
| Soukromý zdroj | event id, calendar id, Google `sub` | nikdo z klientů; server jen pro vlastníka odkazu, který je stále členem |
| **Nikdy se neukládá ani nesdílí** | popis, místo, adresy účastníků, Meet/konferenční odkaz, přílohy, `htmlLink`, poznámky | – |

* Události s `visibility` `private`/`confidential` **nelze připojit** (409 se srozumitelnou hláškou) – vlastník je vidí jen ve své vrstvě.
* Token volajícího jen pro jeho data; `same_account` vazba na `sub` (po přepnutí účtu 409); podvržené id → čteno tokenem volajícího → not found.
* `account_mismatch`, odmítnutý scope bez revokace, fail-closed `google_connection_sub` – **beze změny z RUN 03**.
* Picker token zůstává zúžený na Drive; živá brána: nenese Calendar ani Gmail, Calendar API s ním 403.
* Text z Googlu = nedůvěryhodná data, jen React text; žádné HTML. Logy: `/api/calendar/*` mimo request log (query nese hledání), `oauthLog` jen fáze/kódy.
* Meze: rozsah ≤ 42 dní, ≤ 20 výsledků hledání/stránka, výběr ≤ 10, body ≤ 16 kB, stávající rozpočet volání (`cost`), timeouty 8 s.

**Role** (DB + trasa, testováno): připojit událost – owner/admin/member (z vlastního kalendáře, Kalendář povolen), viewer ne; odebrat – owner/admin/member;
obnovit / otevřít – **jen vlastník odkazu**; vidět metadata – členové; odebraný člen nic; purge vlastních odkazů – i po odebrání (viewer guard jako Gmail).
Ani vlastník projektu nevidí kalendář jiného člena.

## 8. Prostředí a nasazení
* Dev: `clearspace-dev`, Calendar API + scope + redirect/origin/Picker referrer pro port **3461**; worktree `V1-calendar`, větev `feature/run04-google-calendar` z `run03c-complete`;
  stack `cs-calendar-sb` (rozsah 55570–55579, mock 55592 – ověřit volnost), DEV login jedním odkazem `…:3461/settings?login=auto`.
* Prod (`clearspace-prod`) se v RUN 04 **nemění**; produkční Kalendář zůstává vypnutý, dokud ho vlastník zvlášť nepovolí. Konsolidace + nasazení s vypnutým Kalendářem jsou schválené podmíněně (všechny brány PASS). Nasazení = kód + migrace 1400 s `CALENDAR_INTEGRATION_ENABLED=0`
  stejným pořadím jako 1300: nácvik na replice → záloha + apply v 1 transakci → starý build (RUN 03C) ověřit na 1400 → merge `--no-ff` → staged → promote → kontroly
  (`EXPECT_DRIVE=1 EXPECT_GMAIL_OFF=1 EXPECT_CALENDAR_OFF=1`). Rollback kódu = promote `dpl_3wGY3njT…`; 1400 se nevrací, dokud ji používá běžící kód.
* Pilot v produkci (Calendar ON pro test users) = samostatné rozhodnutí vlastníka; předpoklady: Phase 0 klasifikace, `/privacy` sekce, živá akceptace PASS.
