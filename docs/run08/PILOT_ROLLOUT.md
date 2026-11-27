# RUN 08 – řízený produkční pilot Communication Hubu (PŘIPRAVENO, NEAKTIVOVÁNO)

**Produkce je beze změny.** Tento postup se provede až po samostatném schválení vlastníka. Každý krok je vratný a má vlastní vypínač.

## Rozsah pilotu
| | |
|---|---|
| Účet | jen účet vlastníka: `HUB_PILOT_USER_IDS=<id účtu vlastníka>` (nové v RUN 08) – ostatní účty dostanou u Integrací 403 „zatím v pilotním provozu“ |
| Projekt | jeden testovací projekt (nový, bez klientských dat) |
| Poskytovatel | **jen Slack** (živě ověřen v RUN 08); Telegram až po živém testu skupiny (`HUB_TELEGRAM_ENABLED` zůstává 0) |
| Project Intelligence | **vypnuto** (`HUB_INTELLIGENCE_ENABLED` nenastaveno) – server odmítne i ruční zapnutí u kanálu (oprava RUN 08) |
| Veřejné spuštění | ne; Slack aplikace zůstává neveřejná (jen workspace vlastníka) |
| RUN 06 pilot (Gmail/Kalendář) | nedotčen – jiné tabulky, jiné proměnné, jiný plánovač |

## Stav produkce ověřený 2026-11-27 (read-only)
* Markery `public.clearspace_migrations` končí `20261129001500_notification_channels` – 1600/1700 nejsou nasazené.
* Soubory migrací 1600 a 1700 jsou bajtově shodné s nazkoušenými (SHA-256 `197b3449…`, `8d870e91…`, připnuté v `apply-hub-hosted.sh`)
  → **nová zkouška není nutná**; skript před zápisem stejně znovu ověří markery, vlastnictví tabulek a pomocné funkce a jinak odmítne.
* Produkční deployment: `dpl_9NkXChVh1c8y7df3gZ4nxAdwZTVM` (RUN 06). Vercel má `git.deploymentEnabled: false` – push do `main` nic nenasadí.

## Postup (každý krok samostatně, v tomto pořadí)
1. **Kód s vypnutým hubem**: staged build z čistého `git archive` větve `main` → `check-deployment.sh <staged> EXPECT_HUB_OFF=1`
   (+ `EXPECT_DRIVE=1 EXPECT_GMAIL_PILOT=1 EXPECT_CALENDAR_PILOT=1 EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1`) → promote.
   Rollback: promote předchozího deploymentu `dpl_9NkXChVh…`.
2. **Migrace**: `CONFIRM_HUB=twjlnsxjtuntujarwner frontend/scripts/apply-hub-hosted.sh` (záloha `public` do `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-hub`,
   jedna transakce, kontrola počtů, otisků, RLS, grantů). Rollback: `supabase/rollback/*1700*.down.sql` a `*1600*.down.sql` (odmítnou se, existují-li data hubu).
3. **Produkční Slack aplikace** (oddělená od vývojové): manifest `docs/run08/slack-hub-manifest.yaml` s `<BASE>` = `https://clearspace.luffast.com`
   (events, commands, interactivity, redirect). Tajemství jen do Keychainu (`hub-live.sh setup` pro produkční službu) a do Vercel env (Production).
4. **Proměnné (Vercel Production)**: `HUB_SLACK_ENABLED=1`, `HUB_PILOT_USER_IDS` (id účtu vlastníka), `HUB_SERVER_SECRET`, `HUB_ROUTING_KEY`, `HUB_TOKEN_ENCRYPTION_KEY`, `HUB_SERVICE_EMAIL/PASSWORD`,
   `SLACK_HUB_CLIENT_ID/SECRET/SIGNING_SECRET`, `APP_BASE_URL`; **nenastavovat** `HUB_TELEGRAM_ENABLED`, `HUB_INTELLIGENCE_ENABLED`. Nové generované hodnoty, ne vývojové.
5. **Servisní identita + důvěra**: `hub_service_principal.sql` (SETUP.md §2.2).
6. **Redeploy** → `EXPECT_HUB_SLACK_PILOT=1 check-deployment.sh <staged>` → promote.
7. **Plánovač**: `hub_scheduler_enable.sql` s `url=https://clearspace.luffast.com/api/hub/dispatch`.
8. **Akceptace pilotu (vlastník, ~5 min)**: Nastavení → Slack pro projekty → Nainstalovat; v testovacím projektu Integrace → Připojit Slack → zkopírovat příkaz
   do kanálu → potvrdit → Zkušební zpráva; vytvořit úkol → oznámení do 1–2 min; komentář ↔ vlákno.

## Vypínače (okamžité, bez migrace)
* `HUB_SLACK_ENABLED=0` + redeploy → všechny Slack routy 503 ještě před podpisem a DB; plánovač dávky zruší (`provider_disabled`).
* `hub_scheduler_disable.sql` → nic se neodesílá.
* Slack: odinstalovat aplikaci ve workspace → `app_uninstalled` / `tokens_revoked` odřízne instalaci i kanály (ověřeno živě v RUN 08, test 10).
* Úplný návrat: rollback kódu (krok 1) a případně down-migrace (krok 2).
