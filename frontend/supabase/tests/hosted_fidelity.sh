# Sourced by run.sh (uses its newdb/apply/psql_admin/run_test helpers and $BASELINE/$MIGRATIONS/$HERE).
#
# Scenario D: a hosted schema that DRIFTED from the baseline (the base tables projects/columns/cards were
#             created outside this repository, so their columns are unknown) must be refused by the
#             preflight with a precise message, and must change nothing.
# Scenario E: the hosted role model. On a hosted Supabase project the SQL editor / psql runs as the
#             NON-superuser `postgres`, not as the image's superuser. Baseline + migrations + the SQL test
#             suites must work as that role, twice (idempotent), and a role that does not own the objects
#             must be refused.

M1="${MIGRATIONS[0]}"; M2="${MIGRATIONS[1]}"; M3="${MIGRATIONS[2]}"

apply_as() { # $1 = role, $2 = db, $3 = file ; prints stderr+notices, returns psql's status
  docker exec -i -e PGPASSWORD=sectest -e PGOPTIONS='-c client_min_messages=notice' "$NAME" \
    psql -h localhost -U "$1" -v ON_ERROR_STOP=1 -q -d "$2" --single-transaction -f - < "$3" 2>&1
}
expect_refused() { # $1 = db, $2 = file, $3 = text that must appear, $4 = SQL that must return 't' afterwards (nothing changed)
  local out
  if out=$(apply_as supabase_admin "$1" "$2"); then echo "FAIL: $(basename "$2") was NOT refused on $1"; exit 1; fi
  echo "$out" | grep -q "Preflight failed" || { echo "FAIL: no preflight message on $1: $out"; exit 1; }
  echo "$out" | grep -qF -- "$3" || { echo "FAIL: preflight message lacks '$3': $out"; exit 1; }
  [ "$(psql_admin -d "$1" -At -c "$4")" = "t" ] || { echo "FAIL: the refused migration changed the database ($1)"; exit 1; }
  echo "ok - refused ($3), nothing changed"
}

echo "== Scenario D: drifted schema is refused early and precisely"
newdb cs_d1; apply cs_d1 "$BASELINE"
psql_admin -d cs_d1 -q -c "ALTER TABLE public.profiles DROP COLUMN display_name" >/dev/null
expect_refused cs_d1 "$M1" "col:profiles.display_name" "select to_regclass('public.clearspace_migrations') is null"

newdb cs_d2; apply cs_d2 "$BASELINE"
psql_admin -d cs_d2 -q -c "ALTER TABLE public.invitations RENAME COLUMN expires_at TO valid_until" >/dev/null
expect_refused cs_d2 "$M1" "col:invitations.expires_at" "select to_regclass('public.clearspace_migrations') is null"

newdb cs_d3; apply cs_d3 "$BASELINE"; apply cs_d3 "$M1"
psql_admin -d cs_d3 -q -c "ALTER TABLE public.cards DROP COLUMN archived" >/dev/null
expect_refused cs_d3 "$M2" "col:cards.archived" "select to_regprocedure('public.restore_project_board(text,jsonb)') is null"

newdb cs_d4; apply cs_d4 "$BASELINE"
expect_refused cs_d4 "$M2" "migration:20261117000100_security_foundation" "select to_regprocedure('public.restore_project_board(text,jsonb)') is null"

echo "== Scenario D5: a migrating role that does not own the objects is refused (ownership preflight)"
newdb cs_d5; apply cs_d5 "$BASELINE"
psql_admin -d cs_d5 -q <<'SQL' >/dev/null
CREATE ROLE migrator LOGIN PASSWORD 'sectest' NOSUPERUSER NOCREATEROLE;
GRANT ALL ON SCHEMA public TO migrator;
GRANT USAGE ON SCHEMA auth, extensions TO migrator;
SQL
if out=$(apply_as migrator cs_d5 "$M1"); then echo "FAIL: non-owner role was not refused"; exit 1; fi
echo "$out" | grep -q "Preflight failed" && echo "$out" | grep -qF "owner:public." || { echo "FAIL: ownership preflight message missing: $out"; exit 1; }
[ "$(psql_admin -d cs_d5 -At -c "select to_regclass('public.clearspace_migrations') is null")" = "t" ] || { echo "FAIL: non-owner run changed the database"; exit 1; }
psql_admin -d postgres -q -c "DROP ROLE IF EXISTS migrator" >/dev/null 2>&1 || true
echo "ok - non-owner refused, nothing changed"

echo "== Scenario E: baseline + migrations + SQL suites as the hosted role model (non-superuser postgres)"
psql_admin -d postgres -At -c "select 'postgres superuser? ' || rolsuper from pg_roles where rolname='postgres'"
psql_admin -d postgres -q -c "DROP DATABASE IF EXISTS cs_e" >/dev/null
for _ in 1 2 3 4 5; do
  psql_admin -d postgres -At -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres' and pid <> pg_backend_pid()" >/dev/null || true
  psql_admin -d postgres -q -c "CREATE DATABASE cs_e TEMPLATE postgres OWNER postgres" 2>/dev/null && break
  sleep 1
done
for f in 00_auth_shims.sql 01_helpers.sql; do psql_admin -d cs_e -f - < "$HERE/$f" >/dev/null; done
for f in "$BASELINE" "${MIGRATIONS[@]}"; do
  out=$(apply_as postgres cs_e "$f") || { echo "FAIL: $(basename "$f") as role postgres: $out"; exit 1; }
  echo "$out" | grep -E "Preflight ok" || true
done
for f in "${MIGRATIONS[@]}"; do
  apply_as postgres cs_e "$f" >/dev/null || { echo "FAIL: idempotent re-run of $(basename "$f") as postgres"; exit 1; }
done
echo "ok - applied twice as postgres"
[ "$(psql_admin -d cs_e -At -c "select count(*) from public.clearspace_migrations")" = "${#MIGRATIONS[@]}" ] || { echo "FAIL: migration markers"; exit 1; }
for t in "$HERE"/[1-9]*.test.sql; do run_test cs_e "$t"; done
