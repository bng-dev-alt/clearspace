#!/usr/bin/env bash
# RUN 07: rehearse migration 20261130001600 (project communication hub) against a faithful LOCAL replica of the production schema.
# Production is only READ (catalog + markers, READ ONLY transactions, schema-only dump of `public`). No production data leaves production:
# the replica holds the production DDL and SYNTHETIC rows only (Drive / Gmail / RUN 01 / RUN 05-era rows). Template: rehearse-notify-prod.sh.
#
#   frontend/scripts/rehearse-hub-prod.sh            (needs Docker + the DB password in the Keychain)
#
#  1. production read-only: markers end at 1500, no hub objects, catalog line set + schema-only dump
#  2. replica A = baseline + migrations 0100..1500 (repository chain) -> catalog must EQUAL production
#  3. replica B = production's own `public` DDL + synthetic data -> apply-hub-hosted.sh in REHEARSAL mode (same interlocks, one
#     transaction, role `postgres`); the script itself proves counts + content fingerprints unchanged and no extension installed
#  4. on clones: the DB contracts the CURRENTLY deployed code relies on (92 Drive, 93 Gmail, 94 Calendar, 95 notifications) + the hub
#     suite (96), and the in-app parity scenario on the production DDL before (1500) and after (1600): identical notifications
#  5. rollback: refused while a destination exists (nothing changed); on clean state restores the 1500 catalog exactly with the rows
#     intact; 1600 applies again after its rollback
# The throwaway container is removed on exit (KEEP=1 keeps it). Temp files: mode 600 under $TMPDIR, removed on exit.
set -euo pipefail
FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$FRONTEND/.." && pwd)"
REF=twjlnsxjtuntujarwner
CLIENT_IMG=public.ecr.aws/supabase/postgres:17.6.1.147
IMG=${PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.167}
NAME=cs-hub-prod-rehearsal
T=$(mktemp -d); umask 077
cleanup() { rm -rf "$T"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; unset PGPASSWORD; }
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }

# ---------- 1. production, read-only ----------
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || fail "database password not found in the Keychain"
SP='SET search_path = "$user", public, extensions;'
prod() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; echo "$SP"; cat; } | docker run --rm -i -e PGPASSWORD "$CLIENT_IMG" psql "$DB" -X -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
sed -e "s/^select md5(string_agg(x, E'\\\\n' order by x)) || ' lines=' || count(\*) from (/select x from (/" -e 's/^) s;$/) s order by x;/' \
  "$FRONTEND/supabase/snapshot_catalog.sql" > "$T/catalog_lines.sql"
grep -q '^select x from' "$T/catalog_lines.sql" || fail "could not derive the line-set query"
echo "== 1. production (read-only)"
MARK=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | prod)
case ",$MARK," in *,20261128001400_google_calendar,20261129001500_notification_channels,) ;; *) fail "production markers do not end at 1500: $MARK";; esac
[ "$(echo "select (to_regclass('public.hub_destinations') is null and to_regprocedure('public.hub_scheduler_tick(timestamp with time zone)') is null)::text;" | prod)" = true ] || fail "hub objects already exist in production"
PCAT=$(grep -v '^--' "$FRONTEND/supabase/snapshot_catalog.sql" | prod | tail -1)
norm() { grep -vE '^trg:(buckets|objects)\.'; }
grep -v '^--' "$T/catalog_lines.sql" | prod > "$T/prod.raw"; norm < "$T/prod.raw" > "$T/prod.lines"
NSTOR=$(grep -cE '^trg:(buckets|objects)\.' "$T/prod.raw" || true)
docker run --rm -e PGPASSWORD "$CLIENT_IMG" pg_dump "$DB" --schema=public --schema-only > "$T/prod-public.sql"
unset PGPASSWORD
echo "ok - markers end at 1500, no hub objects; catalog $PCAT; schema-only dump $(wc -l < "$T/prod-public.sql" | tr -d ' ') lines (no data)"

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
lines_of() { { echo "$SP"; grep -v '^--' "$T/catalog_lines.sql"; } | adm -d "$1" -At | grep -v '^SET' | norm; }

