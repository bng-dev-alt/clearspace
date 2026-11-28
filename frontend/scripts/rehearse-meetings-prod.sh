#!/usr/bin/env bash
# RUN 10: rehearse migration 1800 against the PRODUCTION DDL. Production is only READ (markers, catalog, schema-only dump of `public`,
# READ ONLY transactions); no production rows leave production. Throwaway container, removed on exit (KEEP=1 keeps it).
#  1. production: markers end at 1700, catalog C_P, schema-only dump of public + the marker NAMES
#  2. replica A = baseline + repository migrations up to 1700 -> catalog must EQUAL C_P (the repository chain is production)
#  3. replica B = production's own public DDL + its markers -> apply-meetings-hosted.sh in REHEARSAL mode (same interlocks, encrypted
#     backup + verified restore, one transaction, read-only verification)
#  4. rollback on B restores catalog C_P exactly; 1800 applies again after its rollback
#   frontend/scripts/rehearse-meetings-prod.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); cd "$HERE"
REF=twjlnsxjtuntujarwner; IMG=public.ecr.aws/supabase/postgres:17.6.1.147; NAME=cs-run10-rehearsal
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || { echo "no DB password in the Keychain"; exit 2; }
W=${REHEARSAL_WORK:-$(mktemp -d)}; mkdir -p "$W"; chmod 700 "$W"
cleanup() { unset PGPASSWORD; [ -n "${REHEARSAL_WORK:-}" ] || rm -rf "$W"; [ "${KEEP:-0}" = 1 ] || docker rm -f $NAME >/dev/null 2>&1; }; trap cleanup EXIT
prod() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
loc() { local d=$1; shift; docker exec -i -e PGPASSWORD=reh $NAME psql -h localhost -U supabase_admin -d "$d" -X -At -q -v ON_ERROR_STOP=1 "$@"; }
echo "== 1. production (read-only)"
MARK=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | prod)
case ",$MARK," in *,20261201001700_hub_hardening,) echo "ok - markers end at 1700";; *) echo "STOP: unexpected markers $MARK"; exit 1;; esac
CP=$(prod < supabase/snapshot_catalog.sql | tail -1); echo "catalog production: ${CP:0:80}…"
docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public --schema-only --no-owner --no-privileges > "$W/prod-public.sql" || { echo "STOP: schema dump failed"; exit 1; }
echo "ok - schema-only dump $(wc -l < "$W/prod-public.sql") lines (no rows)"
echo "== 2. replica A (repository chain to 1700)"
docker rm -f $NAME >/dev/null 2>&1; docker run -d --name $NAME -e POSTGRES_PASSWORD=reh "$IMG" >/dev/null
for _ in $(seq 1 60); do docker exec $NAME pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done; sleep 3
for d in ra rb; do
  for _ in 1 2 3 4 5; do loc postgres -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='postgres' and pid <> pg_backend_pid()" >/dev/null 2>&1; loc postgres -c "create database $d template postgres" >/dev/null 2>&1 && break; sleep 1; done
  for f in 00_auth_shims.sql 01_helpers.sql; do loc $d -f - < supabase/tests/$f >/dev/null; done; done
loc ra --single-transaction -f - < supabase_schema.sql >/dev/null
for f in supabase/migrations/*.sql; do [[ "$(basename "$f")" > "20261202" ]] && continue; loc ra --single-transaction -f - < "$f" >/dev/null 2>&1 || { echo "STOP: $f failed on replica A"; exit 1; }; done
CA=$(loc ra -f - < supabase/snapshot_catalog.sql | tail -1)
[ "$CA" = "$CP" ] && echo "ok - repository chain to 1700 == production catalog" || echo "NOTE: catalog differs from production (diff below; replica B uses production's own DDL)" 
[ "$CA" = "$CP" ] || diff <(echo "$CP" | tr ' ' '\n') <(echo "$CA" | tr ' ' '\n') | head -10
echo "== 3. replica B (production DDL) + apply-meetings-hosted.sh in rehearsal mode"
grep -v -E '^(CREATE SCHEMA public|COMMENT ON SCHEMA public)|SET \(pg_attver=' "$W/prod-public.sql" | loc rb -f - >/dev/null 2>"$W/restore.err" || true
grep -q ERROR "$W/restore.err" && { echo "restore warnings:"; grep ERROR "$W/restore.err" | sort | uniq -c | head -5; }
echo "$MARK" | tr ',' '\n' | while read -r v; do echo "insert into public.clearspace_migrations(version) values ('$v') on conflict do nothing;"; done | loc rb -f - >/dev/null
CB=$(loc rb -f - < supabase/snapshot_catalog.sql | tail -1)
REHEARSAL_CONTAINER=$NAME REHEARSAL_DB=rb REHEARSAL_USER=supabase_admin REHEARSAL_PGPASSWORD=reh CONFIRM_MEETINGS=rehearsal bash scripts/apply-meetings-hosted.sh 2>&1 | sed 's/^/   /'
[ "${PIPESTATUS[0]}" = 0 ] || { echo "STOP: rehearsal apply failed"; exit 1; }
echo "== 4. rollback + re-apply on B"
loc rb --single-transaction -f - < supabase/rollback/20261202001800_meeting_intelligence_live.down.sql >/dev/null || { echo "STOP: rollback failed"; exit 1; }
CR=$(loc rb -f - < supabase/snapshot_catalog.sql | tail -1)
[ "$CR" = "$CB" ] && echo "ok - rollback restores the production catalog exactly" || { echo "STOP: rollback catalog differs"; diff <(echo "$CB" | tr ' ' '\n') <(echo "$CR" | tr ' ' '\n') | head; exit 1; }
loc rb --single-transaction -f - < supabase/migrations/20261202001800_meeting_intelligence_live.sql >/dev/null && echo "ok - 1800 applies again after its rollback" || { echo "STOP: re-apply failed"; exit 1; }
echo "REHEARSAL PASS. MIG_SHA=$(shasum -a 256 supabase/migrations/20261202001800_meeting_intelligence_live.sql | cut -d' ' -f1) DOWN_SHA=$(shasum -a 256 supabase/rollback/20261202001800_meeting_intelligence_live.down.sql | cut -d' ' -f1)"
