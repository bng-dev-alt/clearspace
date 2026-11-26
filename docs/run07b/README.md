# RUN 07B – Communication Hub: hardening, konsolidace, příprava živé akceptace

Dokumenty: [FINDINGS.md](FINDINGS.md) (nálezy a opravy) · [PROVIDERS.md](PROVIDERS.md) (schopnosti, oprávnění, viditelnost, infrastruktura)
· [OWNER_BLOCK.md](OWNER_BLOCK.md) (jediný blok pro vlastníka) · manifesty `slack-hub-manifest.yaml`, `slack-personal-manifest.yaml`
· základ RUN 07: `docs/run07/*` (rozhodnutí D1–D28, SETUP, PRODUCTION_ROLLOUT).

## 1. Stav
* Kód RUN 07 + 07B je **v `main`** (viz §6), migrace **1600 + 1700** jsou připravené a nacvičené na aktuálním produkčním DDL.
* **Produkce beze změny**: žádná migrace, deploy, env, webhook ani plánovač. Produkční deployment `dpl_9NkXChVh…` (RUN 06 pilot) běží dál.
  Kód hubu je bezpečný i bez migrací, dokud jsou `HUB_*_ENABLED` vypnuté (D18). Aktivace produkce **není** součástí tohoto schválení.
* **Živá akceptace: BLOCKED** – v Keychainu nejsou žádné údaje (ani RUN 05, ani hub); quick tunel Cloudflare při pokusu vrátil 429.
  Vše ostatní je připravené (`OWNER_BLOCK.md`). `run07-live-complete` neexistuje.

## 2. Regrese (2026-11-26, worktree `V1-hub`, stack `cs-notify-sb` s migracemi 0100–1700)
| Sada | Výsledek |
|---|---|
| DB harness (`supabase/tests/run.sh`) | **ALL PASSED – 2670 asercí** (vč. `40_definer_hardening`, K7 96, **K7B 97**, upgrade 1600→1700 otisk, rollback 1700) |
| Vitest | **1425/1425** (mimo sandbox; v sandboxu padají jen testy s lokálními sockety) |
| Hub HTTP (`hub_http.mjs`) | **22/22** s PI vypnutým, **22/22** s PI zapnutým (+ PI bot), OFF containment 1/1 (15 rout 503) |
| RUN 05 osobní oznámení HTTP | **23/23** |
| Google Drive / Gmail / Kalendář HTTP | **28/28 / 23/23 / 18/18** |
| RUN 06 pilot (`google_pilot_http.mjs`, režim pilot) | **5/5** |
| Starý build = `origin/main` 63dfbac (kód produkce) na DB s 1600+1700 | notify 23/23, Drive 28/28, Gmail 23/23, Kalendář 18/18; E2E Gmail, Kalendář, notify, kolaborace PASS |
| E2E hub | **4/4**: Classic + Monograph × (desktop světlý + mobil tmavý / desktop tmavý + mobil světlý) |
| E2E regrese (nový build) | notify, kolaborace ×2, Drive, Gmail, Kalendář, task-resources 5/6 (**TD-2** známý), PI spec skip (vyžaduje fake Gemini) |
| E2E demo (produkční build, `next start`) | kanban + Monograph: Classic 18/18 (+1 skip), Monograph 19/19 |
| Izolace dema | simulace se štítkem, **0** požadavků na `/api/hub`, Slack, Telegram (prohlížeč) |
| Produkční build z čistého `git archive` | PASS; **bundle guard 138/138** |
| Containment (`check-deployment.sh EXPECT_HUB_OFF=1` na produkčním buildu) | **18/18** (vč. `pi-webhook`) |
| Zkouška na replice produkčního DDL (`rehearse-hub-prod.sh`) | **REHEARSAL PASS** (viz §4) |

**Vyšetřená neočekávaná selhání**: Gmail/Kalendář E2E zprvu padaly (aktivita psala „soubor z Disku“). Příčina = **artefakt stacku**:
spouštěcí smyčka znovu aplikovala migraci 1200 a zastavila se na 1300 (stará testovací data), takže funkce `external_links_events` z 1200
přepsala verzi z 1400. Ověřeno, že stejně padal i starý build; po znovuaplikaci 1400–1700 obě sady PASS. Kód ani migrace hubu se toho
netýkají; skript `hub-stack.sh` už starší migrace na běžícím stacku znovu neaplikuje (TECH_DEBT).

## 3. Mock × živě
| Oblast | Mock / DB / HTTP / E2E | Živě |
|---|---|---|
| Propojení kanálu / skupiny, potvrzení, schopnosti, odpojení, purge (A1–A6, A24) | PASS | BLOCKED |
| Podpisy, replay, tajemství, rozsah tunelu (A7) | PASS; brána ověřena lokálně (UI/DEV login/API 404, webhooky bez podpisu 401) | BLOCKED (tunel 429) |
| Oznámení, souhrny, rate limit, výpadky (A10, A18) | PASS | BLOCKED |
| Úkol ze Slacku / Telegramu, identita, autorizace (A12–A14, R1) | PASS | BLOCKED |
| Synchronizace vláken, smyčky, deduplikace, odolný inbox (A15–A17, D23) | PASS | BLOCKED |
| Revokace, odebrání bota, „Ověřit znovu“ (A19, R7, R11) | PASS | BLOCKED |
| PI opt-in, viditelnost privacy mode, PI bot (A20–A23) | PASS | BLOCKED (getMe.can_read_all_group_messages ověří `hub-live.sh gate`) |
| Prompt-injection s živým modelem (A25) | PASS (kontext, citace, účely) | NOT VERIFIED (není klíč / rozpočet AI) |
| Osobní oznámení RUN 05 | PASS | BLOCKED (owner block RUN 05) |