# ---------- 2. replica A: repository chain up to 1500 ----------
echo "== 2. replica A (baseline + 0100..1500) vs production"
newdb rep_a
adm -d rep_a --single-transaction -f - < "$FRONTEND/supabase_schema.sql" >/dev/null
for f in "$FRONTEND"/supabase/migrations/*.sql; do
  [[ "$(basename "$f")" > "20261129001500~" ]] && continue
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
echo "== 3. replica B (production DDL + synthetic Drive/Gmail/RUN 01/RUN 05 data) -> apply-hub-hosted.sh (rehearsal mode)"
newdb rep_b
adm -d rep_b -c "ALTER DATABASE rep_b OWNER TO postgres" >/dev/null
adm -d rep_b >/dev/null <<'SQL'
do $$ declare r text; begin
  foreach r in array array['postgres', 'supabase_admin'] loop
    execute format('alter default privileges for role %I in schema public revoke all on tables from anon, authenticated, service_role', r);
    execute format('alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated, service_role', r);
    execute format('alter default privileges for role %I in schema public revoke all on functions from anon, authenticated, service_role', r);
  end loop; end $$;
SQL
sed -e '/^CREATE SCHEMA public;/d' -e '/^COMMENT ON SCHEMA public/d' -e '/ALTER COLUMN .* SET (pg_attver=[0-9]*);$/d' "$T/prod-public.sql" | adm -d rep_b --single-transaction -f - >/dev/null
pubonly() { grep -vE '^(bucket:|pol:storage\.)' | sed -E '/^con:/s/[()]//g'; }
pubonly < "$T/prod.lines" > "$T/prod.pub"
sed -n '/^DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;/,/EXECUTE FUNCTION public.handle_new_user();/p' "$FRONTEND/supabase_schema.sql" | adm -d rep_b >/dev/null
lines_of rep_b | pubonly > "$T/b0.lines"
diff -q "$T/prod.pub" "$T/b0.lines" >/dev/null && echo "ok - replica B (restored production DDL) catalog == production catalog" \
  || { diff "$T/prod.pub" "$T/b0.lines" | grep -E '^[<>]' | cut -c1-160 | head -20; fail "restored DDL differs from production"; }
# synthetic data in the production shape: users, projects/columns/cards, PLUS the Drive-era rows production has today
# (trust row, one Drive link + one Gmail link made through the real RPCs, one active Google connection, audit rows) -- all synthetic
adm -d rep_b > /dev/null <<'SQL'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test'), ('00000000-0000-0000-0000-00000000000b', 'editor@rehearsal.test'),
  ('00000000-0000-0000-0000-00000000000c', 'viewer@rehearsal.test');
insert into public.server_trust (purpose, secret_sha256) values ('google', encode(sha256(convert_to(repeat('r', 40), 'UTF8')), 'hex'));
do $$ begin
  perform test.act_as('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test');
  insert into public.projects (id, name) select 'rp' || g, 'Rehearsal ' || g from generate_series(1, 6) g;
  insert into public.columns (id, project_id, name, position) select 'rp' || g || '-c' || c, 'rp' || g, 'Col ' || c, c from generate_series(1, 6) g, generate_series(0, 2) c;
  insert into public.cards (id, column_id, title) select 'rp' || g || '-k' || k, 'rp' || g || '-c' || (k % 3), 'Card ' || k from generate_series(1, 6) g, generate_series(1, 10) k;
  perform public.drive_link_add(repeat('r', 40), 'rp1', null, 'rehearsalFile0001', 'Rehearsal', 'text/plain', 'https://drive.google.com/file/d/rehearsalFile0001/view', 1, now(), 'ok');
  perform test.reset();
end $$;
insert into public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc)
  values ('00000000-0000-0000-0000-00000000000a', '123456789012345678901', 'owner@rehearsal.test',
          array['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000abcd.AAAA.BBBB.CCCC');
do $$ begin
  perform test.act_as('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test');
  perform public.gmail_link_add(repeat('r', 40), 'rp1', null, 'thread', 'refRehearsalGmail000001', '123456789012345678901', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 2, null, 'ok');
  perform test.reset();
end $$;
insert into public.integration_audit (user_id, provider, event, detail) values
  ('00000000-0000-0000-0000-00000000000a', 'google', 'connected', null), ('00000000-0000-0000-0000-00000000000a', 'google', 'service_added', 'gmail');
-- RUN 01-era in-app notifications + activity (synthetic) -- 1600 must leave them byte-identical
insert into public.notifications (recipient_id, project_id, type, actor_name, entity_type, entity_id, card_id, title)
  select '00000000-0000-0000-0000-00000000000b', 'rp1', 'assignment', 'Owner', 'task', 'rp1-k' || k, 'rp1-k' || k, 'Card ' || k from generate_series(1, 5) k;
-- RUN 05-era rows (synthetic): a personal Telegram channel + preferences; task comments (1600 adds a trigger on task_comments)
insert into public.notification_channels (user_id, provider, status, secret_enc, label) values ('00000000-0000-0000-0000-00000000000a', 'telegram', 'active', 'v1.0000beef.aaaa.bbbb.cccc', 'R');
do $$ begin
  perform test.act_as('00000000-0000-0000-0000-00000000000a', 'owner@rehearsal.test');
  insert into public.task_comments (id, card_id, author_name, content) select 'rc' || k, 'rp1-k' || k, 'x', 'Synthetic comment ' || k from generate_series(1, 3) k;
  perform test.reset();
end $$;
SQL
adm -d rep_b -c "insert into public.clearspace_migrations (version) select unnest(string_to_array('$MARK', ','))" >/dev/null
CNT="select (select count(*) from public.projects)||'/'||(select count(*) from public.columns)||'/'||(select count(*) from public.cards)||'/'||(select count(*) from public.project_members)||'/'||(select count(*) from public.activity_logs)||'/'||(select count(*) from public.external_resource_links)||'/'||(select count(*) from public.google_connections)||'/'||(select count(*) from public.integration_audit)||'/'||(select count(*) from public.gmail_link_sources)||'/'||(select count(*) from public.notifications)||'/'||(select count(*) from public.task_comments)||'/'||(select count(*) from public.notification_channels)"
C_BEFORE=$(adm -d rep_b -At -c "$CNT")
echo "ok - synthetic data loaded (projects/columns/cards/members/events/links/connections/audit/gmail_sources/notifications/comments/notify_channels = $C_BEFORE)"
# parity baseline: a clone of the production DDL at 1500 (before the migration)
adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'rep_b' and pid <> pg_backend_pid()" >/dev/null
adm -d template1 -c "CREATE DATABASE rep_b_pre TEMPLATE rep_b" >/dev/null
renamed=0   # background workers reconnect to "postgres": terminate + rename, retried like newdb()
for _ in 1 2 3 4 5 6 7 8; do
  adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname in ('postgres', 'rep_b') and pid <> pg_backend_pid()" >/dev/null
  if adm -d template1 -c "ALTER DATABASE postgres RENAME TO postgres_template" >/dev/null 2>&1; then renamed=1; break; fi
  sleep 1
done
[ $renamed = 1 ] || fail "could not rename the template database (sessions keep reconnecting)"
adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'rep_b' and pid <> pg_backend_pid()" >/dev/null
adm -d template1 -c "ALTER DATABASE rep_b RENAME TO postgres" >/dev/null
if ! ( cd "$ROOT" && REHEARSAL_CONTAINER="$NAME" REHEARSAL_PGPASSWORD=rehearsal REHEARSAL_USER=postgres CONFIRM_HUB=rehearsal TMPDIR="$T" \
    bash "$FRONTEND/scripts/apply-hub-hosted.sh" ) | sed 's/^/   | /'; then fail "apply-hub-hosted.sh rehearsal failed"; fi
[ "$(adm -d postgres -At -c "select count(*) from public.clearspace_migrations where version = '20261130001600_communication_hub'")" = 1 ] || fail "apply-hub-hosted.sh did not apply 1600"
C_AFTER=$(adm -d postgres -At -c "$CNT")
[ "$C_AFTER" = "$C_BEFORE" ] && echo "ok - synthetic row counts unchanged by the migration" || fail "row counts changed: $C_BEFORE -> $C_AFTER"

# ---------- 4. DB suites on a clone of the migrated replica ----------
echo "== 4. Drive + Gmail + Calendar + notification contracts (deployed code) + hub suite on a clone of replica B (autocommit, like the harness)"
for db in rep_b_suite rep_b_post; do
  for _ in 1 2 3 4 5 6 7 8; do
    adm -d template1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid()" >/dev/null
    adm -d template1 -c "CREATE DATABASE $db TEMPLATE postgres" >/dev/null 2>&1 && break; sleep 1
  done
done
# the suites register their own trust secret and users: start them from the migrated schema without the synthetic Google rows
adm -d rep_b_suite -c "delete from public.external_resource_links; delete from public.google_connections; delete from public.integration_audit; delete from public.server_trust where purpose = 'google'; delete from public.notification_channels" >/dev/null
for s in 92_google_drive 93_gmail 94_google_calendar 95_notification_channels 96_communication_hub; do
  OUT=$(docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -X -q -d rep_b_suite \
    < "$FRONTEND/supabase/tests/collab/$s.sql" 2>&1) || { echo "$OUT" | grep -E 'ERROR|DETAIL' | head -5; fail "$s failed on the migrated replica"; }
  echo "ok - $s on production DDL + 1600: $(echo "$OUT" | grep -c 'NOTICE:  ok') assertions"
  adm -d rep_b_suite -c "delete from public.external_resource_links; delete from public.google_connections; delete from public.integration_audit; delete from public.server_trust where purpose = 'google'" >/dev/null
done

PAR() { docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U supabase_admin -v ON_ERROR_STOP=1 -X -q -At -d "$1" < "$FRONTEND/supabase/tests/collab/95_parity_scenario.sql" 2>/dev/null | grep '^parity:'; }
P_PRE=$(PAR rep_b_pre); P_POST=$(PAR rep_b_post)
[ -n "$P_PRE" ] && [ "$P_PRE" = "$P_POST" ] || fail "parity: in-app notifications differ on production DDL: 1500 $P_PRE / 1600 $P_POST"
echo "ok - parity on the production DDL: RUN 01 actions leave identical in-app notifications on 1500 and 1600 ($P_POST)"

# ---------- 5. rollback ----------
echo "== 5. rollback of 1600"
DOWN="$FRONTEND/supabase/rollback/20261130001600_communication_hub.down.sql"
adm -d postgres -c "insert into public.hub_destinations (project_id, provider, ext_key_hmac, ext_ref_enc, label, kind, created_by) values ('rp1', 'telegram', repeat('a', 64), 'v1.0000beef.aaaa.bbbb.cccc', 'R', 'telegram_group', '00000000-0000-0000-0000-00000000000a')" >/dev/null
if docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q --single-transaction -f - < "$DOWN" >/dev/null 2>&1; then fail "rollback ran although a destination exists"; fi
[ "$(adm -d postgres -At -c "select count(*) from public.clearspace_migrations where version = '20261130001600_communication_hub'")" = 1 ] || fail "refused rollback changed data"
echo "ok - rollback REFUSED while a hub destination exists, nothing changed"
adm -d postgres -c "delete from public.hub_destinations; delete from public.hub_audit" >/dev/null
docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q --single-transaction -f - < "$DOWN" >/dev/null \
  || fail "rollback as role postgres failed on a clean state"
lines_of postgres | pubonly > "$T/b1.lines"
diff -q "$T/prod.pub" "$T/b1.lines" >/dev/null && echo "ok - catalog after rollback == production catalog (1500, schema public)" \
  || { diff "$T/prod.pub" "$T/b1.lines" | grep -E '^[<>]' | cut -c1-160 | head -20; fail "catalog after rollback differs"; }
C_RB=$(adm -d postgres -At -c "$CNT")
[ "$C_RB" = "$C_BEFORE" ] && echo "ok - synthetic row counts (links, Gmail source, connection, notifications, comments, RUN 05 channel) unchanged after rollback" || fail "row counts after rollback: $C_RB"
docker exec -i -e PGPASSWORD=rehearsal "$NAME" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q --single-transaction -f - \
  < "$FRONTEND/supabase/migrations/20261130001600_communication_hub.sql" >/dev/null || fail "1600 does not apply again after its rollback"
echo "ok - 1600 applies again after its rollback"
echo "REHEARSAL PASS (production catalog $PCAT)"
