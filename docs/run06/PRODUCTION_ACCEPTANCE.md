# RUN 06 – produkční pilot Gmail + Kalendář (provedeno 2026-11-26)

Schválení vlastníka: dokončit produkční pilot podle `PRODUCTION_PILOT.md` vč. merge, push, nasazení; Gmail a Kalendář jen pro
schváleného pilotního uživatele a demo Google účet; publikační režim Google OAuth beze změny.

## Výsledek
| | |
|---|---|
| Produkce | **`dpl_9NkXChVh1c8y7df3gZ4nxAdwZTVM`** (`main` `9065bc4`), promote 2026-11-26 |
| Mezikrok | `dpl_ENFyiR5fuC2fqRaCggfTm1VDNRyu` (`c80daba`) – kód RUN 06 s Gmailem/Kalendářem **vypnutými** (= rollback bez pilotu) |
| Rollback na RUN 05 | `dpl_Gp6omv6sy6jfchmC8rJGRtQ9nAST` |
| Přepínače (Vercel Production) | `GMAIL_INTEGRATION_ENABLED=pilot`, `CALENDAR_INTEGRATION_ENABLED=pilot` (Config), `GOOGLE_PILOT_USER_IDS`, `GOOGLE_PILOT_ACCOUNTS` (Secret, jen Production) |
| Google `clearspace-prod` | Testing (beze změny); test users: vlastník + demo účet; Gmail API + Calendar API zapnuty; Data Access + `gmail.readonly` (restricted), `calendar.events.owned.readonly` (sensitive) |
| DB | žádná migrace; záloha `public` před zápisy: `/Volumes/WORKSPACE/_G2_BACKUP/20261126-v1-pre-run06-presenter` (SHA256SUMS) |

## Brány
| # | Krok | Výsledek |
|---|---|---|
| 1 | Kód: pilotní brána na vstupu všech 8 tras Gmail/Kalendář (`serviceCaller`), pilotní kontroly v `check-deployment.sh`, `deploy-drive-staged.sh` (`EXPECT_GOOGLE_PILOT=1`), hosted E2E „Pilot containment“ | PASS |
| 2 | Regrese: Vitest 1402/1402; HTTP Drive 28 / Gmail 23 / Calendar 18 / pilot 5; build + bundle guard 105/105; živá lokální akceptace (link, isolation) | PASS |
| 3 | Merge `--no-ff` → `main` (`c80daba`), push; staged deploy (přepínače OFF) **148/148** → promote → produkce **147/147**, `hosted-verify.sh` **19/19** + realtime, 0 zbytků | PASS |
| 4 | Prezentační účet: registrace vlastníkem (heslo zná jen vlastník); CSD-CORVANE do jeho workspace (prefix `csdp`, 14 projektů, 0 cizích); výchozí „Vývoj MVP“ odstraněn (jen nedotčená šablona z registrace: 7 karet + 8 aktivit vzniklých 33 s po registraci, žádná úprava ani komentář) | PASS |
| 5 | Pilot env + staged deploy `9065bc4` **146/146** (vč. pilotních kontrol) → promote → produkce **145/145**; `hosted-verify.sh` (E2E_EXPECT_GMAIL/CALENDAR=pilot) **18/18** + 2 přeskočené (OFF testy) + realtime, 0 zbytků | PASS |
| 6 | Izolace (produkce): jednorázový uživatel mimo pilot → `oauth/start` gmail/calendar 503 `*_disabled`, žádná URL Googlu, všechny trasy 503 / anonymně 401, `gmailAvailable`/`calendarAvailable` false, Drive bez Gmail/Calendar scope | PASS |
| 7 | Připojení prezentačního účtu demo účtem (souhlasy odklikány výhradně jako demo účet): Disk → Gmail → Kalendář; uloženo **5 read-only scopů**, jediné spojení demo účtu v produkci | PASS |
| 8 | Propojení s projekty (skutečný Google, UI aplikace): **14 projektů, 19 dokumentů (Google Picker), 14 vláken, 17 událostí**; náhled e-mailu (jen vlastník) zobrazuje skutečný obsah | PASS |
| 9 | Runtime logy produkce (18 záznamů): žádná adresa demo účtu, token, secret ani předmět e-mailu | PASS |

## E-mail (Cloudflare Email Routing)
5 aliasů `clearspace@ microcrm@ support@ sales@ demo@` (luffast.com) → demo Gmail (ověřená cílová adresa). `privacy@`, MX, SPF, DKIM, catch-all
a Resend (`notify.luffast.com`) beze změny. **Doručení ověřeno**: jednorázový produkční účet poslal přes aplikaci (Resend) pozvánku na každý
alias → všech 5 v demo Gmailu (Doručená pošta, ne spam); účet i jeho projekt hned smazány. Gmail filtry (webové UI, bez OAuth): štítky
ClearSpace / MicroCRM / Support / Sales / Demo + „nikdy do spamu“ – štítky se na doručené zprávy aplikovaly.

## NOT VERIFIED / omezení
* Událost Kestrel (akceptační test, proběhla 25. 11.) nepřipojena: výběr událostí v ClearSpace nepovolí začátek období v minulosti (UI).
* Odebrání odkazu v UI používá nativní `confirm()` – v panelu prohlížeče agenta se automaticky zamítne; jeden omylem připojený dokument
  (checklist v projektu politik) proto odstraněn cíleným SQL (1 řádek, `linked_by` = prezentační účet).
* Testing: grant demo účtu vyprší za 7 dní → prezentující znovu připojí (Nastavení → Propojené účty). Přechod do produkce = rozhodnutí vlastníka.
* Omylem vytvořená Vercel proměnná `ZZ_PROBE` smazána (se schválením vlastníka); v běžícím deploymentu zůstává do dalšího nasazení (nepoužívá se).
