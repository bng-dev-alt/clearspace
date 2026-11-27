#!/usr/bin/env bash
# RUN 07B: LIVE acceptance of the Communication Hub (and, in the same session, the RUN 05 personal notifications) on the ISOLATED local
# stack (cs-notify-sb, synthetic data) against REAL Slack and Telegram -- the owner's DEV apps / bots only. Never production, never Vercel.
#
# Exposure: the internet reaches ONLY scripts/hub-webhook-gate.mjs (5 POST webhook paths, everything else 404) through a temporary
# Cloudflare quick tunnel (random https://*.trycloudflare.com, free, no account, gone when this script stops). The UI and the Slack OAuth
# redirect stay on https://localhost:3472 (self-signed, loopback). DEV login is never reachable from outside.
# Credentials live ONLY in the macOS Keychain; typed at hidden prompts, handed to `security -i` via stdin, never on a command line / in a file.
#
#   frontend/scripts/hub-live.sh setup           # RUN 08: ONE guided session for every missing item (tunnel, 3 bots, 2 Slack apps)
#   frontend/scripts/hub-live.sh set-slack       # project Slack app: Client ID, Client Secret (hidden), Signing Secret (hidden)
#   frontend/scripts/hub-live.sh set-telegram    # project Telegram bot: token (hidden) + username     (privacy mode stays ON)
#   frontend/scripts/hub-live.sh set-pi          # OPTIONAL Project Intelligence bot: token (hidden) + username (privacy mode OFF)
#   frontend/scripts/hub-live.sh set-tunnel      # OPTIONAL named Cloudflare tunnel token (stable hostname; HUB_PUBLIC_URL=https://<host> app)
#   frontend/scripts/hub-live.sh status          # which items exist (never values) -- hub + RUN 05 personal items
#   frontend/scripts/hub-live.sh app             # stack + gate + tunnel + Telegram webhooks + app; prints the Slack manifest path
#   frontend/scripts/hub-live.sh manifest        # Slack manifest for HUB_PUBLIC_URL (named tunnel) -- create the Slack app BEFORE the first run
#   frontend/scripts/hub-live.sh gate            # live gate (bots, privacy modes, webhooks, tunnel scoping) -- booleans only
#   frontend/scripts/hub-live.sh forget          # delete the hub Keychain items
# RUN 05 personal notifications use their own Keychain items: frontend/scripts/notify-live.sh set-slack | set-telegram (same session).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC=${HUB_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Hub dev (live)}
NSVC=${NOTIFY_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Notify dev (live)}
DIR=${NOTIFY_STACK_DIR:-${TMPDIR:-/tmp}/cs-notify-sb}
HTTPS_PORT=${HTTPS_PORT:-3472} GATE_PORT=${GATE_PORT:-3473}
# RUN 08: dedicated named tunnel "clearspace-hub-live" (ingress only cs-hub-live.luffast.com -> 127.0.0.1:3473, everything else 404)
HUB_PUBLIC_URL=${HUB_PUBLIC_URL:-https://cs-hub-live.luffast.com}; export HUB_PUBLIC_URL
ACC=$DIR/collab-accounts.env
kc_get() { security find-generic-password -s "${2:-$SVC}" -a "$1" -w 2>/dev/null; }
kc_has() { security find-generic-password -s "${2:-$SVC}" -a "$1" >/dev/null 2>&1; }
kc_put() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SVC" "$1" "$2" | security -i >/dev/null 2>&1; }
acc() { sed -n "s/^$1=//p" "$ACC" | head -1; }
# ---------------------------------------------------------------- credential entry (RUN 08 fix)
# Values are read from the terminal (hidden for secrets), validated, stored in the Keychain via `security -i` (stdin, never argv) and read
# back for verification. A rejected value is asked for AGAIN (never skipped). Diagnostics print only shapes / yes-no facts, never values.
HUB_TUNNEL_ID=${HUB_TUNNEL_ID:-de4b0d15-7d47-4566-927c-bf1906f44358}     # clearspace-hub-live (RUN 08); not a secret
HUB_INPUT=${HUB_INPUT:-/dev/tty}
# shell-independent validation + safe diagnostics (macOS /usr/bin/env bash is 3.2): scripts/hub-credential-check.py
validate() { printf '%s' "$2" | TID="$HUB_TUNNEL_ID" python3 -I "$HERE/scripts/hub-credential-check.py" validate "$1"; }
# prompt_store SERVICE ACCOUNT LABEL KIND HIDDEN(1/0) OPTIONAL(1/0) -> 0 stored | 2 skipped (optional, empty input)
prompt_store() {
  local svc=$1 acct=$2 label=$3 kind=$4 hidden=$5 opt=$6 v n=0
  exec 9<"$HUB_INPUT"
  while :; do
    n=$((n + 1))
    local hint=""; [ "$opt" = 1 ] && hint=", Enter = skip"
    [ "$n" -gt 8 ] && { echo "  too many attempts -- stopping here (re-run the setup; stored items are kept)" >&2; return 3; }
    if [ "$hidden" = 1 ]; then
      # echo OFF before the prompt is shown (bash 3.2 `read -s` switches it off only after printing the prompt -> a very fast paste could echo)
      stty -echo <&9 2>/dev/null; trap 'stty echo <&9 2>/dev/null' INT TERM EXIT
      printf '%s' "$label (hidden$hint): " >&2
      if ! read -r v <&9; then stty echo <&9 2>/dev/null; echo >&2; echo "  input closed -- stopping" >&2; return 3; fi
      stty echo <&9 2>/dev/null; echo >&2
    else read -rp "$label${hint:+ (${hint#, })}: " v <&9 || { echo "  input closed -- stopping" >&2; return 3; }; fi
    v=$(printf '%s' "$v" | python3 -I "$HERE/scripts/hub-credential-check.py" sanitize)
    [ "$kind" = tg_user ] && v=${v#@}
    if [ -z "$v" ]; then
      [ "$opt" = 1 ] && { echo "  skipped" >&2; return 2; }
      echo "  empty input -- please paste the value again (Ctrl-C stops the setup)" >&2; continue
    fi
    if validate "$kind" "$v"; then
      printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$svc" "$acct" "$v" | security -i >/dev/null 2>&1
      if [ "$(security find-generic-password -s "$svc" -a "$acct" -w 2>/dev/null)" = "$v" ]; then echo "  stored in the Keychain and verified" >&2; return 0; fi
      echo "  Keychain write could not be verified -- trying again" >&2; continue
    fi
    echo "  rejected (attempt $n): the value above does not have the expected form -- nothing stored, please paste it again" >&2
  done
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
  setup)   # RUN 08: ONE session, asks ONLY items that are still missing (per item: a stopped run resumes exactly where it stopped)
    item() {  # svc acct label kind hidden optional
      if kc_has "$2" "$1"; then echo "  $3: already in the Keychain"; return 0; fi
      prompt_store "$@"
    }
    echo "== ClearSpace live setup -- each value goes straight into the macOS Keychain; nothing is shown or stored elsewhere"
    echo "-- 1/5 Cloudflare tunnel token (Zero Trust -> Networks -> Tunnels -> clearspace-hub-live -> Configure -> the long token after 'service install')"
    item "$SVC" cloudflare_tunnel_token 'Tunnel token' cf_tunnel 1 0 || exit 1
    echo "-- 2/5 PERSONAL notification bot (RUN 05)"
    item "$NSVC" telegram_bot_token 'Personal bot token' tg_token 1 0 || exit 1
    item "$NSVC" telegram_bot_username 'Personal bot username' tg_user 0 0 || exit 1
    echo "-- 3/5 PROJECT bot (privacy mode stays ON)"
    item "$SVC" telegram_hub_bot_token 'Project bot token' tg_token 1 0 || exit 1
    item "$SVC" telegram_hub_bot_username 'Project bot username' tg_user 0 0 || exit 1
    echo "-- 4/5 OPTIONAL read-only PI bot (privacy OFF)"
    if kc_has telegram_pi_bot_skipped && ! kc_has telegram_pi_bot_token; then echo "  PI bot: skipped earlier (add it later: hub-live.sh set-pi)"
    else
      rc=0; item "$SVC" telegram_pi_bot_token 'PI bot token' tg_token 1 1 || rc=$?      # set -e: capture, do not abort
      if [ $rc = 0 ]; then item "$SVC" telegram_pi_bot_username 'PI bot username' tg_user 0 0 || exit 1
      elif [ $rc = 2 ]; then printf 'add-generic-password -U -s "%s" -a telegram_pi_bot_skipped -w yes\n' "$SVC" | security -i >/dev/null 2>&1   # remember the choice (not a secret)
      else exit 1; fi
    fi
    echo "-- 5a/5 Slack PERSONAL app (Basic Information -> App Credentials)"
    item "$NSVC" slack_client_id 'Personal app Client ID' slack_id 0 0 || exit 1
    item "$NSVC" slack_client_secret 'Personal app Client Secret' slack_secret 1 0 || exit 1
    echo "-- 5b/5 Slack PROJECT app (Basic Information -> App Credentials)"
    item "$SVC" slack_hub_client_id 'Project app Client ID' slack_id 0 0 || exit 1
    item "$SVC" slack_hub_client_secret 'Project app Client Secret' slack_secret 1 0 || exit 1
    item "$SVC" slack_hub_signing_secret 'Project app Signing Secret' slack_secret 1 0 || exit 1
    echo "== done ($("$0" status | grep -c '^present') items present; the optional PI bot may be missing)";;
  selftest)   # validators + the re-prompt loop + Keychain store/verify against SYNTHETIC values in a throwaway Keychain service
    set +e; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fails=0
    chk() { if [ "$1" = "$2" ]; then echo "ok   - $3"; else echo "FAIL - $3 (got $1, want $2)"; fails=$((fails + 1)); fi; }
    gen_cf() { python3 -I -c 'import base64, json, os, sys; print(base64.b64encode(json.dumps({"a": "d" * 32, "t": sys.argv[1], "s": "x" * (os.urandom(1)[0] % 3) + "???~~~" + base64.b64encode(os.urandom(32)).decode()}, separators=(",", ":")).encode()).decode())' "$1"; }
    for _ in $(seq 1 200); do CF=$(gen_cf "$HUB_TUNNEL_ID"); case "$CF" in *+*/*|*/*+*) break;; esac; done   # like the real token: + AND / in it
    if [[ "$CF" == *+* && "$CF" == */* ]]; then echo "ok   - synthetic tunnel token contains + and / (the characters the RUN 08 regex refused)"; else echo "FAIL - could not build a token with + and /"; fails=1; fi
    validate cf_tunnel "$CF" 2>/dev/null; chk $? 0 "valid tunnel token (base64 with + / =, ${#CF} chars) accepted"
    validate cf_tunnel "$(gen_cf 00000000-0000-4000-8000-000000000000)" 2>"$T/d"; chk $? 1 "token of another tunnel rejected"
    grep -q 'ANOTHER tunnel' "$T/d"; chk $? 0 "diagnostic names the wrong tunnel"
    validate cf_tunnel "sudo cloudflared service install $CF" 2>"$T/d"; chk $? 1 "pasted command rejected"
    grep -q 'looks_like_a_command_was_pasted: True' "$T/d"; chk $? 0 "diagnostic says a command was pasted"
    ! grep -qF "${CF:20:20}" "$T/d"; chk $? 0 "diagnostics never contain the value"
    validate cf_tunnel "${CF:0:100}" 2>/dev/null; chk $? 1 "truncated token rejected"
    validate tg_token "1234567890:AAH$(openssl rand -hex 16)" 2>/dev/null; chk $? 0 "10-digit bot id token accepted"
    validate tg_token "bot1234567890:AAH$(openssl rand -hex 16)" 2>/dev/null; chk $? 1 "token with bot prefix rejected"
    validate tg_user cs_projekty_mb_bot 2>/dev/null; chk $? 0 "username accepted"; validate tg_user cs_projekty 2>/dev/null; chk $? 1 "username without bot rejected"
    validate slack_id 1234567890123.9876543210987 2>/dev/null; chk $? 0 "Slack client id accepted"
    validate slack_secret "$(openssl rand -hex 16)" 2>/dev/null; chk $? 0 "Slack 32-hex secret accepted"
    validate slack_secret 'xoxb-1-2' 2>/dev/null; chk $? 1 "token in the secret field rejected"
    # loop: two bad values, then a good one -> asked three times, stored + verified in a THROWAWAY Keychain service
    TS="ClearSpace V1 - Hub selftest"; printf 'zzz\n%s\n\n%s\n' "${CF:0:50}" "$CF" > "$T/in"
    HUB_INPUT="$T/in" prompt_store "$TS" selftest_token 'Tunnel token' cf_tunnel 1 0 2>"$T/l"; chk $? 0 "re-prompts after rejected / empty input, then stores"
    chk "$(grep -c 'rejected (attempt' "$T/l")" 2 "two rejections reported"; chk "$(grep -c 'empty input' "$T/l")" 1 "empty input re-prompted (not skipped)"
    [ "$(security find-generic-password -s "$TS" -a selftest_token -w 2>/dev/null)" = "$CF" ]; chk $? 0 "Keychain holds exactly the accepted value"
    printf '\n' > "$T/in2"; HUB_INPUT="$T/in2" prompt_store "$TS" selftest_opt 'PI bot token' tg_token 1 1 2>/dev/null; chk $? 2 "optional item: Enter skips"
    security delete-generic-password -s "$TS" -a selftest_token >/dev/null 2>&1
    echo; [ $fails = 0 ] && echo "SELFTEST PASS" || { echo "SELFTEST: $fails FAIL"; exit 1; };;
  set-slack)
    prompt_store "$SVC" slack_hub_client_id 'Slack PROJECT app Client ID' slack_id 0 0
    prompt_store "$SVC" slack_hub_client_secret 'Slack PROJECT app Client Secret' slack_secret 1 0
    prompt_store "$SVC" slack_hub_signing_secret 'Slack PROJECT app Signing Secret' slack_secret 1 0
    echo "stored (Keychain service: $SVC)";;
  set-telegram)
    prompt_store "$SVC" telegram_hub_bot_token 'PROJECT bot token' tg_token 1 0
    prompt_store "$SVC" telegram_hub_bot_username 'PROJECT bot username' tg_user 0 0
    echo "stored (Keychain service: $SVC)";;
  set-tunnel)   # optional: token of a named Cloudflare tunnel whose public hostname routes to http://127.0.0.1:3473 (then HUB_PUBLIC_URL=https://<hostname>)
    prompt_store "$SVC" cloudflare_tunnel_token 'Cloudflare tunnel token' cf_tunnel 1 0
    echo "stored (Keychain service: $SVC)";;
  set-pi)
    prompt_store "$SVC" telegram_pi_bot_token 'PI bot token' tg_token 1 0
    prompt_store "$SVC" telegram_pi_bot_username 'PI bot username' tg_user 0 0
    echo "stored (Keychain service: $SVC)";;
  status)
    for a in slack_hub_client_id slack_hub_client_secret slack_hub_signing_secret telegram_hub_bot_token telegram_hub_bot_username telegram_pi_bot_token telegram_pi_bot_username cloudflare_tunnel_token; do
      kc_has "$a" && echo "present: hub/$a" || echo "MISSING: hub/$a"; done
    for a in slack_client_id slack_client_secret telegram_bot_token telegram_bot_username; do kc_has "$a" "$NSVC" && echo "present: personal/$a" || echo "MISSING: personal/$a"; done;;
  app)
    # RUN 08B isolation: the local stack never runs on PRODUCTION credentials (promoted apps / bots live in a production Keychain service)
    case "$SVC$NSVC" in *[Pp]roduct*) echo "REFUSING: production Keychain service -- the local live session uses dev credentials only"; exit 2;; esac
    command -v cloudflared >/dev/null || { echo "cloudflared missing (brew install cloudflared)"; exit 2; }
    "$HERE/scripts/hub-stack.sh" up >/dev/null
    load_env
    CERT=$DIR/https-localhost.pem; KEY=$DIR/https-localhost-key.pem
    if [ ! -f "$CERT" ]; then umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -keyout "$KEY" -out "$CERT" >/dev/null 2>&1; fi
    SB_PORT=$(cd "$DIR" && supabase status -o env 2>/dev/null | sed -n 's/^API_URL="*http:\/\/127\.0\.0\.1:\([0-9]*\)"*$/\1/p')
    [ -n "$SB_PORT" ] || { echo "local Supabase API port not found"; exit 1; }
    node "$HERE/scripts/https-loopback-proxy.mjs" "$CERT" "$KEY" "$HTTPS_PORT" 3471 "$SB_PORT" & P1=$!
    node "$HERE/scripts/hub-webhook-gate.mjs" "$GATE_PORT" 3471 > "$DIR/hub-gate.log" 2>&1 & P2=$!
    # tunnel: a NAMED tunnel of the owner (stable https hostname routed to http://127.0.0.1:$GATE_PORT; token in the Keychain) when
    # HUB_PUBLIC_URL is set, else a temporary quick tunnel (random hostname; Cloudflare may rate-limit account-less tunnels)
    TOKF=""
    if [ "${HUB_QUICK_TUNNEL:-0}" != 1 ]; then
      kc_has cloudflare_tunnel_token || { echo "no tunnel token in the Keychain (hub-live.sh setup)"; kill $P1 $P2; exit 2; }
      umask 077; TOKF=$DIR/.hub-tunnel-token; kc_get cloudflare_tunnel_token > "$TOKF"     # mode 600, removed on exit
      cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20249 run --token-file "$TOKF" > "$DIR/hub-tunnel.log" 2>&1 & P3=$!
    else
      HUB_PUBLIC_URL=""
      cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20249 --url "http://127.0.0.1:$GATE_PORT" > "$DIR/hub-tunnel.log" 2>&1 & P3=$!
    fi
    cleanup() {
      [ -n "$TOKF" ] && rm -f "$TOKF"
      [ "$HUB_TELEGRAM_ENABLED" = 1 ] && tg_call telegram_hub_bot_token deleteWebhook >/dev/null 2>&1 || true
      kc_has telegram_pi_bot_token && tg_call telegram_pi_bot_token deleteWebhook >/dev/null 2>&1 || true
      kill $P1 $P2 $P3 2>/dev/null || true; rm -f "$DIR/hub-live-url"
      "$HERE/scripts/hub-stack.sh" scheduler-off >/dev/null 2>&1 || true; "$HERE/scripts/notify-stack.sh" scheduler-off >/dev/null 2>&1 || true
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
    # RUN 08B: the real scheduler (pg_cron every minute -> this app) for project AND personal notifications; switched off again on exit
    "$HERE/scripts/hub-stack.sh" scheduler-on >/dev/null && "$HERE/scripts/notify-stack.sh" scheduler-on >/dev/null && echo "scheduler on (hub + personal notifications)" || echo "scheduler FAILED to start"
    echo ">>> Slack manifest with this tunnel: $DIR/hub-live-slack-manifest.yaml (App Manifest -> paste -> Save; the tunnel URL changes per run)"
    # ONE address for the whole live session: https://localhost:3472 (app + Supabase, same origin); server-side fetches trust the local cert
    echo ">>> THE ONLY ADDRESS TO USE: https://localhost:$HTTPS_PORT/?login=auto  (signed in automatically; accept the local certificate once)"
    NODE_EXTRA_CA_CERTS="$CERT" SUPABASE_PUBLIC_URL_OVERRIDE="https://localhost:$HTTPS_PORT" APP_BASE_URL_OVERRIDE="https://localhost:$HTTPS_PORT" "$HERE/scripts/hub-stack.sh" app;;
  manifest)   # print the project Slack app manifest for a stable public URL (named tunnel): HUB_PUBLIC_URL=https://<host> hub-live.sh manifest
    [ -n "${HUB_PUBLIC_URL:-}" ] || { echo "set HUB_PUBLIC_URL=https://<your tunnel hostname>"; exit 2; }
    sed -e "s#https://<BASE>/api/hub/slack/install/callback#https://localhost:$HTTPS_PORT/api/hub/slack/install/callback#" -e "s#https://<BASE>#$HUB_PUBLIC_URL#g" "$HERE/../docs/run07b/slack-hub-manifest.yaml";;
  gate) load_env; eval "$("$HERE/scripts/hub-stack.sh" env 2>/dev/null)"; HUB_LIVE_URL=$(cat "$DIR/hub-live-url" 2>/dev/null || true) exec node "$HERE/supabase/tests/hub_live_gate.mjs";;
  forget)
    for a in slack_hub_client_id slack_hub_client_secret slack_hub_signing_secret telegram_hub_bot_token telegram_hub_bot_username telegram_pi_bot_token telegram_pi_bot_username cloudflare_tunnel_token telegram_pi_bot_skipped; do
      security delete-generic-password -s "$SVC" -a "$a" >/dev/null 2>&1 || true; done; echo "forgotten";;
  *) echo "usage: $0 setup|selftest|set-slack|set-telegram|set-pi|set-tunnel|status|app|manifest|gate|forget"; exit 2;;
esac
