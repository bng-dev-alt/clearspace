#!/usr/bin/env bash
# Isolated LOCAL stack for the Google Calendar integration (RUN 04): own Supabase CLI stack (cs-calendar-sb, ports 55570-55579 + mail
# 55584/55585, loopback only) + the deterministic Google MOCK (scripts/google-mock.mjs incl. Gmail + Calendar, 127.0.0.1:55592).
# Never hosted, never real Google, never the RUN 01/02/03 stacks or ClearSpace V2. Template: gmail-stack.sh.
#   frontend/scripts/calendar-stack.sh up | seed | mock | app | env | down     (app: http://127.0.0.1:3461/settings?login=auto)
# One-time: copy the cs-gmail-sb supabase/config.toml to $TMPDIR/cs-calendar-sb/supabase/ with ports 5555x -> 5557x, mail 55584/55585,
# project_id cs-calendar-sb, site_url/redirects 127.0.0.1:3461/3462. Generated secrets live in $DIR/collab-accounts.env (0600).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${CALENDAR_STACK_DIR:-${TMPDIR:-/tmp}/cs-calendar-sb}
export PORT=${PORT:-3461} GOOGLE_MOCK_PORT=${GOOGLE_MOCK_PORT:-55592}
export COLLAB_STACK_NAME_OVERRIDE=cs-calendar-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-calendar-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55585 COLLAB_MAIL_UI_OVERRIDE=55584
# Both read-only Google features on for this local stack only (Calendar must coexist with Drive + Gmail on one grant).
export GMAIL_INTEGRATION_ENABLED=${GMAIL_INTEGRATION_ENABLED:-1} CALENDAR_INTEGRATION_ENABLED=${CALENDAR_INTEGRATION_ENABLED:-1}
exec "$HERE/scripts/drive-stack.sh" "$@"
