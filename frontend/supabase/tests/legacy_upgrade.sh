# Sourced by run.sh (uses its newdb/apply/psql_admin helpers and $BASELINE/$MIGRATIONS).
# Scenario B: upgrade of a database that already holds representative LEGACY data
# (plaintext invitation tokens, projects, boards, members). Proves the migration
# preserves rows, retires weak pending invitations and erases plaintext tokens.

echo "== Scenario B: upgrade of an existing database with legacy data"
newdb cs_b
apply cs_b "$BASELINE"

psql_admin -d cs_b -f - >/dev/null <<'SQL'
select test.mkuser('legacy-owner@example.test');
select test.mkuser('legacy-member@example.test');
SQL
psql_admin -d cs_b -f - >/dev/null < "$HERE/legacy_seed.sql"

apply cs_b "${MIGRATIONS[@]}"

echo "--- legacy upgrade assertions"
{ echo "begin;"; cat "$HERE/legacy_assert.sql"; echo "rollback;"; } \
  | docker exec -i -e PGPASSWORD=sectest clearspace-v1-sectest psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -q -d cs_b -f - 2>&1 \
  | grep -E "NOTICE:  ok|ERROR|FAIL" | sed -E 's/^.*NOTICE:  //'
[ "${PIPESTATUS[1]}" -eq 0 ] || { echo "FAIL: legacy upgrade assertions"; exit 1; }
