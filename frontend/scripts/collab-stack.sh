#!/usr/bin/env bash
# Isolated LOCAL stack for collaboration work (RUN 01): Supabase CLI project WITH Realtime, every port on 127.0.0.1.
# Never hosted, never the cs-intel-sb stack, never ClearSpace V2.
#   frontend/scripts/collab-stack.sh up      # start (loopback-only), apply baseline + migrations
#   frontend/scripts/collab-stack.sh seed    # 3 synthetic accounts + one shared project (owner / editor / viewer)
#   frontend/scripts/collab-stack.sh app     # next dev on http://127.0.0.1:3431 against this stack (no Gemini key: AI fails closed);
#                                            # starts the stack + seeds if needed and enables the DEV LOGIN (auto, as alice; DEV_LOGIN_AS=bob|vera)
#   eval "$(frontend/scripts/collab-stack.sh env)"   # E2E_SUPABASE_* / RT_* for the specs
#   frontend/scripts/collab-stack.sh down    # stop and delete the stack
# Stack project dir: $COLLAB_STACK_DIR (default $TMPDIR/cs-collab-sb; ports 55530-55539). One-time creation:
#   mkdir -p "$TMPDIR/cs-collab-sb" && cd "$_" && supabase init --force, then in supabase/config.toml: ports api 55531, db 55532,
#   shadow 55530, pooler 55539, studio 55533, local_smtp port 55534 (Mailpit UI) + smtp_port 55535, analytics 55537,
#   inspector 55538; site_url http://127.0.0.1:3431; auth.rate_limit sign_in_sign_ups = 1000; enable_confirmations = false (local only).
# E-mail (RUN 01B): the app sends invitations by SMTP to the stack's Mailpit (127.0.0.1:55535, capture only -- Mailpit never
# relays anything to the internet); read them at http://127.0.0.1:55534. EMAIL_SERVER_SECRET is generated into the accounts file.
# Synthetic account passwords are generated once into $COLLAB_STACK_DIR/collab-accounts.env (mode 600, outside the repo).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR=${COLLAB_STACK_DIR:-${TMPDIR:-/tmp}/cs-collab-sb}
# RUN 02: name / socket / mail ports overridable so a second isolated stack (scripts/drive-stack.sh) can run beside this one.
NAME=${COLLAB_STACK_NAME:-cs-collab-sb}; SOCK=${COLLAB_STACK_SOCK:-/tmp/cs-collab-docker.sock}; PIDF=$DIR/loopback-proxy.pid; PORT=${PORT:-3431}
SMTP_PORT=${COLLAB_SMTP_PORT:-55535}; MAIL_UI=${COLLAB_MAIL_UI:-55534}
REAL=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed 's|^unix://||'); REAL=${REAL:-/var/run/docker.sock}
keys() { (cd "$DIR" && supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)='); }
psql_db() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' "supabase_db_$NAME" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
case "${1:-}" in
  up)
    [ -f "$DIR/supabase/config.toml" ] || { echo "no stack project in $DIR (see header)"; exit 2; }
    if [ -z "$(docker ps -q --filter name=supabase_db_$NAME)" ]; then
      if ! { [ -S "$SOCK" ] && [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }; then
        rm -f "$SOCK"; node "$HERE/scripts/docker-loopback-proxy.mjs" "$SOCK" "$REAL" >"$DIR/proxy.log" 2>&1 & echo $! >"$PIDF"; sleep 1
      fi
      (cd "$DIR" && DOCKER_HOST=unix://$SOCK supabase start -x studio,imgproxy,edge-runtime,logflare,vector,postgres-meta,supavisor >/dev/null)
    fi
    if docker ps --filter name=$NAME --format '{{.Ports}}' | tr ',' '\n' | grep -qE '(0\.0\.0\.0|\[::\]):[0-9]+->'; then
      echo "REFUSING: stack is LAN-reachable"; (cd "$DIR" && supabase stop --no-backup >/dev/null); exit 1
    fi
    if [ "$(psql_db -At -c "select to_regclass('public.clearspace_migrations') is null")" = "t" ]; then
      psql_db -f - < "$HERE/supabase/tests/01_helpers.sql" >/dev/null
      psql_db --single-transaction -f - < "$HERE/supabase_schema.sql" >/dev/null
    fi
    for f in "$HERE"/supabase/migrations/*.sql; do psql_db --single-transaction -f - < "$f" >/dev/null; done
    ACC="$DIR/collab-accounts.env"; [ -f "$ACC" ] || { umask 077; printf 'COLLAB_PASSWORD=%s\n' "$(openssl rand -hex 12)" > "$ACC"; }
    grep -q '^EMAIL_SERVER_SECRET=' "$ACC" || { umask 077; printf 'EMAIL_SERVER_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ACC"; }
    # shellcheck disable=SC1090
    . "$ACC"
    printf "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('email', encode(sha256(convert_to('%s', 'UTF8')), 'hex')) ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();\n" "$EMAIL_SERVER_SECRET" | psql_db >/dev/null
    echo "stack up (loopback only), schema + migrations applied: $(keys | grep API_URL)";;
  seed)
    eval "$(keys)"; ACC="$DIR/collab-accounts.env"
    if [ ! -f "$ACC" ]; then umask 077; P=$(openssl rand -hex 12); printf 'COLLAB_PASSWORD=%s\n' "$P" > "$ACC"; fi
    # shellcheck disable=SC1090
    . "$ACC"
    API_URL=$API_URL ANON_KEY=$ANON_KEY SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY COLLAB_PASSWORD=$COLLAB_PASSWORD node "$HERE/scripts/collab-seed.mjs"
    echo "accounts: alice@collab.test (owner), bob@collab.test (editor), vera@collab.test (viewer); password in $ACC";;
  app)
    # DEV LOGIN STANDARD (docs/LOCAL_DEV.md): every isolated-stack app gets a working one-click/auto login, whatever the port,
    # worktree or stack. The stack is started and the synthetic accounts are (re)created idempotently BEFORE the app starts, so a
    # reset or brand-new stack never leaves you without a login. Real Supabase Auth session (password grant on the server),
    # RLS unchanged. DEV_LOGIN_AS=alice|bob|vera picks the identity (alice = owner of the seeded project); DEV_AUTO_LOGIN=0 = button only.
    [ -n "$(docker ps -q --filter name=supabase_db_$NAME)" ] || "$0" up
    "$0" seed >/dev/null
    eval "$(keys)"
    # Read ONLY the two values this launcher needs. Never `source` the accounts file here: it also holds the MOCK Google secret, and
    # sourcing it would overwrite a real GOOGLE_OAUTH_CLIENT_SECRET the caller exported (RUN 02B: real Google answered invalid_client).
    acc() { sed -n "s/^$1=//p" "$DIR/collab-accounts.env" | head -1; }
    COLLAB_PASSWORD=$(acc COLLAB_PASSWORD); EMAIL_SERVER_SECRET=$(acc EMAIL_SERVER_SECRET)
    AS=${DEV_LOGIN_AS:-alice}; case "$AS" in alice|bob|vera) ;; *) echo "DEV_LOGIN_AS must be alice, bob or vera"; exit 2;; esac
    # RUN 08: an HTTPS live session serves Supabase on the app's own https origin (same-origin; see https-loopback-proxy.mjs)
    export NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_PUBLIC_URL_OVERRIDE:-$API_URL} NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
    export CLEARSPACE_DEV_LOGIN=1 NEXT_PUBLIC_DEV_LOGIN=1 DEV_LOGIN_EMAIL=$AS@collab.test DEV_LOGIN_PASSWORD=$COLLAB_PASSWORD
    if [ "${DEV_AUTO_LOGIN:-1}" = 1 ]; then export CLEARSPACE_DEV_AUTO_LOGIN=1 NEXT_PUBLIC_DEV_AUTO_LOGIN=1; else unset CLEARSPACE_DEV_AUTO_LOGIN NEXT_PUBLIC_DEV_AUTO_LOGIN; fi
    unset NEXT_PUBLIC_FORCE_DEMO VERCEL VERCEL_ENV
    # E-mail goes ONLY to the stack's Mailpit (loopback, capture only); reserved/test domains allowed there and nowhere else.
    export EMAIL_TRANSPORT=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=$SMTP_PORT SMTP_SECURITY=none EMAIL_FROM='ClearSpace <pozvanky@clearspace.test>' \
      APP_BASE_URL="${APP_BASE_URL_OVERRIDE:-http://127.0.0.1:$PORT}" EMAIL_ALLOW_RESERVED_DOMAINS=1 EMAIL_SERVER_SECRET="$EMAIL_SERVER_SECRET"
    cd "$HERE" && node scripts/local-auth-preflight.mjs   # refuses non-loopback Auth, demo mode, dead stack or a broken identity
    echo ">>> ONE-CLICK LOGIN: open ${APP_BASE_URL_OVERRIDE:-http://127.0.0.1:$PORT}/?login=auto  (signed in automatically as $DEV_LOGIN_EMAIL; real Auth session)"
    exec npx next dev -p "$PORT" -H 127.0.0.1;;
  mail)
    curl -s "http://127.0.0.1:$MAIL_UI/api/v1/messages?limit=${2:-10}";;
  env)
    eval "$(keys)"
    echo "export E2E_SUPABASE_URL=$API_URL E2E_SUPABASE_ANON_KEY=$ANON_KEY E2E_SUPABASE_SERVICE_KEY=$SERVICE_ROLE_KEY RT_URL=$API_URL RT_ANON=$ANON_KEY E2E_MAILPIT_URL=http://127.0.0.1:$MAIL_UI";;
  down) (cd "$DIR" && supabase stop --no-backup 2>&1 | tail -1); [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF" "$SOCK";;
  *) echo "usage: $0 up|seed|app|env|mail|down"; exit 2;;
esac
