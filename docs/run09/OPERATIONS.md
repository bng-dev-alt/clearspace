# Communication Hub + osobní oznámení – produkční provoz (RUN 09)

Produkce: `https://clearspace.luffast.com`, Supabase `twjlnsxjtuntujarwner`, Vercel `clearspace` (nasazuje se jen staged buildem, Git deploy vypnutý).

## Identity a tajemství (hodnoty jen v Keychainu a Vercelu, nikdy v repu/chatu)
| Identita | Keychain (service \| account) | Vercel (Production, Sensitive) |
|---|---|---|
| Slack „ClearSpace Projekty“ A0CMK6CGW8L | `ClearSpace V1 - Hub (production)` \| slack_hub_client_id/secret, slack_hub_signing_secret | SLACK_HUB_* |
| Slack „ClearSpace oznámení“ A0CMH9F3N1X | `ClearSpace V1 - Notify (production)` \| slack_client_id/secret | SLACK_CLIENT_ID/SECRET |
| @ClearSpaceRelayBot (projekty, webhook) | Hub (production) \| telegram_hub_bot_token/username, telegram_hub_webhook_secret | TELEGRAM_HUB_* |
| @ClearSpaceHQBot (osobní, getUpdates) | Notify (production) \| telegram_bot_token/username | TELEGRAM_BOT_* |
| @ClearSpaceCortexBot (stage 2, neaktivní) | Hub (production) \| telegram_pi_bot_*, telegram_pi_webhook_secret | – (až stage 2) |
| Serverová tajemství | Hub \| hub_server_secret, hub_routing_key (NIKDY nerotovat), hub_token_encryption_key, hub_service_email/password; Notify \| notify_server_secret, notify_token_encryption_key | HUB_*, NOTIFY_* |
| Pilot | Hub \| pilot_user_ids (= prezentační účet, ADR RUN 09-01) | HUB_PILOT_USER_IDS, NOTIFY_PILOT_USER_IDS |

Dev položky (`… Hub dev (live)`, `… Notify dev (live)`) mají mrtvé hodnoty (rotace 2026-11-27) – kromě `cloudflare_tunnel_token`.

## Nástroj `frontend/scripts/hub-prod.sh`
`status` (jen čtení) · `owner` (vlastník vkládá rotované údaje, skrytě) · `verify` (tvar, getMe, staré tokeny mrtvé) · `gen-server` ·
`register` (servisní identita přes SQL, bez e-mailu) · `push-env stage1|stage2` · `telegram-webhook relay|cortex [off]` ·
`scheduler hub|notify on|off`. Nasazení: `RELEASE_BRANCH=<větev> CONFIRM_DRIVE_DEPLOY=<sha> EXPECT_GMAIL_MIGRATION=1 EXPECT_CALENDAR_MIGRATION=1
EXPECT_GOOGLE_PILOT=1 deploy-drive-staged.sh deploy` → `check-deployment.sh` s `EXPECT_DRIVE=1 EXPECT_GMAIL_PILOT=1 EXPECT_CALENDAR_PILOT=1
EXPECT_HUB_PILOT=1 EXPECT_HUB_TELEGRAM=1` → `vercel promote`.

## Nastavení poskytovatelů (stav k 2026-11-27)
* Slack Projekty: manifest `docs/run08/slack-hub-manifest.prod.yaml` (události: message.channels, message.groups, app_uninstalled,
  tokens_revoked → `/api/hub/slack/events`, Verified); bez user scopes. Pozor: po odvolání tokenu je bot mimo kanály – pozvat `/invite @ClearSpace Projekty`.
* Slack oznámení: `docs/run09/slack-personal-manifest.prod.yaml`.
* Relay webhook: `hub-prod.sh telegram-webhook relay` (secret_token povinný; bez něj 401).
* Plánovače: pg_cron `clearspace-hub-dispatch`, `clearspace-notify-dispatch` (každou minutu, Vault secret + URL).

## Vypínače (okamžité)
| Co | Jak |
|---|---|
| Slack / Telegram hub | `HUB_SLACK_ENABLED=0` / `HUB_TELEGRAM_ENABLED=0` + redeploy (routy 503 před podpisem) |
| Osobní oznámení | `SLACK_INTEGRATION_ENABLED=0` / `TELEGRAM_INTEGRATION_ENABLED=0` + redeploy |
| Odesílání | `hub-prod.sh scheduler hub off`, `scheduler notify off` (bez redeploye) |
| Telegram vstup | `hub-prod.sh telegram-webhook relay off` |
| Pilot | `HUB_PILOT_USER_IDS` / `NOTIFY_PILOT_USER_IDS` (prázdné = všichni – nikdy nenechávat prázdné) |

## Rollback
1. Kód: `vercel promote dpl_9TGb58PMpAF8CnEY482wNbwi9mt4` (RUN 09 kód postavený ještě bez proměnných hubu → hub i osobní oznámení vypnuté,
   pilot Google beze změny) nebo `dpl_9NkXChVh1c8y7df3gZ4nxAdwZTVM` (RUN 06, bez kódu hubu; DB s 1600/1700 je s ním kompatibilní).
2. Plánovače off, webhook off.
3. DB (jen pokud nutné, data hubu se ztratí): rollback 1700 a 1600 (`frontend/supabase/rollback/`), odmítne se, existují-li data hubu → nejdřív
   odpojit cíle. Zálohy: `/Volumes/WORKSPACE/_G2_BACKUP/20261127-v1-run09-pre-hub-encrypted` (public+auth) a `20261127-v1-pre-hub` (public),
   AES-256, klíč Keychain `g2-backup-20261127-v1-run09-pre-hub`.

## Zdraví
`hub-prod.sh status` (instalace, cíle, identity, outbox, cron, webhooky) · `cron.job_run_details` (succeeded) · `net._http_response` (200 + outcome
`sent`) · logy Vercelu: jen whitelistované fáze (`evt: hub|notify`), žádné tokeny ani texty.
