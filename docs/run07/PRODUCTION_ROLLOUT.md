# RUN 07 – produkční rollout (připraveno, NEPROVEDENO)

**Stav po RUN 07:** produkce beze změny (D17). Žádná migrace, deploy, proměnná prostředí, Slack aplikace, Telegram webhook ani plánovač.
Produkční katalog při zkoušce: `ea62e3a1b5aeb52e6fdaba9942d50083 lines=3639`, markery končí 1500.

## Pořadí (každý krok jen se schválením vlastníka; „vypnuto“ = `HUB_SLACK_ENABLED`/`HUB_TELEGRAM_ENABLED` nenastavené nebo 0)
1. **Merge do `main`** větve `feature/run07-communication-hub` (čistý merge ověřen proti `63dfbac`). Bezpečné i bez migrace (D18).
2. **Nasazení kódu s vypnutým hubem** – staged build z čistého `git archive` → `check-deployment.sh <staged> EXPECT_HUB_OFF=1` (+ dosavadní
   `EXPECT_DRIVE=1 EXPECT_GMAIL_PILOT/CALENDAR_PILOT=1 EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1`), `hosted-verify.sh` **jen z dočasného exportu**
   (nikdy v hlavním checkoutu – incident RUN 05) → promote. Rollback kódu: předchozí produkční deployment (`dpl_9NkXChVh…`, RUN 06).
3. **Migrace 1600** (až před zapnutím): `scripts/rehearse-hub-prod.sh` znovu (produkce se mohla změnit) → `CONFIRM_HUB=twjlnsxjtuntujarwner scripts/apply-hub-hosted.sh`
   (čistý strom, připnuté SHA-256 migrace i rollbacku, záloha `public` do `/Volumes/WORKSPACE/_G2_BACKUP/<datum>-v1-pre-hub`, jedna transakce,
   ověření počtů, otisků, RLS, grantů, žádné rozšíření). Rollback DB: `supabase/rollback/20261130001600_communication_hub.down.sql`
   (odmítne se, existují-li data hubu nebo cron job).
4. **Živá akceptace** na izolovaném stagingu (owner block, `HANDOFF.md` §4) – produkční zapnutí až po PASS.
5. **Zapnutí v produkci** (samostatné rozhodnutí): produkční Slack app + bot, env (`SETUP.md` §1), servisní identita + `server_trust('hub')`,
   plánovač `hub_scheduler_enable.sql`, Telegram `setWebhook`; nejdřív jen Slack nebo jen Telegram, PI (`HUB_INTELLIGENCE_ENABLED`) odděleně.

## Vypnutí za provozu (kill switches)
* `HUB_INTELLIGENCE_ENABLED=0` – AI přestane číst komunikaci (nic se ani nedotazuje), ingest se zastaví.
* `HUB_SLACK_ENABLED=0` / `HUB_TELEGRAM_ENABLED=0` – všechny routy 503 před podpisem i DB; plánovač dávku zruší (`provider_disabled`).
* `hub_scheduler_disable.sql` – žádné odchozí zprávy; Telegram `deleteWebhook`; Slack: odinstalovat aplikaci (DB to přes `app_uninstalled` promítne).

## Ověřeno v RUN 07 (lokálně / read-only)
* `rehearse-hub-prod.sh` **PASS** (viz `ACCEPTANCE.md` – regrese).
* Produkční build z čistého exportu + bundle guard 132/132 + `check-deployment.sh EXPECT_HUB_OFF=1` 17/17 proti `next start` lokálně.
