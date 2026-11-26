# RUN 06 – Google demo ekosystém + pilotní režim Gmail / Kalendář

Stav 2026-11-26. Větev `feature/google-demo-pilot` (pracovní strom `V1-gdemo`, z `main` = RUN 05), **nic nepushnuto, nemergnuto, nenasazeno**.
Produkce beze změny (`GMAIL_INTEGRATION_ENABLED=0`, `CALENDAR_INTEGRATION_ENABLED=0`). Žádný nový Google Cloud projekt, žádná placená služba.

| Dokument | Obsah |
|---|---|
| `GOOGLE_DEMO_SEEDER.md` | dataset CS-GDEMO, seeder (oddělený OAuth klient, ochrana identity, idempotence, úklid) |
| `PILOT_MODE.md` | `=pilot` pro Gmail / Kalendář: návrh, chování, testy |
| `LIVE_ACCEPTANCE.md` | živá akceptace s demo účtem (skutečný Google) + NOT VERIFIED |
| `PRODUCTION_PILOT.md` | návrh bezpečného produkčního pilotu (k samostatnému schválení) |
| `EMAIL_ROUTING.md` | read-only audit Cloudflare DNS / Email Routing luffast.com + přesný postup pro 5 aliasů |

## Truth mode – co je skutečné, co simulace
| Oblast | Stav |
|---|---|
| Demo účet Google (Alex Morgan) | **skutečná Google data**: 42 e-mailů / 14 vláken, 21 souborů v 7 složkách, 21 událostí; vloženo přes Gmail / Drive / Calendar API |
| Idempotence + duplicity | **skutečně ověřeno** na demo účtu (2. běh: 0 nových, `duplicates: 0`); úklid + obnova ověřeny **jen proti fiktivnímu Googlu** (na demo účtu jsme nic nemazali) |
| ClearSpace ↔ demo účet | **skutečný Google** (dev projekt `clearspace-dev`, Testing), lokální stack `cs-gdemo-sb`, pilotní režim |
| Propojení s projekty | **skutečné**: vlákna, dokumenty (přes skutečný Google Picker) a události připojené k projektům CSD-CORVANE v lokálním stacku |
| Pilotní režim | mock HTTP + unit testy + **živě** (izolace bob / vera / cizí uživatel) |
| Produkce | **nezměněna**; produkční pilot = jen návrh |
| Cloudflare | **jen čtení** (API GET + veřejné DNS); nic nezměněno |

## Výsledky testů (finální kód)
| Sada | Výsledek |
|---|---|
| Vitest (celý frontend) | **1401/1401** (95 souborů) – vč. nového `googlePilot.test.ts` |
| Seeder `node --test scripts/google-demo/seed.test.mjs` | **6/6** (dataset, MIME, Kalendář/DST, ochrana identity, seed → re-seed → úklid → obnova proti fiktivnímu Googlu, odmítnutí cizího účtu bez zápisu) |
| Drive HTTP (mock, `=1`) | **28/28** |
| Gmail HTTP (mock, `=1`) | **22/22** skupin (2. pokus – 1. spadl na 401 z přetíženého lokálního Auth) |
| Calendar HTTP (mock, `=1`) | **18/18** |
| Pilot HTTP `google_pilot_http.mjs` (mock, `=pilot`) | **5/5** (3. pokus – předchozí 401/504 zátěž) |
| `tsc` | čisté (kromě známé chyby `RouteContext`, generuje `next typegen`) |
| ESLint změněných souborů | čisté |
| `npm run build` + `check-production-bundle.sh` | build OK, **105/105** (nově i `GOOGLE_PILOT_USER_IDS`, `GOOGLE_PILOT_ACCOUNTS`) |
| Živá akceptace `gdemo_live_accept.mjs link|drive|isolation` | **PASS** (finální kód, po obnovení spojení) – detail `LIVE_ACCEPTANCE.md` |
| DB (pgTAP) | nespouštěno – RUN 06 nemění schéma ani RPC |

Prostředí: stroj byl během celého běhu přetížený cizími kontejnery (load 35–80, hlavně n8n). Lokální GoTrue proto občas vracel 504/401;
testovací klienti `gdemo_live_accept.mjs` opakují jen tento případ (`ponytail:` komentář). Nejde o chybu ClearSpace.

## Změny v kódu
* `src/lib/google/config.ts`: `serviceMode()`, `serviceAllowedFor()`, `serviceAllowedForAccount()`; nové proměnné `GOOGLE_PILOT_USER_IDS`, `GOOGLE_PILOT_ACCOUNTS`.
* `src/lib/google/server.ts`: `requireGmail/requireCalendar` pouští `pilot`; `getAccessToken` – pilotní kontrola uživatele **a** účtu
  při každém použití tokenu, před kontrolou grantu i bez spojení (stejná odpověď jako vypnuto).
* `oauth/start` (pilot uživatel + už připojený účet), `oauth/complete` (výsledek `pilot_account`, neukládá scope mimo pilot),
  `connection` (`gmailAvailable` / `calendarAvailable` per uživatel), `/privacy` (sekce + poznámka o pilotu), UI hláška `pilot_account`.
* `scripts/google-demo/` (dataset, seeder, testy), `scripts/google-demo.sh`, `scripts/gdemo-stack.sh`, `supabase/tests/google_pilot_http.mjs`,
  `supabase/tests/gdemo_live_accept.mjs`, `check-production-bundle.sh` (+2 vzory), `vitest.config.ts` (vyloučí `scripts/**/*.test.mjs` = node:test).

## Nález během běhu (důležitý pro produkci)
Google zobrazuje a slučuje souhlasy **po projektu**: dokud měl seeder (jiný OAuth klient ve stejném projektu `clearspace-dev`) platný grant,
souhlasová obrazovka ClearSpace hlásila „ClearSpace Dev už má částečný přístup (5 služeb)“ – tj. zápisová oprávnění seederu.
Proto: **seeder se odvolá DŘÍV, než se připojí ClearSpace** (tak to bylo provedeno: po odvolání obrazovka ukázala čistý nový souhlas a ClearSpace
dostal přesně 5 read-only scopů). Pravidlo je v `GOOGLE_DEMO_SEEDER.md` a `PRODUCTION_PILOT.md`.

## Zbývající kroky (vlastník)
1. Rozhodnout o produkčním pilotu (`PRODUCTION_PILOT.md`) – vyžaduje i úpravu `check-deployment.sh` / `hosted-verify.sh` pro `=pilot`.
2. Email Routing: přidat cílovou adresu + 5 pravidel (`EMAIL_ROUTING.md`) – ověřovací e-mail potvrdí vlastník v demo Gmailu.
3. Dialog „chytré funkce“ v demo Gmailu – nastavení účtu, nesahali jsme na něj.
4. Testing režim: refresh token demo účtu u ClearSpace Dev vyprší za 7 dní → znovu připojit (stejný postup).
5. Merge / push větve – na schválení.
