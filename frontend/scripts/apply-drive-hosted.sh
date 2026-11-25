#!/usr/bin/env bash
# Apply the Google Drive migration 20261126001200 to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# RUN ONLY AFTER THE OWNER'S WRITTEN APPROVAL (docs/run02/PRODUCTION_ROLLOUT.md).
#
#   CONFIRM_DRIVE=twjlnsxjtuntujarwner frontend/scripts/apply-drive-hosted.sh
#   optional: GOOGLE_SERVER_SECRET_SHA256=<64 hex>   registers the HASH of GOOGLE_SERVER_SECRET in server_trust('google')
#
# Interlocks (each stops BEFORE any hosted write): the confirmation names the project; the working tree is clean; the
# migration and its rollback have exactly the rehearsed checksums; hosted holds exactly the RUN 01 markers (incl. 1000 +
# 1100, not 1200); the connecting role owns public.cards/projects (needed by the rollback's DROP TRIGGER) and
# require_server_secret() exists. A fresh pg_dump of `public` is taken and checksummed before the write. The migration
# runs in ONE transaction. Afterwards: row counts unchanged, marker present, the new tables have RLS and no client
# access, no anonymous EXECUTE on the new functions, zero links / connections. Not done here: Vercel env, deployment, Git.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_DRIVE=rehearsal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_DRIVE:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_DRIVE=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" psql -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-drive-rehearsal-backup-$STAMP"
else
  [ "${CONFIRM_DRIVE:-}" = "$REF" ] || { echo "refusing: set CONFIRM_DRIVE=$REF (only after the written approval)"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-pre-drive"
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M=$S/migrations/20261126001200_google_drive.sql; D=$S/rollback/20261126001200_google_drive.down.sql
[ "$(sha $M)" = 8c0b4b0610c10dc077eb6b76b85ad6eb000a8d215dbc9b12ef9f41ed77d6a973 ] || { echo "refusing: 1200 differs from the rehearsed file"; exit 2; }
[ "$(sha $D)" = 5edf62a3f6334c694d3e7c8454d2166fca81d0f66cdab6ae947544604c01278f ] || { echo "refusing: 1200 rollback differs from the rehearsed one"; exit 2; }
ro() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | pg -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
counts() { echo "select 'projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' resources='||(select count(*) from public.task_resources)||' members='||(select count(*) from public.project_members)||' comments='||(select count(*) from public.task_comments)||' events='||(select count(*) from public.activity_logs)||' notifications='||(select count(*) from public.notifications)||' profiles='||(select count(*) from public.profiles)||' auth.users='||(select count(*) from auth.users);" | ro; }

echo "== 0. hosted state before (read-only)"
markers=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | ro)
case ",$markers," in
  *,20261124001000_collaboration,20261125001100_collab_hardening,) ;;
  *) echo "refusing: 1000/1100 must be the newest markers (and 1200 absent): $markers"; exit 2;;
esac
pre=$(echo "select (to_regprocedure('public.require_server_secret(text,text)') is not null)::text || ',' || pg_has_role(current_user, (select relowner from pg_class where oid = 'public.cards'::regclass), 'USAGE')::text || ',' || pg_has_role(current_user, (select relowner from pg_class where oid = 'public.projects'::regclass), 'USAGE')::text || ',' || (to_regclass('public.external_resource_links') is null)::text;" | ro)
[ "$pre" = "true,true,true,true" ] || { echo "refusing: prerequisites (require_server_secret, owner of cards/projects, no 1200 objects): $pre"; exit 2; }
CAT0=$(ro < $S/snapshot_catalog.sql | tail -1)
C0=$(counts); echo "ok - markers end at 1100, prerequisites present, catalog $CAT0"; echo "counts before: $C0"

echo "== 1. backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
dump > "$BK/public.dump" 2> "$BK/pg_dump.stderr" && [ -s "$BK/public.dump" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
echo "$CAT0" > "$BK/catalog-before.txt"
echo "ok - backup $(du -h "$BK/public.dump" | cut -f1)"

echo "== 2. apply (ONE transaction)"
if { echo "SET client_min_messages = warning;"; cat "$M"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied 20261126001200_google_drive"
else echo "FAILED: the migration changed nothing (single transaction). STOP and report; do not retry blindly."; exit 1; fi

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'marker=' || (select count(*) from public.clearspace_migrations where version = '20261126001200_google_drive')
  || ' rls=' || (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('google_connections', 'google_oauth_states', 'integration_audit', 'external_resource_links') and c.relrowsecurity)
  || ' client_token_access=' || (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in ('google_connections', 'google_oauth_states') and grantee in ('anon', 'authenticated'))
  || ' anon_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'google\_%' or p.proname like 'drive\_link\_%') and has_function_privilege('anon', p.oid, 'EXECUTE'))
  || ' links=' || (select count(*) from public.external_resource_links)
  || ' connections=' || (select count(*) from public.google_connections);
SQL
)
echo "$v"
[ "$v" = "marker=1 rls=4 client_token_access=0 anon_exec=0 links=0 connections=0" ] && echo "ok - Drive state as rehearsed" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (as the owner, one transaction): $D ; backup: $BK"; exit 1; fi

if [ -n "${GOOGLE_SERVER_SECRET_SHA256:-}" ]; then
  [[ "$GOOGLE_SERVER_SECRET_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "GOOGLE_SERVER_SECRET_SHA256 must be 64 lowercase hex characters (the HASH, never the secret)"; exit 1; }
  echo "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', '$GOOGLE_SERVER_SECRET_SHA256') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();" \
    | pg -q -v ON_ERROR_STOP=1 >/dev/null && echo "ok - Google server secret hash registered in server_trust('google')"
fi
echo "DONE: Drive migration applied and verified. Next (docs/run02/PRODUCTION_ROLLOUT.md): Vercel env, staged build, smoke, promote."
