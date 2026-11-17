#!/usr/bin/env bash
# Isolated database tests for the ClearSpace V1 baseline + migrations.
#
# Uses a THROWAWAY Postgres container (public.ecr.aws/supabase/postgres) bound to
# 127.0.0.1:54999 under its own name. It never touches any other database, the
# production project, or ClearSpace V2's local Supabase stack. Each scenario runs
# in a fresh database cloned from the container's template; the container is
# removed on exit unless KEEP=1.
#
#   frontend/supabase/tests/run.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$(cd "$HERE/../.." && pwd)"
BASELINE="$FRONTEND/supabase_schema.sql"
MIGRATIONS=("$FRONTEND"/supabase/migrations/*.sql)
NAME=clearspace-v1-sectest
IMAGE=${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.167}
PORT=54999

psql_admin() { docker exec -i -e PGPASSWORD=sectest "$NAME" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() { [ "${KEEP:-0}" = "1" ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=sectest -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done
sleep 3

newdb() { # $1 = name
  # The container's own background workers keep the template DB busy: kick them
  # off (throwaway container, nothing of value is attached) and clone at once.
  psql_admin -d postgres -c "DROP DATABASE IF EXISTS $1"
  for _ in 1 2 3 4 5; do
    psql_admin -d postgres -At -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres' and pid <> pg_backend_pid()" >/dev/null || true
    if psql_admin -d postgres -c "CREATE DATABASE $1 TEMPLATE postgres" 2>/dev/null; then break; fi
    sleep 1
  done
  for f in 00_auth_shims.sql 01_helpers.sql; do psql_admin -d "$1" -f - < "$HERE/$f" >/dev/null; done
}
apply() { # $1 = db, $2.. = files ; each file in a single transaction
  local db=$1; shift
  for f in "$@"; do
    docker exec -i -e PGPASSWORD=sectest -e PGOPTIONS='-c client_min_messages=warning' "$NAME" \
      psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -q -d "$db" --single-transaction -f - < "$f" >/dev/null
  done
}
run_test() { # $1 = db, $2 = file
  echo "--- $(basename "$2")"
  local out; out="$(mktemp)"
  if { echo "begin;"; cat "$2"; echo "rollback;"; } | psql_admin -d "$1" -f - >"$out" 2>&1; then
    local k; k=$(grep -cE "NOTICE:  ok" "$out" || true)
    TOTAL=$((TOTAL + k))
    grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //' || true
    echo "    ($k assertions)"
    rm -f "$out"
  else
    cat "$out"; rm -f "$out"; echo "FAIL: $2"; exit 1
  fi
}

TOTAL=0
echo "== Scenario A: fresh database (baseline -> migrations -> migrations again)"
newdb cs_a
apply cs_a "$BASELINE"
apply cs_a "$BASELINE"                     # baseline stays idempotent before any migration
apply cs_a "${MIGRATIONS[@]}"
apply cs_a "${MIGRATIONS[@]}"              # migrations are idempotent
echo "--- baseline re-run after migrations must be REFUSED"
if psql_admin -d cs_a -f - < "$BASELINE" >/dev/null 2>&1; then echo "FAIL: baseline re-run was not refused"; exit 1; fi
echo "ok - baseline refused"
for t in "$HERE"/[1-9]*.test.sql; do run_test cs_a "$t"; done

echo "== Scenario C: migration on a database WITHOUT the baseline must fail early and change nothing"
newdb cs_c
if out=$(apply cs_c "${MIGRATIONS[@]}" 2>&1); then echo "FAIL: migration ran without the baseline"; exit 1; fi
echo "$out" | grep -q "Preflight failed" || { echo "FAIL: no clear preflight message: $out"; exit 1; }
[ "$(psql_admin -d cs_c -At -c "select count(*) from pg_tables where schemaname='public'")" = "0" ] || { echo "FAIL: preflight left objects behind"; exit 1; }
echo "ok - preflight refused the migration, nothing was created"

source "$HERE/legacy_upgrade.sh"
source "$HERE/concurrency.sh"
echo "ALL DATABASE TESTS PASSED (scenario A: $TOTAL SQL assertions + legacy-upgrade + concurrency checks)"
