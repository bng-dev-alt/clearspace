#!/usr/bin/env bash
# Isolated LOCAL stack for the Slack & Telegram notifications (RUN 05): own Supabase CLI stack (cs-notify-sb, ports 55600-55609 + mail
# 55614/55615, loopback only) + the Google MOCK (55621, for regressions) + the Slack/Telegram MOCK (scripts/notify-mock.mjs, 55622).
# Never hosted, never the RUN 01-04 stacks or ClearSpace V2. Template: calendar-stack.sh.
#   frontend/scripts/notify-stack.sh up | seed | mock | notify-mock | app | env | tick | scheduler-on | scheduler-off | down
#   app: http://127.0.0.1:3471/settings?login=auto
# One-time: copy the cs-calendar-sb supabase/config.toml to $TMPDIR/cs-notify-sb/supabase/ with ports 5557x -> 5560x, mail 55614/55615,
# project_id cs-notify-sb, site_url/redirects 127.0.0.1:3471/3472. Generated secrets live in $DIR/collab-accounts.env (0600).
# NOTIFY_LIVE=1 (notify-live.sh): real Slack/Telegram dev credentials come from the caller's environment (Keychain), never from here.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${NOTIFY_STACK_DIR:-${TMPDIR:-/tmp}/cs-notify-sb}
export PORT=${PORT:-3471} GOOGLE_MOCK_PORT=${GOOGLE_MOCK_PORT:-55621}
export COLLAB_STACK_NAME_OVERRIDE=cs-notify-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-notify-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55615 COLLAB_MAIL_UI_OVERRIDE=55614
export GMAIL_INTEGRATION_ENABLED=${GMAIL_INTEGRATION_ENABLED:-1} CALENDAR_INTEGRATION_ENABLED=${CALENDAR_INTEGRATION_ENABLED:-1}
export SLACK_INTEGRATION_ENABLED=${SLACK_INTEGRATION_ENABLED:-1} TELEGRAM_INTEGRATION_ENABLED=${TELEGRAM_INTEGRATION_ENABLED:-1}
NOTIFY_MOCK_PORT=${NOTIFY_MOCK_PORT:-55622}
DIR=$DRIVE_STACK_DIR; ACC=$DIR/collab-accounts.env
psql_db() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' supabase_db_cs-notify-sb psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
acc() { sed -n "s/^$1=//p" "$ACC" | head -1; }
gen_notify() {
  umask 077
  grep -q '^NOTIFY_SERVER_SECRET=' "$ACC" || printf 'NOTIFY_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
  grep -q '^NOTIFY_TOKEN_ENCRYPTION_KEY=' "$ACC" || printf 'NOTIFY_TOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> "$ACC"
  grep -q '^SLACK_MOCK_CLIENT_SECRET=' "$ACC" || printf 'SLACK_MOCK_CLIENT_SECRET=mock-%s\n' "$(openssl rand -hex 16)" >> "$ACC"
}
notify_env() {
  export NOTIFY_SERVER_SECRET; NOTIFY_SERVER_SECRET=$(acc NOTIFY_SERVER_SECRET)
  export NOTIFY_TOKEN_ENCRYPTION_KEY; NOTIFY_TOKEN_ENCRYPTION_KEY=$(acc NOTIFY_TOKEN_ENCRYPTION_KEY)
  if [ "${NOTIFY_LIVE:-0}" != 1 ]; then
    export SLACK_CLIENT_ID=100000000001.200000000002 SLACK_CLIENT_SECRET; SLACK_CLIENT_SECRET=$(acc SLACK_MOCK_CLIENT_SECRET)
    export TELEGRAM_BOT_TOKEN=100000001:MOCKmockMOCKmockMOCKmockMOCKmock_ab TELEGRAM_BOT_USERNAME=clearspace_mock_bot
    export SLACK_API_MOCK_BASE="http://127.0.0.1:$NOTIFY_MOCK_PORT" TELEGRAM_API_MOCK_BASE="http://127.0.0.1:$NOTIFY_MOCK_PORT" NOTIFY_MOCK_PORT
  fi
}
# Scheduler (docs/run05/ARCHITECTURE_DECISION.md): pg_cron every minute -> pg_net POST -> /api/notify/dispatch. The same activation
# script as production would use (supabase/ops/notify_scheduler_enable.sql); the app runs on the host, the database in Docker.
DISPATCH_URL=${NOTIFY_DISPATCH_URL:-http://host.docker.internal:$PORT/api/notify/dispatch}
case "${1:-}" in
  up)
    "$HERE/scripts/drive-stack.sh" up
    gen_notify
    printf "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('notify', encode(sha256(convert_to('%s', 'UTF8')), 'hex')) ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();\n" "$(acc NOTIFY_SERVER_SECRET)" | psql_db >/dev/null
    echo "server_trust('notify') registered";;
  seed) "$HERE/scripts/drive-stack.sh" seed;;
  mock) exec "$HERE/scripts/drive-stack.sh" mock;;
  notify-mock) notify_env; exec node "$HERE/scripts/notify-mock.mjs";;
  app) notify_env; exec "$HERE/scripts/drive-stack.sh" app;;
  env)
    "$HERE/scripts/drive-stack.sh" env
    notify_env
    echo "export NOTIFY_MOCK_URL=http://127.0.0.1:$NOTIFY_MOCK_PORT NOTIFY_SERVER_SECRET=$NOTIFY_SERVER_SECRET NOTIFY_TOKEN_ENCRYPTION_KEY=$NOTIFY_TOKEN_ENCRYPTION_KEY";;
  tick)  # one scheduler tick by hand (what pg_cron does every minute)
    curl -sS -m 120 -X POST -H "x-notify-secret: $(acc NOTIFY_SERVER_SECRET)" "http://127.0.0.1:$PORT/api/notify/dispatch${2:+?$2}"; echo;;
  scheduler-on)
    psql_db -v url="$DISPATCH_URL" -v secret="$(acc NOTIFY_SERVER_SECRET)" -f - < "$HERE/supabase/ops/notify_scheduler_enable.sql";;
  scheduler-off)
    psql_db -f - < "$HERE/supabase/ops/notify_scheduler_disable.sql";;
  down) "$HERE/scripts/drive-stack.sh" down;;
  *) echo "usage: $0 up|seed|mock|notify-mock|app|env|tick|scheduler-on|scheduler-off|down"; exit 2;;
esac
