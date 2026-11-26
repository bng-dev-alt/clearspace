#!/usr/bin/env bash
# RUN 05: run the LOCAL app (stack cs-notify-sb) against REAL Slack and Telegram -- the owner's DEV Slack app and DEV Telegram bot only.
# Credentials live ONLY in the macOS Keychain (service below); they are typed at hidden prompts and handed to `security -i` through stdin,
# so they never appear on a command line, in shell history, a file or the output. No Vercel, no production, no other stack.
#
#   frontend/scripts/notify-live.sh set-slack       # Slack dev app: client id + client secret (hidden)
#   frontend/scripts/notify-live.sh set-telegram    # Telegram dev bot: token (hidden) + username
#   frontend/scripts/notify-live.sh status          # which items exist (never values)
#   frontend/scripts/notify-live.sh app             # app on http://127.0.0.1:3471 + https://localhost:3472 (Slack redirect) with REAL providers
#   frontend/scripts/notify-live.sh gate            # live gate: provider credentials valid, least privilege, product path == raw API (no secrets printed)
#   frontend/scripts/notify-live.sh tick [now]      # one scheduler tick by hand (+ collect)
#   frontend/scripts/notify-live.sh revoke-check    # after "Odpojit": the stored Slack token is dead AT SLACK, the Telegram link is gone
#   frontend/scripts/notify-live.sh forget          # delete the Keychain items
# Slack redirect URL to register in the Slack app: https://localhost:3472/api/notify/slack/callback (self-signed certificate, loopback only).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC=${NOTIFY_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Notify dev (live)}
DIR=${NOTIFY_STACK_DIR:-${TMPDIR:-/tmp}/cs-notify-sb}
HTTPS_PORT=${HTTPS_PORT:-3472}
kc_get() { security find-generic-password -s "$SVC" -a "$1" -w 2>/dev/null; }
kc_has() { security find-generic-password -s "$SVC" -a "$1" >/dev/null 2>&1; }
kc_put() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SVC" "$1" "$2" | security -i >/dev/null 2>&1; }
ask() {  # $1 label, $2 regex, $3 hidden(1/0) -> value on stdout
  local v
  if [ "$3" = 1 ]; then read -rsp "$1 (hidden): " v </dev/tty; echo >&2; else read -rp "$1: " v </dev/tty; fi
  v=$(printf '%s' "$v" | tr -d '[:space:]')
  if ! [[ "$v" =~ $2 ]]; then echo "  rejected: ${#v} characters do not match the expected format -- nothing stored" >&2; return 1; fi
  printf '%s' "$v"
}
load_env() {
  export NOTIFY_LIVE=1
  if kc_has slack_client_id && kc_has slack_client_secret; then
    SLACK_CLIENT_ID=$(kc_get slack_client_id); SLACK_CLIENT_SECRET=$(kc_get slack_client_secret); export SLACK_CLIENT_ID SLACK_CLIENT_SECRET
  else export SLACK_INTEGRATION_ENABLED=0; echo "(no Slack dev app in the Keychain: Slack OFF for this run)" >&2; fi
  if kc_has telegram_bot_token && kc_has telegram_bot_username; then
    TELEGRAM_BOT_TOKEN=$(kc_get telegram_bot_token); TELEGRAM_BOT_USERNAME=$(kc_get telegram_bot_username); export TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME
  else export TELEGRAM_INTEGRATION_ENABLED=0; echo "(no Telegram dev bot in the Keychain: Telegram OFF for this run)" >&2; fi
  unset SLACK_API_MOCK_BASE TELEGRAM_API_MOCK_BASE
}
case "${1:-}" in
  set-slack)
    id=$(ask 'Slack app Client ID (Basic Information)' '^[0-9]{3,20}\.[0-9]{3,20}$' 0) && kc_put slack_client_id "$id"
    s=$(ask 'Slack app Client Secret' '^[A-Za-z0-9]{20,64}$' 1) && kc_put slack_client_secret "$s"
    echo "stored (Keychain service: $SVC)";;
  set-telegram)
    t=$(ask 'Telegram bot token from @BotFather' '^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$' 1) && kc_put telegram_bot_token "$t"
    u=$(ask 'Telegram bot username (without @)' '^[A-Za-z][A-Za-z0-9_]{3,31}$' 0) && kc_put telegram_bot_username "$u"
    echo "stored (Keychain service: $SVC)";;
  status) for a in slack_client_id slack_client_secret telegram_bot_token telegram_bot_username; do kc_has "$a" && echo "present: $a" || echo "MISSING: $a"; done;;
  app)
    load_env
    CERT=$DIR/https-localhost.pem; KEY=$DIR/https-localhost-key.pem
    if [ ! -f "$CERT" ]; then umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -keyout "$KEY" -out "$CERT" >/dev/null 2>&1; fi
    node "$HERE/scripts/https-loopback-proxy.mjs" "$CERT" "$KEY" "$HTTPS_PORT" 3471 &
    trap 'kill %1 2>/dev/null || true' EXIT
    echo ">>> LIVE (real Slack / Telegram dev): open https://localhost:$HTTPS_PORT/settings?login=auto  (accept the local self-signed certificate once)"
    APP_BASE_URL_OVERRIDE="https://localhost:$HTTPS_PORT" "$HERE/scripts/notify-stack.sh" app;;
  gate) load_env; eval "$("$HERE/scripts/notify-stack.sh" env 2>/dev/null)"; exec node "$HERE/supabase/tests/notify_live_gate.mjs" "${2:-}";;
  tick)
    q="select public.notify_scheduler_tick(${2:+'$2'})"; P() { docker exec -i -e PGPASSWORD=postgres supabase_db_cs-notify-sb psql -h localhost -U supabase_admin -d postgres -At -q -c "$1"; }
    r=$(P "$q"); echo "$r"; id=$(echo "$r" | sed -n 's/.*"request": \([0-9]*\).*/\1/p')
    if [ -n "$id" ]; then for _ in $(seq 1 100); do [ "$(P "select count(*) from net._http_response where id = $id")" = 1 ] && break; sleep 0.5; done; P "$q"; fi;;
  revoke-check) load_env; eval "$("$HERE/scripts/notify-stack.sh" env 2>/dev/null)"; exec node "$HERE/supabase/tests/notify_live_gate.mjs" revoke-check;;
  forget) for a in slack_client_id slack_client_secret telegram_bot_token telegram_bot_username; do security delete-generic-password -s "$SVC" -a "$a" >/dev/null 2>&1 || true; done; echo "forgotten";;
  *) echo "usage: $0 set-slack|set-telegram|status|app|gate|tick [now]|revoke-check|forget"; exit 2;;
esac
