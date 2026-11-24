#!/usr/bin/env bash
# Isolated LOCAL stack for collaboration work (RUN 01): Supabase CLI project WITH Realtime, every port on 127.0.0.1.
# Never hosted, never the cs-intel-sb stack, never ClearSpace V2.
#   frontend/scripts/collab-stack.sh up      # start (loopback-only), apply baseline + migrations
#   frontend/scripts/collab-stack.sh seed    # 3 synthetic accounts + one shared project (owner / editor / viewer)
#   frontend/scripts/collab-stack.sh app     # next dev on http://127.0.0.1:3431 against this stack (no Gemini key: AI fails closed)
#   eval "$(frontend/scripts/collab-stack.sh env)"   # E2E_SUPABASE_* / RT_* for the specs
#   frontend/scripts/collab-stack.sh down    # stop and delete the stack
# Stack project dir: $COLLAB_STACK_DIR (default $TMPDIR/cs-collab-sb; ports 55530-55539). One-time creation:
#   mkdir -p "$TMPDIR/cs-collab-sb" && cd "$_" && supabase init --force, then in supabase/config.toml: ports api 55531, db 55532,
#   shadow 55530, pooler 55539, studio 55533, smtp 55534, analytics 55537, inspector 55538; site_url http://127.0.0.1:3431;
#   auth.rate_limit sign_in_sign_ups = 1000; enable_confirmations = false (local only).
# Synthetic account passwords are generated once into $COLLAB_STACK_DIR/collab-accounts.env (mode 600, outside the repo).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR=${COLLAB_STACK_DIR:-${TMPDIR:-/tmp}/cs-collab-sb}
SOCK=/tmp/cs-collab-docker.sock; PIDF=$DIR/loopback-proxy.pid; NAME=cs-collab-sb; PORT=${PORT:-3431}
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
      (cd "$DIR" && DOCKER_HOST=unix://$SOCK supabase start -x studio,imgproxy,edge-runtime,logflare,vector,postgres-meta,supavisor,mailpit >/dev/null)
    fi
    if docker ps --filter name=$NAME --format '{{.Ports}}' | tr ',' '\n' | grep -qE '(0\.0\.0\.0|\[::\]):[0-9]+->'; then
      echo "REFUSING: stack is LAN-reachable"; (cd "$DIR" && supabase stop --no-backup >/dev/null); exit 1
    fi
    if [ "$(psql_db -At -c "select to_regclass('public.clearspace_migrations') is null")" = "t" ]; then
      psql_db -f - < "$HERE/supabase/tests/01_helpers.sql" >/dev/null
      psql_db --single-transaction -f - < "$HERE/supabase_schema.sql" >/dev/null
    fi
    for f in "$HERE"/supabase/migrations/*.sql; do psql_db --single-transaction -f - < "$f" >/dev/null; done
    echo "stack up (loopback only), schema + migrations applied: $(keys | grep API_URL)";;
  seed)
    eval "$(keys)"; ACC="$DIR/collab-accounts.env"
    if [ ! -f "$ACC" ]; then umask 077; P=$(openssl rand -hex 12); printf 'COLLAB_PASSWORD=%s\n' "$P" > "$ACC"; fi
    # shellcheck disable=SC1090
    . "$ACC"
    API_URL=$API_URL ANON_KEY=$ANON_KEY SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY COLLAB_PASSWORD=$COLLAB_PASSWORD node "$HERE/scripts/collab-seed.mjs"
    echo "accounts: alice@collab.test (owner), bob@collab.test (editor), vera@collab.test (viewer); password in $ACC";;
  app)
    eval "$(keys)"
    cd "$HERE" && NEXT_PUBLIC_SUPABASE_URL=$API_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY exec npx next dev -p "$PORT" -H 127.0.0.1;;
  env)
    eval "$(keys)"
    echo "export E2E_SUPABASE_URL=$API_URL E2E_SUPABASE_ANON_KEY=$ANON_KEY E2E_SUPABASE_SERVICE_KEY=$SERVICE_ROLE_KEY RT_URL=$API_URL RT_ANON=$ANON_KEY";;
  down) (cd "$DIR" && supabase stop --no-backup 2>&1 | tail -1); [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF" "$SOCK";;
  *) echo "usage: $0 up|seed|app|env|down"; exit 2;;
esac
