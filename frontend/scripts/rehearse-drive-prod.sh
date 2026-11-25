#!/usr/bin/env bash
# RUN 02C: rehearse migration 20261126001200 (Google Drive) against a faithful LOCAL replica of the production schema.
# Production is only READ (catalog + markers + row counts, READ ONLY transactions, schema-only dump of `public`).
# No production data leaves production: the replica holds the production DDL and SYNTHETIC rows only.
#
#   frontend/scripts/rehearse-drive-prod.sh            (needs Docker + the DB password in the Keychain)
#
# Steps (each prints ok / FAIL; any FAIL stops):
#  1. production read-only: markers end at 1100, no Drive objects, catalog hash + line set
#  2. replica A = baseline + migrations 0100..1100 (repository chain) -> catalog must EQUAL production
#  3. replica B = production's own `public` DDL (schema-only dump) restored + synthetic data
#     -> apply-drive-hosted.sh in REHEARSAL mode (same interlocks, same single transaction, role `postgres`, not superuser)
#  4. Drive DB suite (92_google_drive.sql) on replica B after the migration
#  5. rollback: refused while a link/connection exists (nothing changed); on clean state restores the 1100 catalog exactly;
#     1200 applies again after its rollback; synthetic row counts unchanged throughout
# The throwaway container is removed on exit (KEEP=1 keeps it). Temp files: mode 600 under $TMPDIR, removed on exit.
set -euo pipefail
FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$FRONTEND/.." && pwd)"
REF=twjlnsxjtuntujarwner
CLIENT_IMG=public.ecr.aws/supabase/postgres:17.6.1.147
IMG=${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.167}
NAME=cs-drive-prod-rehearsal
T=$(mktemp -d); umask 077
cleanup() { rm -rf "$T"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; unset PGPASSWORD; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

# ---------- 1. production, read-only ----------
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || fail "database password not found in the Keychain"
# same search_path on both sides: expressions are deparsed relative to it (auth.uid() vs uid())
SP='SET search_path = "$user", public, extensions;'
prod() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; echo "$SP"; cat; } | docker run --rm -i -e PGPASSWORD "$CLIENT_IMG" psql "$DB" -X -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
sed -e "s/^select md5(string_agg(x, E'\\\\n' order by x)) || ' lines=' || count(\*) from (/select x from (/" -e 's/^) s;$/) s order by x;/' \
  "$FRONTEND/supabase/snapshot_catalog.sql" > "$T/catalog_lines.sql"
grep -q '^select x from' "$T/catalog_lines.sql" || fail "could not derive the line-set query"
echo "== 1. production (read-only)"
MARK=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | prod)
case ",$MARK," in *,20261124001000_collaboration,20261125001100_collab_hardening,) ;; *) fail "production markers do not end at 1100: $MARK";; esac
[ "$(echo "select (to_regclass('public.external_resource_links') is null and to_regclass('public.google_connections') is null)::text;" | prod)" = true ] || fail "Drive objects already exist in production"
PCAT=$(grep -v '^--' "$FRONTEND/supabase/snapshot_catalog.sql" | prod | tail -1)
# Supabase-managed storage service triggers (buckets/objects internals of the hosted storage service; not created by ClearSpace and
# absent from a plain Postgres image) are excluded from the comparison and only counted.
norm() { grep -vE '^trg:(buckets|objects)\.'; }
grep -v '^--' "$T/catalog_lines.sql" | prod > "$T/prod.raw"; norm < "$T/prod.raw" > "$T/prod.lines"
NSTOR=$(grep -cE '^trg:(buckets|objects)\.' "$T/prod.raw" || true)
docker run --rm -e PGPASSWORD "$CLIENT_IMG" pg_dump "$DB" --schema=public --schema-only > "$T/prod-public.sql"
unset PGPASSWORD
echo "ok - markers end at 1100, no Drive objects; catalog $PCAT; schema-only dump $(wc -l < "$T/prod-public.sql" | tr -d ' ') lines (no data)"

# ---------- throwaway container ----------
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=rehearsal "$IMG" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done; sleep 3
adm() { docker exec -i -e PGPASSWORD=rehearsal -e PGOPTIONS='-c client_min_messages=warning' "$NAME" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -X -q "$@"; }
newdb() {
  adm -d postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null
  for _ in 1 2 3 4 5; do
    adm -d postgres -At -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres' and pid <> pg_backend_pid()" >/dev/null || true
    adm -d postgres -c "CREATE DATABASE $1 TEMPLATE postgres" >/dev/null 2>&1 && break; sleep 1
  done
  for f in 00_auth_shims.sql 01_helpers.sql; do adm -d "$1" -f - < "$FRONTEND/supabase/tests/$f" >/dev/null; done
}
cat_of() { { echo "$SP"; grep -v '^--' "$FRONTEND/supabase/snapshot_catalog.sql"; } | adm -d "$1" -At | grep -v '^SET' | tail -1; }
lines_of() { { echo "$SP"; grep -v '^--' "$T/catalog_lines.sql"; } | adm -d "$1" -At | grep -v '^SET' | norm; }

