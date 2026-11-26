#!/usr/bin/env bash
# Run after `npm run build`: the PUBLIC client bundle (.next/static) must not contain the dev-login helper, a
# privileged Supabase key, a Google API key, Google OAuth secrets/tokens/server RPC names (RUN 02), Gmail server RPCs / API host / scope / feature switch (RUN 03), Calendar server RPCs / API host / scope / feature switch / fields (RUN 04), Slack/Telegram switches, secrets, API hosts, tokens and notify RPCs (RUN 05), a speech-to-text provider key/host/test seam, or the retired Supabase project. Also decodes every JWT in the bundle:
# only the `anon` role may appear. Exit 1 on any finding.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -d .next/static ] || { echo "no .next/static -- run npm run build first"; exit 2; }
bad=0
for pat in 'dev-login-btn' 'api/dev/login' 'clearspace-dev-autologin' 'DEV_AUTO_LOGIN' 'x-clearspace-dev-login' 'DEV_LOGIN' 'service_role' 'AIza' 'bjycwqfessddbfocrggt' 'GEMINI_API_KEY' 'AI_OWNER_USER_IDS' 'AI_DEMO_USER_IDS' 'AI_OWNER_DAILY_TOKEN_BUDGET' 'GEMINI_BASE_URL' 'SONIOX_API_KEY' 'STT_SERVER_SECRET' 'STT_TEST_PUBLIC_STORAGE_ORIGIN' 'p_server_secret' 'SONIOX_BASE_URL' 'api.soniox.com' 'api.eu.soniox.com' 'stt-async-v' 'fake-soniox' 'fake-gemini' 'EMAIL_SERVER_SECRET' 'SMTP_PASSWORD' 'SMTP_USER' 'SMTP_HOST' 'email_delivery_start' 'email_delivery_finish' 'AUTH PLAIN' 'STARTTLS' \
  'GOOGLE_OAUTH_CLIENT_SECRET' 'GOOGLE_SERVER_SECRET' 'GOOGLE_TOKEN_ENCRYPTION_KEY' 'GOOGLE_PICKER_API_KEY' 'GOOGLE_API_MOCK_BASE' 'GOCSPX-' 'ya29.' \
  'oauth2.googleapis.com/token' 'google_credentials_get' 'google_oauth_complete' 'google_refresh_store' 'drive_link_add' 'refresh_token_enc' 'mock-at.' '__control/' \
  'GMAIL_INTEGRATION_ENABLED' 'gmail.googleapis.com' 'auth/gmail.readonly' '/gmail/v1/users' 'metadataHeaders' 'gmail_link_add' 'gmail_link_source' \
  'gmail_link_refresh' 'gmail_links_purge_mine' 'gmail_link_sources' 'google_service_remove' 'google_service_audit' 'google_connection_sub' \
  'gmail_caller_sub' 'mock-rt.' 'mock-code.' 'mock-grant-gmail' \
  'CALENDAR_INTEGRATION_ENABLED' 'GOOGLE_PILOT_USER_IDS' 'GOOGLE_PILOT_ACCOUNTS' 'auth/calendar' 'www.googleapis.com/calendar' '/calendar/v3' 'calendar_link_add' 'calendar_link_source' \
  'calendar_link_refresh' 'calendar_links_purge_mine' 'calendar_link_sources' 'calendar_caller_sub' 'mock-grant-calendar' 'attendees(responseStatus)' \
  'SLACK_INTEGRATION_ENABLED' 'TELEGRAM_INTEGRATION_ENABLED' 'NOTIFY_SERVER_SECRET' 'NOTIFY_TOKEN_ENCRYPTION_KEY' 'SLACK_CLIENT_SECRET' 'SLACK_CLIENT_ID' \
  'TELEGRAM_BOT_TOKEN' 'SLACK_API_MOCK_BASE' 'TELEGRAM_API_MOCK_BASE' 'slack.com/api' 'api.telegram.org' 'oauth.v2.access' 'chat.postMessage' \
  'xoxb-' 'xoxp-' 'MOCKmockMOCK' 'x-notify-secret' 'notify_dispatch' 'notify_scheduler_tick' 'notify_link_begin' 'notify_slack_complete' \
  'notify_telegram_attach' 'notify_test_begin' 'secret_enc' 'cs_notify_slack' \
  'HUB_SLACK_ENABLED' 'HUB_TELEGRAM_ENABLED' 'HUB_INTELLIGENCE_ENABLED' 'HUB_SERVER_SECRET' 'HUB_TOKEN_ENCRYPTION_KEY' 'HUB_SERVICE_EMAIL' 'HUB_SERVICE_PASSWORD' \
  'SLACK_HUB_CLIENT_ID' 'SLACK_HUB_CLIENT_SECRET' 'SLACK_HUB_SIGNING_SECRET' 'SLACK_HUB_API_MOCK_BASE' 'TELEGRAM_HUB_BOT_TOKEN' 'TELEGRAM_HUB_WEBHOOK_SECRET' \
  'TELEGRAM_HUB_API_MOCK_BASE' 'x-hub-secret' 'x-slack-signature' 'x-telegram-bot-api-secret-token' 'hub_svc_' 'hub_scheduler_tick' 'hub_dispatch' 'hub_link_begin' \
  'hub_slack_install' 'cs_hub_slack' 'views.open' 'getChatMember' 'chat.getPermalink' 'hub-service@'; do
  n=$(grep -rlF -- "$pat" .next/static 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" != 0 ]; then echo "FAIL: '$pat' found in $n client file(s)"; bad=1; else echo "ok - no '$pat' in the client bundle"; fi
done
# RUN 05: a Telegram bot token (digits:35+ chars) or a Slack token never appears, whatever its name
if grep -rqE '[0-9]{6,12}:AA[A-Za-z0-9_-]{30,}|xox[abp]-[0-9A-Za-z-]{10,}' .next/static 2>/dev/null; then echo "FAIL: a Telegram bot token / Slack token pattern in the client bundle"; bad=1; else echo "ok - no Telegram bot token / Slack token pattern in the client bundle"; fi
roles=$(grep -rhoE 'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}' .next/static | sort -u | python3 -c "
import sys,base64,json
for l in sys.stdin:
    p=l.strip().split('.')[1]; p+='='*(-len(p)%4)
    try: print(json.loads(base64.urlsafe_b64decode(p)).get('role'))
    except Exception: print('undecodable')" | sort -u | tr '\n' ' ')
case "$roles" in ""|"anon ") echo "ok - JWT roles in bundle: ${roles:-none}";; *) echo "FAIL: JWT roles in bundle: $roles"; bad=1;; esac
exit $bad
