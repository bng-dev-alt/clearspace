# RUN 07 – Project Communication Hub: předání

## 1. Stav jednou větou
Hub je **hotový a otestovaný proti simulaci** (DB, HTTP, E2E, replika produkce), **merge-ready na lokální větvi** `feature/run07-communication-hub`
(worktree `V1-hub`, tag `run07-mock-complete`), **nepushnutý, nenasazený, produkce beze změny**; živá akceptace **BLOCKED** na owner bloku (§4).
`run07-live-complete` neexistuje.

## 2. Co vzniklo
* **DB** `frontend/supabase/migrations/20261130001600_communication_hub.sql` (+ rollback, ops skripty pro servisní identitu a plánovač): 12 tabulek s RLS,
  HMAC klíče místo ID poskytovatelů, šifrované reference, servisní identita (D4), outbox/inbox, triggery z aktivity a komentářů, view pro PI, audit.
* **Server** `frontend/src/lib/hub/*` (konfigurace s oddělením od RUN 05, ověřování podpisů, adaptéry Slack/Telegram, dispatch se souhrny),
  routy `frontend/src/app/api/hub/**` (správa projektu, cíle, identita, instalace Slacku, příkazy, interaktivita, události, Telegram webhook, dispatch).
* **UI**: tlačítko *Integrace* v liště projektu (modal správy: kód, potvrzení, schopnosti, PI s informovaným potvrzením, test, odpojení, audit),
  záložka *Komunikace* v panelu aktivity (hledání, filtr zdroje, poctivý štítek rozsahu), *Konverzace v chatu* v detailu úkolu,
  karta *Slack a Telegram pro projekty* v Nastavení, stránka `/integrations/link`. Classic + Monograph, světlý/tmavý, mobil, česky.
* **Project Intelligence**: zdroj `comm:` (citovatelný, nedůvěryhodný rámec, jen opt-in + `HUB_INTELLIGENCE_ENABLED`).
* **Demo**: statická simulace (`frontend/src/data/hubFixtures.ts`), 0 síťových volání. **About / Privacy** aktualizované.
* **Testy a nástroje**: `96_communication_hub.sql`, `hub_http.mjs`, `e2e/hub.spec.ts`, `src/__tests__/hub/hub.test.ts`, `hub-mock.mjs`, `hub-stack.sh`,
  `rehearse-hub-prod.sh`, `apply-hub-hosted.sh`, bundle guard + `check-deployment.sh EXPECT_HUB_OFF=1`.
* **Dokumenty**: `AUDIT, ARCHITECTURE, THREAT_MODEL, DESIGN, DECISIONS (D1–D21), ACCEPTANCE, PRODUCTION_ROLLOUT, SETUP, HANDOFF`.

## 3. Commity (větev z `main` d1236a2)
`06d1335` docs · `06ea90b` migrace + DB testy · `ddf51f8` server/API · `d98960c` mock, stack, HTTP sada · `d76e61c` UI · `9929861` PI, demo, About/Privacy ·
`9919aa9` E2E · `1bd47e0` brány (zkouška produkce, apply skript, bundle guard, containment) · + závěrečný commit dokumentace.

## 4. OWNER BLOCK (jediný; vše, co potřebuje člověka)
**A. Rozhodnutí / schválení**
1. Push větve + tagu a merge do `main` (čistý merge s `63dfbac` ověřen). → ano / ne
2. Nasazení kódu s vypnutým hubem (`PRODUCTION_ROLLOUT.md` krok 2). → ano / ne / později
3. Kde poběží živá akceptace: **izolovaný staging s veřejným HTTPS** (Slack i Telegram musí volat server; tunely nebyly schváleny).
   Doporučení: samostatný Vercel projekt / preview **bez Deployment Protection** (Slack nepošle bypass hlavičku) + samostatný Supabase projekt (Free) pro staging.
4. Smazání testovacích prostředků (jeden seznam, data jen syntetická, obnovitelná z migrací + seedů; před smazáním záloha dle standardu):
   kontejnery `clearspace-v1-thub` (RUN 07), `clearspace-v1-t95` (RUN 05) – zastavené; stack `cs-notify-sb` – zastavený, data ve volumes;
   adresář `$TMPDIR/cs-hub-build` (export buildu). → smazat / ponechat

**B. Živá akceptace RUN 05 (osobní oznámení)** – beze změny z `docs/run05/LIVE_ACCEPTANCE.md` (dev Slack app pro DM + dev Telegram bot, `notify-live.sh`).

**C. Živá akceptace RUN 07 (projektový hub)** – po A3:
1. Slack: aplikace z manifestu `SETUP.md` §3 (dev workspace, adresa stagingu), hodnoty do Keychainu/Vercel env stagingu.
2. Telegram: nový bot u @BotFather (privacy mode ZAPNUTÝ), `setWebhook` dle `SETUP.md` §4.
3. Staging env dle `SETUP.md` §1, migrace + servisní identita + plánovač dle §2 (na stagingu, ne v produkci).
4. Testovací lidé: 2 účty ve Slacku a 2 v Telegramu (jeden správce skupiny, jeden ne), 2 účty ClearSpace (vlastník + čtenář).
5. Projít A1–A25 živě (tabulka `ACCEPTANCE.md`), zvlášť ověřit: `getChatMember` pro ne-admin bota (D8), odpovědi ve vláknu přes Events API,
   `views.open` do 3 s na Vercelu, `app_uninstalled`, kick bota, `migrate_to_chat_id`.

## 5. Úklid (RUN CLEANUP standard)
Zastaveno: aplikace (3471), mocky (55621/55622/55623), demo/produkční start (3478/3479), stack `cs-notify-sb` (`supabase stop` bez `--no-backup`,
data ve volumes), loopback proxy, kontejnery `clearspace-v1-thub` a `clearspace-v1-t95` (stop, nesmazány). Kontejner zkoušky produkce
`cs-hub-prod-rehearsal` odstranil skript sám (jen produkční DDL + syntetická data, žádná produkční data). Nic cizího se nedotklo
(`cs-collab-sb`, `clearspace-collab-devdb`, `dbos-*`, `microcrm-*` beze změny). Žádné `docker system prune`.

## 6. Ochrana pracovního prostoru vlastníka (A28)
Inventář před během a po něm (jen SHA-256 a velikost, obsah nečten ani nevypsán) – **identické**:
`V1/frontend/.env.local` (835 B), `V1/frontend/test_intro.mp4`, strom `V1/DEMO` (28 souborů), `.env.local` ve `V1-consolidation` a `V1-intelligence`;
`git status` hlavního checkoutu stále jen `?? DEMO/`, `?? frontend/test_intro.mp4`. Žádný symlink do `node_modules` vlastníka (worktree má vlastní APFS klon).
Buildy a kontroly produkčního typu běžely jen z dočasného exportu (`git archive`). `main` se během běhu posunul mimo tento běh (`63dfbac`, pravidla v AGENTS.md).

## 7. Jak pokračovat
```
cd V1-hub/frontend
scripts/hub-stack.sh up && scripts/hub-stack.sh hub-mock & scripts/hub-stack.sh app     # http://127.0.0.1:3471/?login=auto
eval "$(scripts/hub-stack.sh env)"; node supabase/tests/hub_http.mjs
```
Známá omezení: `docs/TECH_DEBT.md` (RUN 07). Další kroky: `docs/ROADMAP.md`.