## 4. Zkouška migrací na aktuálním produkčním DDL
Produkce jen čtena (markery končí 1500, katalog `ea62e3a1b5aeb52e6fdaba9942d50083 lines=3639` = stejný jako v RUN 07). Replika A = katalog
produkce; replika B (produkční DDL + syntetická data) → `apply-hub-hosted.sh` v režimu zkoušky: 1600 + 1700 v **jedné transakci**, počty
řádků a otisky (aktivita, komentáře, notifikace, kanály RUN 05, odkazy, Google, trust) beze změny, žádné rozšíření, `marker=2 rls=12
anon_exec=0 dispatch_exec=0 triggers=2` a prázdný hub. Sady 92 (73), 93 (70), 94 (77), 95 (143), 96 (93), 97 (56) na DDL produkce + 1600/1700;
parita in-app notifikací 1500 = 1600+1700; rollback odmítnut s daty; 1700 down + 1600 re-apply → 1600 down → katalog = produkce (1500);
opětovné použití 1600 + 1700. SHA-256 všech čtyř souborů připnuté v `apply-hub-hosted.sh`.

## 5. Doporučený řízený rollout (každý krok samostatné rozhodnutí vlastníka)
1. **Živá akceptace** dle `OWNER_BLOCK.md` (lokálně, syntetická data) → `run07-live-complete` jen při PASS.
2. **Migrace 1600 + 1700 v produkci** (až po živé akceptaci, mimo okno prezentace pilotu): `rehearse-hub-prod.sh` znovu → `CONFIRM_HUB=… apply-hub-hosted.sh`
   (záloha `public` do `_G2_BACKUP`, jedna transakce, ověření). Nasazení **kódu** je nezávislé (D18) – doporučuji spojit s příštím plánovaným deployem.
3. **Produkční aplikace/boti** (oddělené od dev): Slack app z manifestu s produkční doménou, projektový bot, volitelně PI bot; env (`docs/run07/SETUP.md` §1);
   servisní identita + `server_trust('hub')`; plánovač `hub_scheduler_enable.sql`.
4. **Pilot**: zapnout jen `HUB_TELEGRAM_ENABLED` **nebo** `HUB_SLACK_ENABLED` pro jeden projekt vlastníka; PI (`HUB_INTELLIGENCE_ENABLED`) až samostatně.
5. Kill switches a rollback: `docs/run07/PRODUCTION_ROLLOUT.md`.

## 6. Git
* Větev `feature/run07-communication-hub` (z `main` d1236a2) sloučena s `origin/main` 63dfbac (jen AGENTS.md, čistě) → merge `512fb99`;
  `main` **fast-forward** 63dfbac → 512fb99 v hlavním checkoutu `V1` (nesledované soubory vlastníka nedotčeny) a push; žádný force push.
* Tagy (pushnuté): `run07-mock-complete` (RUN 07), `run07b-hardening-complete` (512fb99). `run07-live-complete` neexistuje.
* Vercel má `git.deploymentEnabled: false` → push do `main` **nic nenasadil** (ověřeno: poslední produkční deploy zůstává `dpl_9NkXChVh…`).
* GitHub secret scanning: 1 otevřené upozornění **z RUN 05** (26. 11. 01:10 UTC, `frontend/src/__tests__/notify/notify.test.ts:12`, syntetický
  testovací token „Telegram Bot Token“, platnost neznámá) – žádné nové z tohoto pushe; zavření jako „used in tests“ = rozhodnutí vlastníka.
* Místní sken diffu proti `origin/main`: žádné tokeny, klíče, `.env` ani osobní identifikátory (jen veřejné ID Supabase projektu, ve `main` už ve 23 souborech).

## 6b. Úklid (RUN CLEANUP standard)
Zastaveno: aplikace 3471, mocky 55621/55622/55623, brána 3473, `next start` 3478, quick tunel (vlastní proces; pojmenované tunely vlastníka
PID 1343/1691 nedotčeny), stack `cs-notify-sb` (`supabase stop` bez `--no-backup`, data ve volumes, sdílený s RUN 05 – ponechán), loopback proxy.
Odstraněno (schváleno): kontejner `clearspace-v1-thub` (RUN 07, bez volumes, jen syntetická DB `tdb`, obnovitelná z migrací), dočasné exporty
`cs-hub-build` a `cs-hub-oldbuild`. Kontejner zkoušky produkce odstraňuje skript sám. Ponecháno: `clearspace-v1-t95` (RUN 05, zastavený).

## 7. Integrita souborů vlastníka
Hashe (obsah nečten) `V1/frontend/.env.local`, `V1/frontend/test_intro.mp4`, strom `V1/DEMO`, `.env.local` ve `V1-consolidation` a `V1-intelligence`
před RUN 07 i po RUN 07B **identické**; `git status` hlavního checkoutu jen `?? DEMO/`, `?? frontend/test_intro.mp4`.

## 8. Incident během běhu (otevřeně)
Při restartu stacku jsem jednou spustil `supabase start` bez loopback proxy: porty stacku `cs-notify-sb` byly ~1 minutu dostupné na
`0.0.0.0` (LAN). Stack obsahuje jen syntetická data a lokální výchozí klíče; ihned zastaven (data zachována) a znovu spuštěn přes
loopback-only spouštěč, který LAN vystavení odmítá. `hub-stack.sh` nyní stack startuje výhradně tímto spouštěčem a navíc kontroluje porty.
