#!/usr/bin/env bash
# RUN 10 Meeting Intelligence – isolated LOCAL stack: own Supabase CLI stack (cs-run10-sb, ports 55620-55629 + mail 55634/55635,
# loopback only) + the deterministic Google MOCK (scripts/google-mock.mjs incl. Calendar write, 127.0.0.1:55642) + the fake Soniox
# (async + real-time WebSocket, e2e/support/fake-soniox.mjs, 127.0.0.1:55643). Never hosted, never real Google, never real Soniox.
#   frontend/scripts/meetings-stack.sh up | seed | mock | soniox | app | env | down      (app: http://127.0.0.1:3481/?login=auto)
# One-time: copy the cs-calendar-sb supabase/config.toml to $TMPDIR/cs-run10-sb/supabase/ with ports 5557x -> 5562x, mail 55634/55635,
# project_id cs-run10-sb, site_url/redirects 127.0.0.1:3481/3482.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# MEETINGS_STACK_NAME (RUN 11): a second, clean stack with the same ports (e.g. cs-run11-sb) instead of re-running `up` over old data
NAME=${MEETINGS_STACK_NAME:-cs-run10-sb}
export DRIVE_STACK_DIR=${MEETINGS_STACK_DIR:-${TMPDIR:-/tmp}/$NAME}
export GMAIL_INTEGRATION_ENABLED=${GMAIL_INTEGRATION_ENABLED:-1} CALENDAR_INTEGRATION_ENABLED=${CALENDAR_INTEGRATION_ENABLED:-1}
export PORT=${PORT:-3481} GOOGLE_MOCK_PORT=${GOOGLE_MOCK_PORT:-55642}
SONIOX_PORT=${FAKE_SONIOX_PORT:-55643}
export COLLAB_STACK_NAME_OVERRIDE=$NAME COLLAB_STACK_SOCK_OVERRIDE=/tmp/$NAME-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55635 COLLAB_MAIL_UI_OVERRIDE=55634
ACC=$DRIVE_STACK_DIR/collab-accounts.env
stt_secret() { umask 077; grep -q '^STT_SERVER_SECRET=' "$ACC" || printf 'STT_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"; sed -n 's/^STT_SERVER_SECRET=//p' "$ACC" | head -1; }
case "${1:-}" in
  up)
    "$HERE/scripts/drive-stack.sh" up
    S=$(stt_secret)
    printf "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', encode(sha256(convert_to('%s', 'UTF8')), 'hex')) ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();\n" "$S" \
      | docker exec -i -e PGPASSWORD=postgres supabase_db_$NAME psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q >/dev/null
    echo "server_trust('stt') registered";;
  soniox) exec node "$HERE/e2e/support/fake-soniox.mjs" "$SONIOX_PORT";;
  app)
    # every chargeable path points at the LOCAL fakes; the switches are on for this process only
    export STT_ENABLED=1 MEETING_LIVE_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_LIVE=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 CALENDAR_WRITE_ENABLED=1 MEETING_PI_ENABLED=1 \
      STT_SERVER_SECRET="$(stt_secret)" SONIOX_API_KEY=fake-soniox-key SONIOX_BASE_URL="http://127.0.0.1:$SONIOX_PORT/v1" \
      SONIOX_RT_WS_URL_OVERRIDE="ws://127.0.0.1:$SONIOX_PORT/transcribe-websocket" AI_ALLOW_ALL_AUTHENTICATED=1 MEETING_LIVE_SEGMENT_MIN=${MEETING_LIVE_SEGMENT_MIN:-5}
    exec "$HERE/scripts/drive-stack.sh" app;;
  *) exec "$HERE/scripts/drive-stack.sh" "$@";;
esac
