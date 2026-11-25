# ADR RUN 04 – Google Calendar: scope, data model, privacy

Status: **přijato a nasazeno s vypnutým přepínačem** (2026-11-25/26). Návrh: `DESIGN.md`; rozhodnutí v běhu: `DECISIONS.md`.

## 1. Ověřená fakta
| Fakt | Zdroj / důkaz |
|---|---|
| Google Calendar API v3 nabízí mj. `calendar.events.owned.readonly` („See the events on Google calendars you own“), `calendar.events.readonly`, `calendar.readonly`, `calendar.app.created`, `calendar.calendarlist.readonly`, `calendar.events.freebusy` | developers.google.com/workspace/calendar/api/auth (čteno 2026-11-25) |
| Stránka scopes **neuvádí klasifikaci** sensitive/restricted | tamtéž |
| **`calendar.events.owned.readonly` je SENSITIVE** (ne restricted): Google Cloud Console → `clearspace-dev` → Data Access ho po přidání zařadil do „Your sensitive scopes“ (Gmail `gmail.readonly` je pod „restricted“) | konzole, 2026-11-25 |
| Sensitive ⇒ veřejné publikování vyžaduje ověření aplikace (brand + zdůvodnění scope + demo), **bez CASA** (ta je jen pro restricted) | support.google.com/cloud/answer/13463817 (citováno v RUN 03 ADR §1); pro Calendar konkrétně NEOVĚŘENO u Googlu, platí obecné pravidlo |
| Živě: token zúžený na tento scope projde `events.list` na `calendarId=primary` s `timeMin/timeMax`, `singleEvents=true`, `orderBy=startTime`, `q`, `maxResults`, `pageToken`, `fields`, i `events.get` výskytu opakované události | `calendar_live_gate.mjs` B (LIVE_ACCEPTANCE.md) |
| Skutečná id událostí i výskytů (`<id>_<YYYYMMDD>T<HHMMSS>Z`) splňují `^[A-Za-z0-9_]{5,1024}$` | live gate B: `ids-not-matching-rule=0` |
| S parametrem `fields` Google neposílá `description`, `location`, `hangoutLink`, `conferenceData`, `attachments` vůbec | live gate B: response keys |
| Push notifikace (`events.watch`) potřebují veřejný HTTPS webhook s platným certifikátem, kanály se neobnovují samy, nejsou 100% spolehlivé; inkrementální sync přes `syncToken`, 410 Gone ⇒ plný resync | guides/push, guides/sync (čteno 2026-11-25) |
| Revokace ruší celý grant aplikace (všechny služby) | RUN 03 ADR; živě znovu `revoke-check` (invalid_grant) |
| Google pro **jediný** nový scope nezobrazí zaškrtávací políčko (souhlas je ano/ne); pro jiný (Drive) granulární políčko ukáže a je **nezaškrtnuté** | živá akceptace 2026-11-25 |

## 2. Rozhodnutí
1. **Scope:** jen `openid email` + `https://www.googleapis.com/auth/calendar.events.owned.readonly`. Fallback `calendar.events.readonly` nebyl potřeba. Žádný zápisový scope; v kódu neexistuje zápisové volání (unit test hlídá).
2. **Jen primární kalendář** uživatele (`calendarId=primary`; `calendar_link_sources.calendar_id` má CHECK `= 'primary'`). Další kalendáře = LATER (`calendar.calendarlist.readonly`).
3. **Osobní vrstva** („Můj Google kalendář“): čtení na vyžádání pro zobrazenou mřížku (6 týdnů = max. 42 dní), `no-store`, nic se neukládá, vidí jen přihlášený uživatel.
4. **Připojení události** = sdílená metadata v `external_resource_links` (provider `google_calendar_event`) + soukromý zdroj `calendar_link_sources`. Soukromé a důvěrné události **nelze připojit**. Připojuje se konkrétní výskyt opakované série.
5. **Vazba na budoucí porady** je provider-neutral přes `external_resource_links.id` (návrh spojovací tabulky `meeting_resource_links` v `MEETING_INTELLIGENCE_COMPAT.md`); v RUN 04 neimplementováno.
6. **Přepínač** `CALENDAR_INTEGRATION_ENABLED=1` (výchozí vypnuto), kontrolován jako první v každé Calendar trase.
7. **Bez synchronizace a webhooků** (MVP): data se čtou na vyžádání, Obnovit dělá vlastník odkazu.

## 3. Důsledky
* Produkce: Calendar vypnutý; zapnutí v pilotu (Testing, test users) nevyžaduje ověření; veřejné zapnutí = ověření aplikace (sensitive), viz `PRODUCTION_ROLLOUT.md` §0.
* „Vypnout Kalendář v ClearSpace“ grant u Googlu neruší (Google neumí zrušit jeden scope) – UI i zásady to říkají.
* Sdílená metadata zastarávají, dokud je vlastník neobnoví (`metadata_checked_at`).
* Stejná událost připojená dvěma lidmi = dva odkazy (různé Google účty); deduplikace přes `iCalUID` = LATER.
