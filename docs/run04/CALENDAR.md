# RUN 04 – Google Calendar integration (architektura, provoz, testy)

Stav 2026-11-26: v `main` (merge `19a0c6b`) a v produkci s **vypnutým** Kalendářem (`dpl_FeGsSgZx…`). Rozhodnutí: `ARCHITECTURE_DECISION.md`;
soukromí: `PRIVACY_AND_SECURITY.md`; živá akceptace: `LIVE_ACCEPTANCE.md`; produkce: `PRODUCTION_ACCEPTANCE.md`.

## 1. Co uživatel dostane (se zapnutým přepínačem)
* **Propojené účty** (`/settings`): řádek *Google Kalendář* – stav, „Připojit Google Kalendář“ (inkrementální souhlas, jen čtení),
  „Vypnout Kalendář v ClearSpace“ (volitelně smazat mé připojené události), text o tom, že grant u Googlu zůstává.
* **Kalendář projektu** (pohled Kalendář): připojené události (plný rámeček, všichni členové) vedle úkolů podle termínu + přepínač
  **„Můj Google kalendář (vidíte jen vy)“** (čárkovaný rámeček; soukromé kurzívou; smazané přeškrtnuté). Klik na událost: detail;
  u vlastní události „Připojit k projektu“ a „Otevřít v Google Kalendáři“, u připojené Obnovit / Otevřít (jen kdo ji připojil) / Odebrat (editor).
* **Výběr** „Připojit událost z Google Kalendáře“: hledání, období (max. 42 dní), stránkování, výběr ≤ 10, soukromé nelze vybrat, vysvětlení sdílení.
* **Soubory, e-maily a události projektu** (toolbar) a **detail úkolu**: sekce *Události*.
* **Aktivita**: „připojil(a) k projektu událost z Google Kalendáře“ (bez názvu). Vše live přes realtime.

## 2. Architektura
```
POST /api/google/oauth/start {service:'calendar'}  -> 503 calendar_disabled | scopes openid email calendar.events.owned.readonly, include_granted_scopes
     /api/google/oauth/complete                    -> služba ze state; account_mismatch i pro Kalendář; calendar_connected / calendar_denied
GET  /api/google/connection                        -> services {drive, gmail, calendar}, calendarAvailable
GET  /api/calendar/events?from&to[&q&pageToken&pageSize<=250]   vlastní primární kalendář, [from,to) <= 42 dní, no-store
POST /api/calendar/links {projectId, cardId?, eventIds[1..10]}   server znovu načte; private/confidential/zrušené odmítne
POST /api/calendar/links/:id/refresh               jen vlastník odkazu; přesun / zrušení / smazání (404, 410, cancelled -> deleted)
GET  /api/calendar/links/:id/open                  jen vlastník; htmlLink z Googlu (jen hosty google.com), nikdy uložen
DELETE /api/calendar/connection[?purge=1]          vypnout Kalendář v ClearSpace (+ smazat mé odkazy)
```
Soubory: `src/lib/google/{calendar,calendarLinks}.ts`, `src/app/api/calendar/**`, `src/services/calendarService.ts`,
`src/components/calendar/{CalendarLinksPanel,CalendarPickerModal,useProjectCalendarLayers}.tsx`, rozšíření `config.ts`, `server.ts`
(`withServiceToken`, `requireCalendar`; `withGmailToken` = alias), `oauth/{start,complete}`, `connection`, `CalendarView.tsx`, `GoogleConnectionCard.tsx`,
`/privacy`, `/about`, `activityText.ts`, `resources/contract.ts` (`google_calendar_event`, `fromCalendarEvent`). Žádná nová závislost.
Klient API: `fields` ořez (jen id, status, summary, start, end, recurringEventId, originalStartTime, visibility, organizer(displayName,email),
attendees(responseStatus), htmlLink, updated, eventType), timeout 8 s, 1 retry na síť/429/5xx, 401 → 1 vynucený refresh, limit odpovědi 1–2 MB,
`redirect: 'error'`, id validované před sestavením cesty. Pracovní lokace (`workingLocation`) se v seznamu přeskakují.

### 2.1 Data (migrace `20261128001400_google_calendar.sql` + rollback)
* `external_resource_links`: provider `google_calendar_event`; `event_start`, `event_end`, `event_all_day`, `event_time_zone`, `event_recurring`,
  `event_attendees`, `event_organizer` (CHECK: povinné u Calendar řádků, NULL u ostatních; stav jen `ok|deleted`; `web_url` NULL; konec ≥ začátek).
