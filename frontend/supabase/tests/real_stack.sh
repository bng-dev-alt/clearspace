#!/usr/bin/env bash
# Verifies the baseline + migrations against a REAL local Supabase stack (real GoTrue,
# PostgREST and Kong) started with the Supabase CLI in a THROWAWAY project -- never a
# hosted project, never ClearSpace V2's stack.
#
#   # one-time: a throwaway CLI project on its own ports (see docs/MIGRATION_RUNBOOK.md)
#   DB_CONTAINER=supabase_db_<project_id> API_URL=http://127.0.0.1:<port> \
#   ANON_KEY=<local demo anon key> [SERVICE_ROLE_KEY=<local demo service key>] frontend/supabase/tests/real_stack.sh
#
# It WRITES to that stack's database (applies the schema, creates users), so only point it
# at a stack you are happy to throw away. Scenario order matters (legacy upgrade first).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND="$(cd "$HERE/../.." && pwd)"
: "${DB_CONTAINER:?set DB_CONTAINER (e.g. supabase_db_cs-v1-p2test)}"
: "${API_URL:?set API_URL (e.g. http://127.0.0.1:55421)}"
: "${ANON_KEY:?set ANON_KEY (the LOCAL demo anon key printed by supabase start)}"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local API_URL: $API_URL"; exit 2;; esac

psql_db() { docker exec -i -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql_quiet() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
signup() { # email password -> prints user id
  curl -s -X POST "$API_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("user") or d).get("id",""))'
}

echo "== real stack: helpers + baseline"
psql_quiet -f - < "$HERE/01_helpers.sql" >/dev/null
psql_quiet --single-transaction -f - < "$FRONTEND/supabase_schema.sql" >/dev/null

echo "== real stack: legacy upgrade (users created through the REAL GoTrue signup)"
O=$(signup legacy-owner@example.test 'Password-123'); M=$(signup legacy-member@example.test 'Password-123')
[ -n "$O" ] && [ -n "$M" ] || { echo "FAIL: GoTrue signup did not return users"; exit 1; }
psql_db -At -c "select 'signup trigger created profiles+owner members: ' || (select count(*) from public.profiles) || '/' || (select count(*) from public.workspace_members where workspace_role='owner')"
psql_quiet -f - < "$HERE/legacy_seed.sql" >/dev/null
for f in "$FRONTEND"/supabase/migrations/*.sql; do psql_quiet --single-transaction -f - < "$f" >/dev/null; done
{ echo "begin;"; cat "$HERE/legacy_assert.sql"; echo "rollback;"; } | psql_db -f - 2>&1 | grep -E "NOTICE:  ok|ERROR|FAIL" | sed -E 's/^.*NOTICE:  //'
[ "${PIPESTATUS[1]}" -eq 0 ] || { echo "FAIL: legacy upgrade assertions"; exit 1; }

echo "== real stack: migrations are repeatable"
for f in "$FRONTEND"/supabase/migrations/*.sql; do psql_quiet --single-transaction -f - < "$f" >/dev/null; done
echo "ok - second apply is a no-op"

echo "== real stack: SQL suites (real auth.uid()/auth.jwt(), real auth.users)"
for t in "$HERE"/[1-9]*.test.sql; do
  echo "--- $(basename "$t")"
  out="$(mktemp)"
  if { echo "begin;"; cat "$t"; echo "rollback;"; } | psql_db -f - >"$out" 2>&1; then
    echo "    ($(grep -cE 'NOTICE:  ok' "$out") assertions)"; rm -f "$out"
  else
    cat "$out"; rm -f "$out"; echo "FAIL: $t"; exit 1
  fi
done

if [ -f "$HERE/http_regression.mjs" ]; then
  echo "== real stack: HTTP regression (GoTrue + PostgREST through the gateway)"
  API_URL="$API_URL" ANON_KEY="$ANON_KEY" SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-}" node "$HERE/http_regression.mjs"
fi
echo "REAL-STACK TESTS PASSED"