# ---------- 2. replica A: repository chain up to 1100 ----------
echo "== 2. replica A (baseline + 0100..1100) vs production"
newdb rep_a
adm -d rep_a --single-transaction -f - < "$FRONTEND/supabase_schema.sql" >/dev/null
for f in "$FRONTEND"/supabase/migrations/*.sql; do
  [[ "$(basename "$f")" > "20261125001100~" ]] && continue
  adm -d rep_a --single-transaction -f - < "$f" >/dev/null
done
lines_of rep_a > "$T/a.lines"
if diff -q "$T/prod.lines" "$T/a.lines" >/dev/null; then echo "ok - replica A catalog == production catalog (all ClearSpace objects; $NSTOR Supabase-managed storage triggers excluded)"
else
  echo "catalog differences (production '<' vs replica '>'; first 40 lines, identifiers only):"
  diff "$T/prod.lines" "$T/a.lines" | grep -E '^[<>]' | cut -c1-160 | head -40
  fail "replica A is not faithful to production"
fi

# ---------- 3. replica B: production DDL + synthetic data, rehearsal through the real apply script ----------
echo "== 3. replica B (production DDL + synthetic data) -> apply-drive-hosted.sh (rehearsal mode)"
newdb rep_b
adm -d rep_b -c "ALTER DATABASE rep_b OWNER TO postgres" >/dev/null
# The image's default privileges would grant new tables/functions to anon/authenticated at restore time; production's ACLs come
# from the dump's own GRANT/REVOKE statements only, so the defaults are cleared for the restore and the storage schema (not part of
# the dump) is reproduced from the repository migrations' storage statements in replica A -- B is compared on `public` only.
adm -d rep_b >/dev/null <<'SQL'
do $$ declare r text; begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated, service_role', r);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated, service_role', r);
    execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated, service_role', r);
  end loop; end $$;
SQL
# the dump restores schema `public` objects only (public already exists in the template). Hosted-only column attribute
# options `SET (pg_attver=…)` (set by the hosted platform, unknown to a plain image, no effect on the catalog compared) are skipped.
sed -e '/^CREATE SCHEMA public;/d' -e '/^COMMENT ON SCHEMA public/d' -e '/ALTER COLUMN .* SET (pg_attver=[0-9]*);$/d' "$T/prod-public.sql" | adm -d rep_b --single-transaction -f - >/dev/null
# B is compared on schema public; CHECK texts are compared without parentheses (a pg_dump round trip re-deparses nested ANDs)
pubonly() { grep -vE '^(bucket:|pol:storage\.)' | sed -E '/^con:/s/[()]//g'; }
pubonly < "$T/prod.lines" > "$T/prod.pub"
# the auth.users -> profiles trigger lives on auth.users (not in a dump of `public`); recreate it exactly as the baseline defines it
sed -n '/^DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;/,/EXECUTE FUNCTION public.handle_new_user();/p' "$FRONTEND/supabase_schema.sql" | adm -d rep_b >/dev/null
lines_of rep_b | pubonly > "$T/b0.lines"
diff -q "$T/prod.pub" "$T/b0.lines" >/dev/null && echo "ok - replica B (restored production DDL) catalog == production catalog" \
  || { diff "$T/prod.pub" "$T/b0.lines" | grep -E '^[<>]' | cut -c1-160 | head -20; fail "restored DDL differs from production"; }
# synthetic data in the production shape: 3 users, owner/admin/member/viewer, projects with columns/cards, comments, a task file row
adm -d rep_b > /dev/null <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test'), ('00000000-0000-0000-0000-00000000000b', 'editor@rehearsal.test'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@rehearsal.test');
do $$ begin
  perform test.act_as('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test');
  insert into public.projects (id, name) select 'rp' || g, 'Rehearsal ' || g from generate_series(1, 6) g;
  insert into public.columns (id, project_id, name, position) select 'rp' || g || '-c' || c, 'rp' || g, 'Col ' || c, c from generate_series(1, 6) g, generate_series(0, 2) c;
  insert into public.cards (id, column_id, title) select 'rp' || g || '-k' || k, 'rp' || g || '-c' || (k % 3), 'Card ' || k from generate_series(1, 6) g, generate_series(1, 10) k;
  perform test.reset();
end $$;
SQL
# the migration markers are DATA (not in a schema-only dump): copy production's list (version names only)
adm -d rep_b -c "insert into public.clearspace_migrations (version) select unnest(string_to_array('$MARK', ','))" >/dev/null
C_BEFORE=$(adm -d rep_b -At -c "select (select count(*) from public.projects)||'/'||(select count(*) from public.columns)||'/'||(select count(*) from public.cards)||'/'||(select count(*) from public.project_members)||'/'||(select count(*) from public.activity_logs)")
echo "ok - synthetic data loaded (projects/columns/cards/members/events = $C_BEFORE)"
# point the real apply script (rehearsal mode) at this database: it targets -d postgres, so swap rep_b in as 'postgres'
adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('postgres', 'rep_b') and pid <> pg_backend_pid()" >/dev/null
adm -d template1 -c "ALTER DATABASE postgres RENAME TO postgres_template" >/dev/null
adm -d template1 -c "ALTER DATABASE rep_b RENAME TO postgres" >/dev/null
docker exec "$NAME" psql -h localhost -U supabase_admin -d postgres -c "select 1" >/dev/null 2>&1 || true
if ! ( cd "$ROOT" && REHEARSAL_CONTAINER="$NAME" REHEARSAL_PGPASSWORD=rehearsal REHEARSAL_USER=postgres CONFIRM_DRIVE=rehearsal TMPDIR="$T" \
    bash "$FRONTEND/scripts/apply-drive-hosted.sh" ) | sed 's/^/   | /'; then fail "apply-drive-hosted.sh rehearsal failed"; fi
C_AFTER=$(adm -d postgres -At -c "select (select count(*) from public.projects)||'/'||(select count(*) from public.columns)||'/'||(select count(*) from public.cards)||'/'||(select count(*) from public.project_members)||'/'||(select count(*) from public.activity_logs)")
[ "$C_AFTER" = "$C_BEFORE" ] && echo "ok - synthetic row counts unchanged by the migration" || fail "row counts changed: $C_BEFORE -> $C_AFTER"

# ---------- 4. Drive DB suite on a clone of the migrated replica ----------
# AUTOCOMMIT like the harness (each DO block = one committed request): wrapping the suite in ONE transaction is NOT production-like
# (Postgres then re-checks foreign keys of rows inserted earlier in the same transaction during cascades and reports false failures).
echo "== 4. 92_google_drive.sql on a clone of replica B (autocommit, like the harness)"
adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()" >/dev/null
adm -d template1 -c "CREATE DATABASE rep_b_suite TEMPLATE postgres" >/dev/null
OUT=$(docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -X -q -d rep_b_suite \
  < "$FRONTEND/supabase/tests/collab/92_google_drive.sql" 2>&1) || { echo "$OUT" | grep -E 'ERROR|DETAIL' | head -5; fail "Drive suite failed on the replica"; }
echo "ok - Drive suite on production DDL: $(echo "$OUT" | grep -c 'NOTICE:  ok') assertions"

# ---------- 5. rollback ----------
echo "== 5. rollback of 1200"
DOWN="$FRONTEND/supabase/rollback/20261126001200_google_drive.down.sql"
adm -d postgres > /dev/null <<'SQL'
insert into public.server_trust (purpose, secret_sha256) values ('google', encode(sha256(convert_to(repeat('r', 40), 'UTF8')), 'hex'))
  on conflict (purpose) do update set secret_sha256 = excluded.secret_sha256;
do $$ begin
  perform test.act_as('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test');
  perform public.drive_link_add(repeat('r', 40), 'rp1', null, 'rehearsalFile0001', 'Rehearsal', 'text/plain', 'https://drive.google.com/file/d/rehearsalFile0001/view', 1, now(), 'ok');
  perform test.reset();
end $$;
SQL
if adm -d postgres --single-transaction -f - < "$DOWN" >/dev/null 2>&1; then fail "rollback ran although a Drive link exists"; fi
[ "$(adm -d postgres -At -c "select count(*) from public.external_resource_links")" = 1 ] || fail "refused rollback changed data"
echo "ok - rollback REFUSED while a Drive link exists, nothing changed"
adm -d postgres -c "delete from public.external_resource_links; delete from public.server_trust where purpose = 'google'; delete from public.activity_logs where action_type like 'drive\_%'" >/dev/null
docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q --single-transaction -f - < "$DOWN" >/dev/null \
  || fail "rollback as role postgres failed on a clean state"
lines_of postgres | pubonly > "$T/b1.lines"
diff -q "$T/prod.pub" "$T/b1.lines" >/dev/null && echo "ok - catalog after rollback == production catalog (1100, schema public)" \
  || { diff "$T/prod.pub" "$T/b1.lines" | grep -E '^[<>]' | cut -c1-160 | head -20; fail "catalog after rollback differs"; }
C_RB=$(adm -d postgres -At -c "select (select count(*) from public.projects)||'/'||(select count(*) from public.columns)||'/'||(select count(*) from public.cards)||'/'||(select count(*) from public.project_members)||'/'||(select count(*) from public.activity_logs)")
[ "$C_RB" = "$C_BEFORE" ] && echo "ok - synthetic row counts unchanged after rollback" || fail "row counts after rollback: $C_RB"
docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q --single-transaction -f - \
  < "$FRONTEND/supabase/migrations/20261126001200_google_drive.sql" >/dev/null || fail "1200 does not apply again after its rollback"
echo "ok - 1200 applies again after its rollback"
echo "REHEARSAL PASS (production catalog $PCAT)"
