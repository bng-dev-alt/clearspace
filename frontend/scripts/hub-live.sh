#!/usr/bin/env bash
# RUN 07B: LIVE acceptance of the Communication Hub (and, in the same session, the RUN 05 personal notifications) on the ISOLATED local
# stack (cs-notify-sb, synthetic data) against REAL Slack and Telegram -- the owner's DEV apps / bots only. Never production, never Vercel.
#
# Exposure: the internet reaches ONLY scripts/hub-webhook-gate.mjs (5 POST webhook paths, everything else 404) through a temporary
# Cloudflare quick tunnel (random https://*.trycloudflare.com, free, no account, gone when this script stops). The UI and the Slack OAuth
# redirect stay on https://localhost:3472 (self-signed, loopback). DEV login is never reachable from outside.
# Credentials live ONLY in the macOS Keychain; typed at hidden prompts, handed to `security -i` via stdin, never on a command line / in a file.
#
#   frontend/scripts/hub-live.sh set-slack       # project Slack app: Client ID, Client Secret (hidden), Signing Secret (hidden)
#   frontend/scripts/hub-live.sh set-telegram    # project Telegram bot: token (hidden) + username     (privacy mode stays ON)
#   frontend/scripts/hub-live.sh set-pi          # OPTIONAL Project Intelligence bot: token (hidden) + username (privacy mode OFF)
#   frontend/scripts/hub-live.sh set-tunnel      # OPTIONAL named Cloudflare tunnel token (stable hostname; HUB_PUBLIC_URL=https://<host> app)
#   frontend/scripts/hub-live.sh status          # which items exist (never values) -- hub + RUN 05 personal items
#   frontend/scripts/hub-live.sh app             # stack + gate + tunnel + Telegram webhooks + app; prints the Slack manifest path
#   frontend/scripts/hub-live.sh gate            # live gate (bots, privacy modes, webhooks, tunnel scoping) -- booleans only
#   frontend/scripts/hub-live.sh forget          # delete the hub Keychain items
# RUN 05 personal notifications use their own Keychain items: frontend/scripts/notify-live.sh set-slack | set-telegram (same session).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC=${HUB_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Hub dev (live)}
NSVC=${NOTIFY_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Notify dev (live)}
DIR=${NOTIFY_STACK_DIR:-${TMPDIR:-/tmp}/cs-notify-sb}
HTTPS_PORT=${HTTPS_PORT:-3472} GATE_PORT=${GATE_PORT:-3473}
ACC=$DIR/collab-accounts.env
kc_get() { security find-generic-password -s "${2:-$SVC}" -a "$1" -w 2>/dev/null; }
kc_has() { security find-generic-password -s "${2:-$SVC}" -a "$1" >/dev/null 2>&1; }
kc_put() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SVC" "$1" "$2" | security -i >/dev/null 2>&1; }
acc() { sed -n "s/^$1=//p" "$ACC" | head -1; }
ask() {  # $1 label, $2 regex, $3 hidden(1/0)
  local v
  if [ "$3" = 1 ]; then read -rsp "$1 (hidden): " v </dev/tty; echo >&2; else read -rp "$1: " v </dev/tty; fi
  v=$(printf '%s' "$v" | tr -d '[:space:]')
  if ! [[ "$v" =~ $2 ]]; then echo "  rejected: ${#v} characters do not match the expected format -- nothing stored" >&2; return 1; fi
  printf '%s' "$v"
}
tg_call() {  # $1 token keychain item, $2 method, rest: curl --data-urlencode args (token never on the command line)
  local item=$1 method=$2; shift 2
  printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$(kc_get "$item")" "$method" | curl -sS -m 20 -K - "$@"
}
load_env() {
  export HUB_LIVE=1
  if kc_has slack_hub_client_id && kc_has slack_hub_client_secret && kc_has slack_hub_signing_secret; then
    SLACK_HUB_CLIENT_ID=$(kc_get slack_hub_client_id); SLACK_HUB_CLIENT_SECRET=$(kc_get slack_hub_client_secret); SLACK_HUB_SIGNING_SECRET=$(kc_get slack_hub_signing_secret)
    export SLACK_HUB_CLIENT_ID SLACK_HUB_CLIENT_SECRET SLACK_HUB_SIGNING_SECRET HUB_SLACK_ENABLED=1
  else export HUB_SLACK_ENABLED=0; echo "(no project Slack app in the Keychain: hub Slack OFF)" >&2; fi
  if kc_has telegram_hub_bot_token && kc_has telegram_hub_bot_username; then
    TELEGRAM_HUB_BOT_TOKEN=$(kc_get telegram_hub_bot_token); TELEGRAM_HUB_BOT_USERNAME=$(kc_get telegram_hub_bot_username)
    TELEGRAM_HUB_WEBHOOK_SECRET=$(acc TELEGRAM_HUB_WEBHOOK_SECRET); export TELEGRAM_HUB_BOT_TOKEN TELEGRAM_HUB_BOT_USERNAME TELEGRAM_HUB_WEBHOOK_SECRET HUB_TELEGRAM_ENABLED=1
    if kc_has telegram_pi_bot_token && kc_has telegram_pi_bot_username; then
      TELEGRAM_HUB_PI_BOT_TOKEN=$(kc_get telegram_pi_bot_token); TELEGRAM_HUB_PI_BOT_USERNAME=$(kc_get telegram_pi_bot_username)
      TELEGRAM_HUB_PI_WEBHOOK_SECRET=$(acc TELEGRAM_HUB_PI_WEBHOOK_SECRET); export TELEGRAM_HUB_PI_BOT_TOKEN TELEGRAM_HUB_PI_BOT_USERNAME TELEGRAM_HUB_PI_WEBHOOK_SECRET
    fi
  else export HUB_TELEGRAM_ENABLED=0; echo "(no project Telegram bot in the Keychain: hub Telegram OFF)" >&2; fi
  # RUN 05 personal notifications in the same session (their own Keychain items, notify-live.sh)
  export NOTIFY_LIVE=1
  if kc_has slack_client_id "$NSVC" && kc_has slack_client_secret "$NSVC"; then
    SLACK_CLIENT_ID=$(kc_get slack_client_id "$NSVC"); SLACK_CLIENT_SECRET=$(kc_get slack_client_secret "$NSVC"); export SLACK_CLIENT_ID SLACK_CLIENT_SECRET
  else export SLACK_INTEGRATION_ENABLED=0; fi
  if kc_has telegram_bot_token "$NSVC" && kc_has telegram_bot_username "$NSVC"; then
    TELEGRAM_BOT_TOKEN=$(kc_get telegram_bot_token "$NSVC"); TELEGRAM_BOT_USERNAME=$(kc_get telegram_bot_username "$NSVC"); export TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME
  else export TELEGRAM_INTEGRATION_ENABLED=0; fi
  unset SLACK_HUB_API_MOCK_BASE TELEGRAM_HUB_API_MOCK_BASE SLACK_API_MOCK_BASE TELEGRAM_API_MOCK_BASE
}
case "${1:-}" in
  set-slack)
    id=$(ask 'Slack PROJECT app Client ID (Basic Information)' '^[0-9]{3,20}\.[0-9]{3,20}$' 0) && kc_put slack_hub_client_id "$id"
    s=$(ask 'Slack PROJECT app Client Secret' '^[A-Za-z0-9]{20,64}$' 1) && kc_put slack_hub_client_secret "$s"
    g=$(ask 'Slack PROJECT app Signing Secret' '^[A-Za-z0-9]{20,64}$' 1) && kc_put slack_hub_signing_secret "$g"
    echo "stored (Keychain service: $SVC)";;
  set-telegram)
    t=$(ask 'PROJECT Telegram bot token (@BotFather)' '^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$' 1) && kc_put telegram_hub_bot_token "$t"
    u=$(ask 'PROJECT bot username (without @)' '^[A-Za-z][A-Za-z0-9_]{3,31}$' 0) && kc_put telegram_hub_bot_username "$u"
    echo "stored (Keychain service: $SVC)";;
  set-tunnel)   # optional: token of a named Cloudflare tunnel whose public hostname routes to http://127.0.0.1:3473 (then HUB_PUBLIC_URL=https://<hostname>)
    t=$(ask 'Cloudflare named tunnel token' '^[A-Za-z0-9._=-]{50,600}$' 1) && kc_put cloudflare_tunnel_token "$t"
    echo "stored (Keychain service: $SVC)";;
  set-pi)
    t=$(ask 'OPTIONAL Project Intelligence bot token (@BotFather)' '^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$' 1) && kc_put telegram_pi_bot_token "$t"
    u=$(ask 'PI bot username (without @)' '^[A-Za-z][A-Za-z0-9_]{3,31}$' 0) && kc_put telegram_pi_bot_username "$u"
    echo "stored (Keychain service: $SVC)";;
  status)
    for a in slack_hub_client_id slack_hub_client_secret slack_hub_signing_secret telegram_hub_bot_token telegram_hub_bot_username telegram_pi_bot_token telegram_pi_bot_username cloudflare_tunnel_token; do
      kc_has "$a" && echo "present: hub/$a" || echo "MISSING: hub/$a"; done
    for a in slack_client_id slack_client_secret telegram_bot_token telegram_bot_username; do kc_has "$a" "$NSVC" && echo "present: personal/$a" || echo "MISSING: personal/$a"; done;;
  app)
    command -v cloudflared >/dev/null || { echo "cloudflared missing (brew install cloudflared)"; exit 2; }
    "$HERE/scripts/hub-stack.sh" up >/dev/null
    load_env
    CERT=$DIR/https-localhost.pem; KEY=$DIR/https-localhost-key.pem
    if [ ! -f "$CERT" ]; then umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -keyout "$KEY" -out "$CERT" >/dev/null 2>&1; fi
    node "$HERE/scripts/https-loopback-proxy.mjs" "$CERT" "$KEY" "$HTTPS_PORT" 3471 & P1=$!
    node "$HERE/scripts/hub-webhook-gate.mjs" "$GATE_PORT" 3471 > "$DIR/hub-gate.log" 2>&1 & P2=$!
    # tunnel: a NAMED tunnel of the owner (stable https hostname routed to http://127.0.0.1:$GATE_PORT; token in the Keychain) when
    # HUB_PUBLIC_URL is set, else a temporary quick tunnel (random hostname; Cloudflare may rate-limit account-less tunnels)
    TOKF=""
    if [ -n "${HUB_PUBLIC_URL:-}" ] && kc_has cloudflare_tunnel_token; then
      umask 077; TOKF=$DIR/.hub-tunnel-token; kc_get cloudflare_tunnel_token > "$TOKF"
      cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20249 run --token-file "$TOKF" > "$DIR/hub-tunnel.log" 2>&1 & P3=$!
    else
      cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20249 --url "http://127.0.0.1:$GATE_PORT" > "$DIR/hub-tunnel.log" 2>&1 & P3=$!
    fi
    cleanup() {
      [ -n "$TOKF" ] && rm -f "$TOKF"
      [ "$HUB_TELEGRAM_ENABLED" = 1 ] && tg_call telegram_hub_bot_token deleteWebhook >/dev/null 2>&1 || true
      kc_has telegram_pi_bot_token && tg_call telegram_pi_bot_token deleteWebhook >/dev/null 2>&1 || true
      kill $P1 $P2 $P3 2>/dev/null || true; rm -f "$DIR/hub-live-url"
    }
    trap cleanup EXIT
    URL=${HUB_PUBLIC_URL:-}
    if [ -z "$TOKF" ]; then for _ in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' "$DIR/hub-tunnel.log" | head -1 || true); [ -n "$URL" ] && break; kill -0 $P3 2>/dev/null || break; sleep 1; done; fi
    for _ in $(seq 1 30); do grep -q 'Registered tunnel connection' "$DIR/hub-tunnel.log" && break; sleep 1; done
    [ -n "$URL" ] || { echo "tunnel did not come up (see $DIR/hub-tunnel.log)"; exit 1; }
    umask 077; echo "$URL" > "$DIR/hub-live-url"
    if [ "$HUB_TELEGRAM_ENABLED" = 1 ]; then
      tg_call telegram_hub_bot_token setWebhook --data-urlencode "url=$URL/api/hub/telegram/webhook" --data-urlencode "secret_token=$TELEGRAM_HUB_WEBHOOK_SECRET" \
        --data-urlencode 'allowed_updates=["message","edited_message","my_chat_member"]' --data-urlencode 'drop_pending_updates=true' | grep -q '"ok":true' && echo "Telegram project bot webhook set" || echo "Telegram project bot webhook FAILED"
      if [ -n "${TELEGRAM_HUB_PI_BOT_TOKEN:-}" ]; then
        tg_call telegram_pi_bot_token setWebhook --data-urlencode "url=$URL/api/hub/telegram/pi-webhook" --data-urlencode "secret_token=$TELEGRAM_HUB_PI_WEBHOOK_SECRET" \
          --data-urlencode 'allowed_updates=["message","edited_message"]' --data-urlencode 'drop_pending_updates=true' | grep -q '"ok":true' && echo "Telegram PI bot webhook set" || echo "Telegram PI bot webhook FAILED"
      fi
    fi
    sed -e "s#https://<BASE>/api/hub/slack/install/callback#https://localhost:$HTTPS_PORT/api/hub/slack/install/callback#" -e "s#https://<BASE>#$URL#g" "$HERE/../docs/run07b/slack-hub-manifest.yaml" > "$DIR/hub-live-slack-manifest.yaml"
    echo ">>> Slack manifest with this tunnel: $DIR/hub-live-slack-manifest.yaml (App Manifest -> paste -> Save; the tunnel URL changes per run)"
    echo ">>> LIVE (real providers, synthetic data): open https://localhost:$HTTPS_PORT/?login=auto  (accept the local certificate once)"
    APP_BASE_URL_OVERRIDE="https://localhost:$HTTPS_PORT" "$HERE/scripts/hub-stack.sh" app;;
  gate) load_env; eval "$("$HERE/scripts/hub-stack.sh" env 2>/dev/null)"; HUB_LIVE_URL=$(cat "$DIR/hub-live-url" 2>/dev/null || true) exec node "$HERE/supabase/tests/hub_live_gate.mjs";;
  forget)
    for a in slack_hub_client_id slack_hub_client_secret slack_hub_signing_secret telegram_hub_bot_token telegram_hub_bot_username telegram_pi_bot_token telegram_pi_bot_username cloudflare_tunnel_token; do
      security delete-generic-password -s "$SVC" -a "$a" >/dev/null 2>&1 || true; done; echo "forgotten";;
  *) echo "usage: $0 set-slack|set-telegram|set-pi|status|app|gate|forget"; exit 2;;
esac
