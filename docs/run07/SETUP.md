# RUN 07 – nastavení Slack aplikace a Telegram bota pro projekty

Projektový hub používá **vlastní** Slack aplikaci a **vlastní** Telegram bota – oddělené od osobních oznámení RUN 05 (`DECISIONS.md` D5, D6).
Konfigurace aplikace odmítne shodné Client ID / token bota s RUN 05. Všechny URL musí být **veřejné HTTPS** (Slack i Telegram volají server).

## 1. Proměnné prostředí (server; nikdy do klienta – hlídá `check-production-bundle.sh`)

| Proměnná | Hodnota |
|---|---|
| `HUB_SLACK_ENABLED`, `HUB_TELEGRAM_ENABLED` | `1` = zapnuto (výchozí vypnuto, každá routa kontroluje přepínač jako první) |
| `HUB_INTELLIGENCE_ENABLED` | `1` = Project Intelligence smí číst komunikaci kanálů, kde to správce zapnul (kill switch, výchozí 0) |
| `HUB_SERVER_SECRET` | ≥ 32 znaků, jiný než ostatní server secrety; SHA-256 v `server_trust('hub')`; zároveň autentizuje plánovač |
| `HUB_TOKEN_ENCRYPTION_KEY` (+ `_PREVIOUS`) | base64 z 32 náhodných bajtů (`openssl rand -base64 32`), jiný než Google/notify klíč |
| `HUB_SERVICE_EMAIL`, `HUB_SERVICE_PASSWORD` | servisní identita webhooků: obyčejný Supabase uživatel bez projektů; heslo ≥ 16 znaků |
| `SLACK_HUB_CLIENT_ID`, `SLACK_HUB_CLIENT_SECRET`, `SLACK_HUB_SIGNING_SECRET` | z Slack aplikace (Basic Information) |
| `TELEGRAM_HUB_BOT_TOKEN`, `TELEGRAM_HUB_BOT_USERNAME`, `TELEGRAM_HUB_WEBHOOK_SECRET` | token od @BotFather, jméno bota, náhodné tajemství 32–256 znaků `[A-Za-z0-9_-]` |
| `APP_BASE_URL` | veřejná HTTPS adresa aplikace |

## 2. Databáze (jednou na prostředí)
1. Migrace `20261130001600_communication_hub.sql` (produkce jen `scripts/apply-hub-hosted.sh` v rámci schválení vlastníka; předtím `scripts/rehearse-hub-prod.sh`).
2. Servisní identita: vytvořit uživatele (`HUB_SERVICE_EMAIL`, potvrzený e-mail), pak
   `psql -v uid=<auth.users.id> -v secret_sha256=<sha256 hex HUB_SERVER_SECRET> -f frontend/supabase/ops/hub_service_principal.sql`.
3. Plánovač (pg_cron každou minutu → `/api/hub/dispatch`): `psql -v url=https://<APP>/api/hub/dispatch -v secret=<HUB_SERVER_SECRET> -f frontend/supabase/ops/hub_scheduler_enable.sql`;
   vypnutí `hub_scheduler_disable.sql`. **Do produkce jen se schválením.**

## 3. Slack aplikace „ClearSpace Projekty“ (api.slack.com → Create New App → From an app manifest)
Nahraďte `<BASE>` veřejnou HTTPS adresou.
```yaml
display_information:
  name: ClearSpace Projekty
  description: Propojení projektů ClearSpace s vybranými kanály
features:
  bot_user:
    display_name: ClearSpace Projekty
    always_online: false
  slash_commands:
    - command: /clearspace
      url: https://<BASE>/api/hub/slack/commands
      description: Propojení kanálu a účtu s ClearSpace
      usage_hint: propojit KÓD | ucet | stav
      should_escape: false
  shortcuts:
    - name: Vytvořit úkol v ClearSpace
      type: message
      callback_id: clearspace_create_task
      description: Vytvoří úkol z této zprávy
oauth_config:
  redirect_urls:
    - https://<BASE>/api/hub/slack/install/callback
  scopes:
    bot: [chat:write, commands, channels:history, groups:history]
settings:
  event_subscriptions:
    request_url: https://<BASE>/api/hub/slack/events
    bot_events: [message.channels, message.groups, app_uninstalled, tokens_revoked]
  interactivity:
    is_enabled: true
    request_url: https://<BASE>/api/hub/slack/interactivity
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```
* Žádné user scopes, žádné `channels:read` / `users:read` (ClearSpace nevidí seznam kanálů ani lidí workspace).
* Instalace: ClearSpace → Nastavení → *Slack a Telegram pro projekty* → **Nainstalovat do Slacku** (vlastník/správce projektu). Server odmítne jiné scopes než tyto čtyři.
* Kanál: pozvat aplikaci (`/invite @ClearSpace Projekty`), v ClearSpace Projekt → Integrace → *Připojit Slack kanál* → v kanálu `/clearspace propojit KÓD` → potvrdit v ClearSpace.

## 4. Telegram projektový bot (@BotFather)
1. `/newbot` → token do Keychainu / Vercel env (nikdy do repozitáře). **Privacy mode nechat zapnutý** (výchozí).
2. Webhook (jednou; tajemství = `TELEGRAM_HUB_WEBHOOK_SECRET`):
   `curl -sS https://api.telegram.org/bot<TOKEN>/setWebhook -d url=https://<BASE>/api/hub/telegram/webhook -d secret_token=<SECRET> -d 'allowed_updates=["message","edited_message","my_chat_member"]' -d drop_pending_updates=true`
3. Skupina: přidat bota, v ClearSpace *Připojit Telegram skupinu* → ve skupině `/link@<bot> KÓD` (zakladatel/správce skupiny) → potvrdit v ClearSpace.
4. Účet: soukromá zpráva botovi `/start` → odkaz → potvrdit přihlášený v ClearSpace.

## 5. Lokální vývoj a testy (simulace)
```
frontend/scripts/hub-stack.sh up            # stack cs-notify-sb + migrace 1600 + servisní identita (loopback)
frontend/scripts/hub-stack.sh hub-mock      # simulace Slack + Telegram (55623)
frontend/scripts/hub-stack.sh app           # http://127.0.0.1:3471/?login=auto  (HUB_INTELLIGENCE_ENABLED=1 volitelně)
eval "$(frontend/scripts/hub-stack.sh env)"; node frontend/supabase/tests/hub_http.mjs
```
