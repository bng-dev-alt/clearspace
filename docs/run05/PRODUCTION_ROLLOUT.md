# RUN 05 – Slack & Telegram: produkční nasazení (provedeno s oběma přepínači VYPNUTÝMI)

Schválení vlastníka (`RUN_PROMPT.md` §0): konsolidace + nasazení s `SLACK_INTEGRATION_ENABLED=0` a `TELEGRAM_INTEGRATION_ENABLED=0` po splnění bran;
**zapnutí v produkci, produkční Slack aplikace / bot, tajemství a plánovač NESCHVÁLENY**. Záznam provedení: `PRODUCTION_ACCEPTANCE.md`.

## 0. Rozhodnutí vlastníka pro zapnutí (budoucí)
Předpoklad: živá akceptace (`LIVE_ACCEPTANCE.md`) PASS na dev aplikaci/botu.
* **A – nechat vypnuto** (současný stav).
* **B – pilot jen pro vlastníka**: produkční Slack aplikace nainstalovaná jen ve vlastním workspace (bez distribuce), produkční bot; jen vlastní účet.
* **C – veřejně**: Slack „public distribution“ (bez Marketplace stačí), produkční bot; aktualizace `/privacy` (Slack a Telegram jako příjemci) – už připraveno v textu.

## 1. Postup zapnutí (B/C) – až po výslovném schválení
1. Slack: nová aplikace „ClearSpace“ (ne dev): bot scope **jen `chat:write`**, App Home → Messages Tab zapnutý, redirect
   `https://clearspace.luffast.com/api/notify/slack/callback`; (C) Manage Distribution → public.
2. Telegram: nový bot přes BotFather (ne dev bot); **žádný webhook** (propojení přes `getUpdates` na vyžádání).
3. Vercel Production (Sensitive): `NOTIFY_SERVER_SECRET` (≥ 32 náhodných znaků), `NOTIFY_TOKEN_ENCRYPTION_KEY` (base64 32 B), `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`; DB: `insert into server_trust (purpose, secret_sha256) values ('notify', sha256(secret))`.
4. Přepínač(e) `=1` → staged deploy téhož commitu (`deploy-drive-staged.sh` s `EXPECT_NOTIFY_MIGRATION=1`; preflight dnes **odmítá** notify tajemství –
   pro zapnutí upravit tuto kontrolu) → promote.
5. Plánovač: `psql -v url=https://clearspace.luffast.com/api/notify/dispatch -v secret=<NOTIFY_SERVER_SECRET> -f frontend/supabase/ops/notify_scheduler_enable.sql`
   (nainstaluje `pg_cron` + `pg_net`, tajemství do Vault, job každou minutu).
6. Živá akceptace na produkci vlastním účtem (body L1–L9).
7. Zpět: `notify_scheduler_disable.sql` + přepínače `0` + redeploy (fronta poskytovatele se zruší jako `provider_disabled`, uživatelé mohou kanály odpojit i tak).

## 2. Provedené pořadí (RUN 05, oba OFF) – vzor RUN 04
G1 preflight · G2 revize diffu · G3 `rehearse-notify-prod.sh` · G4 kód RUN 04 na DB s 1500 · G5 finální regrese (živě BLOCKED) · G6 přepínače `0` (Production)
· G7 `CONFIRM_NOTIFY=twjlnsxjtuntujarwner frontend/scripts/apply-notify-hosted.sh` · G8 starý build na 1500 · merge `--no-ff` → `main`
· `RELEASE_BRANCH=main EXPECT_GMAIL_MIGRATION=1 EXPECT_CALENDAR_MIGRATION=1 EXPECT_NOTIFY_MIGRATION=1 CONFIRM_DRIVE_DEPLOY=<sha> deploy-drive-staged.sh deploy` + `check`
· `vercel promote` · produkční kontroly (`check-deployment.sh` + `EXPECT_SLACK_OFF=1 EXPECT_TELEGRAM_OFF=1`, `hosted-verify.sh` + `E2E_EXPECT_NOTIFY=off`, Monograph, logy, data).
Staged deploy i hostované ověření **z dočasného čistého stromu / exportu** (hlavní checkout má soubory vlastníka – viz incident v `PRODUCTION_ACCEPTANCE.md`).

## 3. Rollback
* **Kód:** `vercel promote dpl_FeGsSgZxxG2D87Tmx5bEo8b1MFMv` (RUN 04) – na DB s 1500 prokázaně funguje (G4 + G8).
* **DB 1500 nevracet**, dokud běží kód, který ji používá; potom `frontend/supabase/rollback/20261129001500_notification_channels.down.sql` (odmítne s kanály,
  předvolbami, frontou nebo zapnutým plánovačem; jinak obnoví katalog 1400 – ověřeno harness + nácvik). Záloha: `/Volumes/WORKSPACE/_G2_BACKUP/20261126-v1-pre-notify`.