* `calendar_link_sources` (soukromá, RLS bez politik, žádné granty): `event_id`, `recurring_event_id`, `google_sub`, `calendar_id = 'primary'`.
* RPC (server secret + session): `calendar_link_add|_source|_refresh`, `calendar_links_purge_mine`; `google_service_remove|_audit` přijímají `calendar`
  (staré hodnoty beze změny). `external_links_events`: `event_linked|event_unlinked` bez názvu.

### 2.2 Čas (E3/E4)
Ukládá se `timestamptz`. Celodenní = datum v 00:00 UTC, konec exkluzivní, zobrazuje se bez převodu pásma. Časové události v pásmu prohlížeče,
štítek „pásmo události …“, když se liší. Dny v mřížce: událost končící přesně o půlnoci nezabírá další den.

## 3. Konfigurace
| Proměnná | Pozn. |
|---|---|
| `CALENDAR_INTEGRATION_ENABLED` | `1` = Kalendář zapnutý; cokoli jiného = vypnutý (výchozí). Produkce: `0` (Production, plain); Preview nemá |
| ostatní `GOOGLE_*`, `APP_BASE_URL` | beze změny (stejný OAuth klient, stejné šifrování) |
| `GOOGLE_API_MOCK_BASE` | jen lokální testy (mock obsahuje i `/calendar/v3`) |
`/privacy` je dynamická (přepínač za běhu); sekce na `/about` se renderuje při buildu (změna přepínače = redeploy, jako u každé env).

## 4. Lokální vývoj
```
frontend/scripts/calendar-stack.sh up | mock | app      # stack cs-calendar-sb (55570-55579, mail 55584/55585), mock 55592, app 3461
frontend/scripts/calendar-live.sh verify | app | gate [expect-no-calendar] | accept <link|after-change|deleted-linked|off> | revoke-check
eval "$(frontend/scripts/calendar-stack.sh env)"; node frontend/supabase/tests/calendar_http.mjs     # CAL_EXPECT_OFF=1 proti buildu s přepínačem 0
```
DEV login: `http://127.0.0.1:3461/settings?login=auto`. Pro E2E aplikaci spouštějte s `DEV_AUTO_LOGIN=0`.

## 5. Testy (finální kód; Google SIMULOVANÝ kromě řádku „živě“)
| Vrstva | Výsledek |
|---|---|
| Unit (`vitest`) | **1373/1373** (93 souborů; nové `src/__tests__/calendar/*`: 21 knihovna + 14 UI) |
| DB harness (`supabase/tests/run.sh`) | **2378** SQL asercí (94_google_calendar **77**), upgrade 1300→1400 bajtově shodný pro Drive/Gmail, rollback odmítnut při datech/auditu, katalog po rollbacku == 1300, re-apply |
| Calendar HTTP + adversarial (`calendar_http.mjs`) | **18/18** skupin; přepínač OFF na `next start`: **1/1** |
| Regrese Gmail / Drive HTTP | **23/23** / **28/28** |
| E2E (`calendar.spec.ts`, `gmail.spec.ts`, `google-drive.spec.ts`) | **PASS Klasika i Monograph** (3 uživatelé, realtime, mobil dark) |
| RUN 01 | `collab_realtime` 64/64 · `realtime_check` PASS · `invite_email` 41/41 · E2E 10 passed + 2 failed = **TD-1, TD-2** |
| Real stack (`real_stack.sh`, čistý dočasný stack) | SQL **519**, HTTP **29/29** |
| Demo Playwright | 27 passed, 120 skipped, 0 failed |
| Typecheck / lint / build / guard | 0 / 0 chyb (3 stará varování) / OK s DEV příznaky / **77/77**; `next start`: `/api/dev/login` 404 (5 metod) |
| **Živě (skutečný Google, dev projekt)** | brána A/B/C PASS na finálním kódu, akceptace PASS – viz `LIVE_ACCEPTANCE.md` |

## 6. Známá omezení
1. Jen primární kalendář; žádný zápis, sync, webhooky, free/busy (LATER).
2. Sdílená metadata se obnovují jen akcí vlastníka odkazu (Obnovit / Otevřít).
3. Stejná událost od dvou lidí = dva odkazy.
4. Na plném dni mřížka ukáže 3 položky + „+N další“ (bez rozbalení na desktopu – stávající chování kalendáře úkolů).
5. Vlastní událost, která je i připojená, se v kalendáři zobrazí dvakrát (vrstva „můj kalendář“ + událost projektu) – klient záměrně nezná event id.
6. Organizátor vlastních událostí bez jména se sdílí jako doména účtu (např. `@gmail.com`).
