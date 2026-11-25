#!/usr/bin/env bash
# Isolated LOCAL stack for the Google Drive integration (RUN 02): a second Supabase CLI stack (cs-drive-sb, ports
# 55540-55549, loopback only) + the deterministic Google MOCK (scripts/google-mock.mjs, 127.0.0.1:55590).
# Never hosted, never real Google, never the RUN 01 stack (cs-collab-sb) or ClearSpace V2.
#   frontend/scripts/drive-stack.sh up       # stack + baseline + migrations + server_trust('email','google')
#   frontend/scripts/drive-stack.sh seed     # synthetic accounts alice/bob/vera@collab.test + shared project
#   frontend/scripts/drive-stack.sh mock     # Google mock in the foreground (SIMULACE)
#   frontend/scripts/drive-stack.sh app      # next dev on http://127.0.0.1:3441 against stack + mock
#   eval "$(frontend/scripts/drive-stack.sh env)"
#   frontend/scripts/drive-stack.sh down
# One-time: copy the cs-collab-sb supabase/config.toml to $TMPDIR/cs-drive-sb/supabase/ with ports 5553x -> 5554x,
# project_id cs-drive-sb, site_url/redirects 127.0.0.1:3441. Generated secrets live in $DIR/collab-accounts.env (0600).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export COLLAB_STACK_DIR=${DRIVE_STACK_DIR:-${TMPDIR:-/tmp}/cs-drive-sb}
# RUN 03: gmail-stack.sh reuses this launcher for its own isolated stack (cs-gmail-sb) through the *_OVERRIDE values.
export COLLAB_STACK_NAME=${COLLAB_STACK_NAME_OVERRIDE:-cs-drive-sb} COLLAB_STACK_SOCK=${COLLAB_STACK_SOCK_OVERRIDE:-/tmp/cs-drive-docker.sock} \
  COLLAB_SMTP_PORT=${COLLAB_SMTP_PORT_OVERRIDE:-55545} COLLAB_MAIL_UI=${COLLAB_MAIL_UI_OVERRIDE:-55544}
export PORT=${PORT:-3441}
MOCK_PORT=${GOOGLE_MOCK_PORT:-55590}
DIR=$COLLAB_STACK_DIR; ACC=$DIR/collab-accounts.env
psql_db() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' "supabase_db_$COLLAB_STACK_NAME" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
gen_google() {
  umask 077
  grep -q '^GOOGLE_SERVER_SECRET=' "$ACC" || printf 'GOOGLE_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"
  grep -q '^GOOGLE_TOKEN_ENCRYPTION_KEY=' "$ACC" || printf 'GOOGLE_TOKEN_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> "$ACC"
  grep -q '^GOOGLE_OAUTH_CLIENT_SECRET=' "$ACC" || printf 'GOOGLE_OAUTH_CLIENT_SECRET=mock-%s\n' "$(openssl rand -hex 16)" >> "$ACC"
}
mock_env() {
  # shellcheck disable=SC1090
  . "$ACC"
  export GOOGLE_OAUTH_CLIENT_ID=mock-client.apps.googleusercontent.test GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_SERVER_SECRET GOOGLE_TOKEN_ENCRYPTION_KEY
  export GOOGLE_PICKER_API_KEY=mock-picker-key-local GOOGLE_CLOUD_PROJECT_NUMBER=100000000001
  export GOOGLE_API_MOCK_BASE="http://127.0.0.1:$MOCK_PORT" GOOGLE_MOCK_PORT=$MOCK_PORT
  export MOCK_REDIRECT_URIS="http://127.0.0.1:$PORT/api/google/oauth/callback"
}
case "${1:-}" in
  up)
    "$HERE/scripts/collab-stack.sh" up
    gen_google
    # shellcheck disable=SC1090
    . "$ACC"
    printf "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to('%s', 'UTF8')), 'hex')) ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();\n" "$GOOGLE_SERVER_SECRET" | psql_db >/dev/null
    echo "server_trust('google') registered";;
  seed) "$HERE/scripts/collab-stack.sh" seed;;
  mock) mock_env; exec node "$HERE/scripts/google-mock.mjs";;
  app)
    mock_env
    exec "$HERE/scripts/collab-stack.sh" app;;
  env)
    "$HERE/scripts/collab-stack.sh" env
    mock_env
    echo "export E2E_BASE_URL=http://127.0.0.1:$PORT GOOGLE_MOCK_URL=http://127.0.0.1:$MOCK_PORT";;
  down) "$HERE/scripts/collab-stack.sh" down;;
  *) echo "usage: $0 up|seed|mock|app|env|down"; exit 2;;
esac
