#!/usr/bin/env bash
# RUN 06 Google demo pilot: isolated LOCAL stack (cs-gdemo-sb, ports 55630-55639 + mail 55644/55645, loopback only), app on 3461 (the dev
# OAuth client's registered loopback redirect; never run together with the RUN 04 calendar app), Gmail + Calendar in PILOT mode.
# Pilot = only alice (owner of project-collab-demo) and only one Google account: mock -> anna.mock@example.test, live -> the verified demo
# account stored in the Keychain by scripts/google-demo.sh setup (never in the repo). bob / vera are outside the pilot.
#   frontend/scripts/gdemo-stack.sh up | seed | mock | app | env | down          (mock Google; app: http://127.0.0.1:3461/settings?login=auto)
#   frontend/scripts/gdemo-stack.sh live-verify | live-app | live-node <supabase/tests script>.mjs | live-revoke-check   (REAL Google, dev project)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${GDEMO_STACK_DIR:-${TMPDIR:-/tmp}/cs-gdemo-sb} GOOGLE_LIVE_PORT=3461
export PORT=${PORT:-3461} GOOGLE_MOCK_PORT=${GOOGLE_MOCK_PORT:-55646}
export COLLAB_STACK_NAME_OVERRIDE=cs-gdemo-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-gdemo-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55645 COLLAB_MAIL_UI_OVERRIDE=55644
export GMAIL_INTEGRATION_ENABLED=${GMAIL_INTEGRATION_ENABLED:-pilot} CALENDAR_INTEGRATION_ENABLED=${CALENDAR_INTEGRATION_ENABLED:-pilot}

pilot_user() {  # alice's id in THIS stack (ids are random per seed); never a shared public-demo identity
  ( eval "$("$HERE/scripts/drive-stack.sh" env)"
    curl -sf "$E2E_SUPABASE_URL/auth/v1/admin/users?per_page=200" -H "apikey: $E2E_SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_KEY" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).users.find(x=>x.email==="alice@collab.test");process.stdout.write(u?u.id:"")})' )
}
pilot_env() {  # $1 = pilot Google account
  local id; id=$(pilot_user); [ -n "$id" ] || { echo "no alice in cs-gdemo-sb -- run: $0 seed" >&2; exit 2; }
  export GOOGLE_PILOT_USER_IDS=${GOOGLE_PILOT_USER_IDS:-$id} GOOGLE_PILOT_ACCOUNTS=${GOOGLE_PILOT_ACCOUNTS:-$1}
  echo "pilot: Gmail=$GMAIL_INTEGRATION_ENABLED Calendar=$CALENDAR_INTEGRATION_ENABLED, users=1 (alice), accounts=$(echo "$GOOGLE_PILOT_ACCOUNTS" | tr ',' '\n' | grep -c .)" >&2
}
demo_account() { security find-generic-password -s "ClearSpace V1 - Google demo seeder" -a demo_account -w 2>/dev/null || { echo "no demo account in the Keychain -- run: scripts/google-demo.sh setup" >&2; exit 2; }; }

case "${1:-}" in
  app) pilot_env anna.mock@example.test; exec "$HERE/scripts/drive-stack.sh" app;;
  env) "$HERE/scripts/drive-stack.sh" env; echo "export GOOGLE_PILOT_USER_IDS=$(pilot_user) GOOGLE_PILOT_ACCOUNTS=anna.mock@example.test";;
  live-verify) exec "$HERE/scripts/google-live.sh" verify;;
  live-app) pilot_env "$(demo_account)"; exec "$HERE/scripts/google-live.sh" app;;
  live-node) pilot_env "$(demo_account)"; exec "$HERE/scripts/google-live.sh" node "${@:2}";;
  live-revoke-check) exec "$HERE/scripts/google-live.sh" revoke-check;;
  *) exec "$HERE/scripts/drive-stack.sh" "$@";;
esac
