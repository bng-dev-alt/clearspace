# RUN 06 – Google demo ekosystém + pilotní režim Gmail / Kalendář

Stav 2026-11-26: **v `main` a v produkci** (`dpl_9NkXChVh…`) – Gmail a Kalendář v **pilotním režimu** jen pro prezentační účet + demo Google účet
(`PRODUCTION_ACCEPTANCE.md`). Žádný nový Google Cloud projekt, žádná placená služba, publikační režim OAuth beze změny (Testing).

| Dokument | Obsah |
|---|---|
| `GOOGLE_DEMO_SEEDER.md` | dataset CS-GDEMO, seeder (oddělený OAuth klient, ochrana identity, idempotence, úklid) |
| `PILOT_MODE.md` | `=pilot` pro Gmail / Kalendář: návrh, chování, testy |
| `LIVE_ACCEPTANCE.md` | živá akceptace s demo účtem (skutečný Google) + NOT VERIFIED |
| `PRODUCTION_PILOT.md` | plán produkčního pilotu (schválen a proveden) |
| `PRODUCTION_ACCEPTANCE.md` | záznam produkčního nasazení, propojení dat a ověření izolace |
| `EMAIL_ROUTING.md` | audit Cloudflare DNS / Email Routing + postup (5 aliasů provedeno, doručení ověřeno) |

## Truth mode – co je skutečné, co simulace
| Oblast | Stav |
|---|---|
| Demo účet Google (Alex Morgan) | **skutečná Google data**: 42 e-mailů / 14 vláken, 21 souborů v 7 složkách, 21 událostí; vloženo přes Gmail / Drive / Calendar API |
| Idempotence + duplicity | **skutečně ověřeno** na demo účtu (2. běh: 0 nových, `duplicates: 0`); úklid + obnova ověřeny **jen proti fiktivnímu Googlu** (na demo účtu jsme nic nemazali) |
| ClearSpace ↔ demo účet | **skutečný Google** (dev projekt `clearspace-dev`, Testing), lokální stack `cs-gdemo-sb`, pilotní režim |
| Propojení s projekty | **skutečné**: vlákna, dokumenty (přes skutečný Google Picker) a události připojené k projektům CSD-CORVANE v lokálním stacku |
| Pilotní režim | mock HTTP + unit testy + **živě** (izolace bob / vera / cizí uživatel) |
| Produkce | **pilot aktivní** (skutečný Google): 14 projektů Corvane prezentačního účtu propojeno s 19 dokumenty, 14 vlákny a 17 událostmi |
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
1. Smazat omylem vytvořenou Vercel proměnnou `ZZ_PROBE` (`vercel env rm ZZ_PROBE production`, potvrdit `y`).
2. Každých 7 dní (Testing) znovu připojit Google u prezentačního účtu, nebo rozhodnout o publikaci aplikace (varování „neověřená aplikace“, strop 100 uživatelů, Gmail restricted ⇒ CASA pro veřejné použití).
3. `V1/frontend/.env.local` stále chybí (incident RUN 05) – obnovit ze svých záznamů (vzor `V1-consolidation/frontend/.env.local`).
4. Konec pilotu: `GMAIL/CALENDAR_INTEGRATION_ENABLED=0` + redeploy; prezentující „Odpojit Google účet“.
