#!/usr/bin/env bash
# Isolated LOCAL stack for the Project Communication Hub (RUN 07, docs/run07/DECISIONS.md D2): the RUN 05 stack cs-notify-sb (loopback only)
# + the hub MOCK (scripts/hub-mock.mjs, 55623) for the PROJECT Slack app / Telegram bot. Never hosted, never V2, never the owner's files.
#   frontend/scripts/hub-stack.sh up | seed | mock | notify-mock | hub-mock | app | env | tick | scheduler-on | scheduler-off | down
#   app: http://127.0.0.1:3471/?login=auto   (DEV LOGIN standard; alice = owner of project-collab-demo)
# Generated secrets live in $DIR/collab-accounts.env (0600, outside the repo). HUB_INTELLIGENCE_ENABLED defaults to 0 (pass 1 to test PI).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export NOTIFY_STACK_DIR=${NOTIFY_STACK_DIR:-${TMPDIR:-/tmp}/cs-notify-sb}
export PORT=${PORT:-3471}
HUB_MOCK_PORT=${HUB_MOCK_PORT:-55623}
DIR=$NOTIFY_STACK_DIR; ACC=$DIR/collab-accounts.env
SERVICE_EMAIL=hub-service@collab.test
psql_db() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' supabase_db_cs-notify-sb psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
acc() { sed -n "s/^$1=//p" "$ACC" | head -1; }
gen_hub() {
  umask 077
  grep -q '^HUB_SERVER_SECRET=' "$ACC" || printf 'HUB_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
  grep -q '^HUB_ROUTING_KEY=' "$ACC" || printf 'HUB_ROUTING_KEY=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
  grep -q '^TELEGRAM_HUB_PI_WEBHOOK_SECRET=' "$ACC" || printf 'TELEGRAM_HUB_PI_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
  grep -q '^HUB_TOKEN_ENCRYPTION_KEY=' "$ACC" || printf 'HUB_TOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> "$ACC"
  grep -q '^HUB_SERVICE_PASSWORD=' "$ACC" || printf 'HUB_SERVICE_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> "$ACC"
  grep -q '^SLACK_HUB_MOCK_CLIENT_SECRET=' "$ACC" || printf 'SLACK_HUB_MOCK_CLIENT_SECRET=mock-%s\n' "$(openssl rand -hex 16)" >> "$ACC"
  grep -q '^SLACK_HUB_MOCK_SIGNING_SECRET=' "$ACC" || printf 'SLACK_HUB_MOCK_SIGNING_SECRET=mock%s\n' "$(openssl rand -hex 16)" >> "$ACC"
  grep -q '^TELEGRAM_HUB_WEBHOOK_SECRET=' "$ACC" || printf 'TELEGRAM_HUB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
}
hub_env() {
  export HUB_SLACK_ENABLED=${HUB_SLACK_ENABLED:-1} HUB_TELEGRAM_ENABLED=${HUB_TELEGRAM_ENABLED:-1} HUB_INTELLIGENCE_ENABLED=${HUB_INTELLIGENCE_ENABLED:-0}
  export HUB_SERVER_SECRET; HUB_SERVER_SECRET=$(acc HUB_SERVER_SECRET)
  export HUB_ROUTING_KEY; HUB_ROUTING_KEY=$(acc HUB_ROUTING_KEY)
  export HUB_TOKEN_ENCRYPTION_KEY; HUB_TOKEN_ENCRYPTION_KEY=$(acc HUB_TOKEN_ENCRYPTION_KEY)
  export HUB_SERVICE_EMAIL=$SERVICE_EMAIL HUB_SERVICE_PASSWORD; HUB_SERVICE_PASSWORD=$(acc HUB_SERVICE_PASSWORD)
  export SLACK_HUB_CLIENT_ID=300000000003.400000000004 SLACK_HUB_CLIENT_SECRET SLACK_HUB_SIGNING_SECRET
  SLACK_HUB_CLIENT_SECRET=$(acc SLACK_HUB_MOCK_CLIENT_SECRET); SLACK_HUB_SIGNING_SECRET=$(acc SLACK_HUB_MOCK_SIGNING_SECRET)
  export TELEGRAM_HUB_BOT_TOKEN=200000002:MOCKmockMOCKmockMOCKmockMOCKhub_cd TELEGRAM_HUB_BOT_USERNAME=clearspace_hub_mock_bot TELEGRAM_HUB_WEBHOOK_SECRET
  TELEGRAM_HUB_WEBHOOK_SECRET=$(acc TELEGRAM_HUB_WEBHOOK_SECRET)
  # optional Project Intelligence bot (simulated): HUB_PI_BOT=0 leaves it unconfigured
  if [ "${HUB_PI_BOT:-1}" = 1 ]; then
    export TELEGRAM_HUB_PI_BOT_TOKEN=300000003:MOCKmockMOCKmockMOCKmockMOCKpi_ef TELEGRAM_HUB_PI_BOT_USERNAME=clearspace_pi_mock_bot TELEGRAM_HUB_PI_WEBHOOK_SECRET
    TELEGRAM_HUB_PI_WEBHOOK_SECRET=$(acc TELEGRAM_HUB_PI_WEBHOOK_SECRET)
  fi
  export SLACK_HUB_API_MOCK_BASE="http://127.0.0.1:$HUB_MOCK_PORT" TELEGRAM_HUB_API_MOCK_BASE="http://127.0.0.1:$HUB_MOCK_PORT" HUB_MOCK_PORT
  export MOCK_SLACK_REDIRECTS="http://127.0.0.1:$PORT/api/hub/slack/install/callback"
}
DISPATCH_URL=${HUB_DISPATCH_URL:-http://host.docker.internal:$PORT/api/hub/dispatch}
case "${1:-}" in
  up)
    # a stopped stack is started through the RUN 01 launcher (loopback-only Docker proxy, refuses LAN exposure); its migration loop may stop
    # at an older migration that collides with later test data (1300 provider check, TECH_DEBT) -- the stack itself is up by then
    [ -n "$(docker ps -q --filter name=supabase_db_cs-notify-sb)" ] || "$HERE/scripts/notify-stack.sh" up || true
    [ -n "$(docker ps -q --filter name=supabase_db_cs-notify-sb)" ] || { echo "stack did not start"; exit 1; }
    if docker ps --filter name=cs-notify-sb --format '{{.Ports}}' | tr ',' '\n' | grep -qE '(0\.0\.0\.0|\[::\]):[0-9]+->'; then echo "REFUSING: stack is LAN-reachable"; exit 1; fi
    [ "$(psql_db -At -c "select count(*) from public.clearspace_migrations where version = '20261129001500_notification_channels'")" = 1 ] || { echo "stack lacks 1500"; exit 1; }
    for m in 20261130001600_communication_hub 20261201001700_hub_hardening; do psql_db --single-transaction -f - < "$HERE/supabase/migrations/$m.sql" >/dev/null; done
    "$HERE/scripts/notify-stack.sh" seed >/dev/null
    gen_hub
    # the service principal: a plain Auth user without any project membership; registered + server_trust('hub') via the ops script
    eval "$(cd "$DIR" && supabase status -o env 2>/dev/null | grep -E '^(SERVICE_ROLE_KEY|API_URL)=')"
    curl -sS -o /dev/null -X POST "$API_URL/auth/v1/admin/users" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H 'content-type: application/json' \
      --data "{\"email\":\"$SERVICE_EMAIL\",\"password\":\"$(acc HUB_SERVICE_PASSWORD)\",\"email_confirm\":true}"
    UID_=$(psql_db -At -c "select id from auth.users where email = '$SERVICE_EMAIL'")
    [ -n "$UID_" ] || { echo "service principal user missing"; exit 1; }
    psql_db -v uid="$UID_" -v secret_sha256="$(printf '%s' "$(acc HUB_SERVER_SECRET)" | shasum -a 256 | cut -d' ' -f1)" -f - < "$HERE/supabase/ops/hub_service_principal.sql" >/dev/null
    echo "hub service principal + server_trust('hub') registered";;
  seed) "$HERE/scripts/notify-stack.sh" seed;;
  mock) exec "$HERE/scripts/notify-stack.sh" mock;;
  notify-mock) exec "$HERE/scripts/notify-stack.sh" notify-mock;;
  hub-mock) hub_env; exec node "$HERE/scripts/hub-mock.mjs";;
  app) hub_env; exec "$HERE/scripts/notify-stack.sh" app;;
  env)
    "$HERE/scripts/notify-stack.sh" env
    hub_env
    echo "export HUB_MOCK_URL=http://127.0.0.1:$HUB_MOCK_PORT HUB_SERVER_SECRET=$HUB_SERVER_SECRET SLACK_HUB_SIGNING_SECRET=$SLACK_HUB_SIGNING_SECRET TELEGRAM_HUB_WEBHOOK_SECRET=$TELEGRAM_HUB_WEBHOOK_SECRET TELEGRAM_HUB_BOT_USERNAME=$TELEGRAM_HUB_BOT_USERNAME TELEGRAM_HUB_PI_WEBHOOK_SECRET=${TELEGRAM_HUB_PI_WEBHOOK_SECRET:-}";;
  tick)  # one scheduler tick by hand (what pg_cron does every minute); needs scheduler-on once (vault url + secret)
    psql_db -At -c "select public.hub_scheduler_tick(${2:+'$2'::timestamptz})";;
  scheduler-on) psql_db -v url="$DISPATCH_URL" -v secret="$(acc HUB_SERVER_SECRET)" -f - < "$HERE/supabase/ops/hub_scheduler_enable.sql";;
  scheduler-off) psql_db -f - < "$HERE/supabase/ops/hub_scheduler_disable.sql";;
  down) "$HERE/scripts/notify-stack.sh" down;;
  *) echo "usage: $0 up|seed|mock|notify-mock|hub-mock|app|env|tick|scheduler-on|scheduler-off|down"; exit 2;;
esac
