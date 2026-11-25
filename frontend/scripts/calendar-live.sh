#!/usr/bin/env bash
# RUN 04 live acceptance: the Calendar worktree's app (http://127.0.0.1:3461, isolated stack cs-calendar-sb, Gmail + Calendar switches ON)
# against REAL Google with the SAME Keychain credentials as RUN 02B/03B (google-live.sh does everything; this only points it at this stack).
# Needs, in the DEV project only: redirect URI http://127.0.0.1:3461/api/google/oauth/callback, JS origin + Picker referrer 3461,
# Calendar API enabled + the Calendar scope on the consent screen (docs/run04/LIVE_ACCEPTANCE.md).
#   frontend/scripts/calendar-live.sh verify | app | status | revoke-check
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${CALENDAR_STACK_DIR:-${TMPDIR:-/tmp}/cs-calendar-sb} GOOGLE_LIVE_PORT=3461
export COLLAB_STACK_NAME_OVERRIDE=cs-calendar-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-calendar-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55585 COLLAB_MAIL_UI_OVERRIDE=55584
export GMAIL_INTEGRATION_ENABLED=1 CALENDAR_INTEGRATION_ENABLED=1
case "${1:-}" in verify|app|status|revoke-check) exec "$HERE/scripts/google-live.sh" "$1";; *) echo "usage: $0 verify|app|status|revoke-check"; exit 2;; esac
