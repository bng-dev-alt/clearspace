#!/usr/bin/env bash
# RUN 03C: apply the Gmail migration 20261127001300 to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# Required BEFORE any build of the RUN 03 code goes live -- even with Gmail switched off: the shared OAuth completion calls
# google_connection_sub / google_service_audit (1300). The RUN 02C code keeps working on 1300 (rehearse-gmail-prod.sh proves it).
# RUN ONLY AFTER THE OWNER'S WRITTEN APPROVAL (docs/run03/PRODUCTION_ROLLOUT.md).
#
#   CONFIRM_GMAIL=twjlnsxjtuntujarwner frontend/scripts/apply-gmail-hosted.sh
#
# Interlocks (each stops BEFORE any hosted write): the confirmation names the project; the working tree is clean; migration and
# rollback have exactly the rehearsed checksums; hosted markers end at 1200 (1300 absent, no Gmail objects); the connecting role
# owns cards/projects/external_resource_links/integration_audit; require_server_secret() exists and server_trust('google') is
# registered. A fresh pg_dump of `public` is taken and checksummed before the write. ONE transaction. Afterwards (read-only):
# row counts unchanged, the existing Google rows (Drive links, connections, audit, trust) have the SAME content fingerprint over
# their 1200 columns, marker present, gmail_link_sources has RLS and no client access, no anonymous EXECUTE on the new functions.
# Not done here: Vercel env, deployment, Git.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_GMAIL=rehearsal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_GMAIL:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_GMAIL=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" psql -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-gmail-rehearsal-backup-$STAMP"
else
  [ "${CONFIRM_GMAIL:-}" = "$REF" ] || { echo "refusing: set CONFIRM_GMAIL=$REF (only after the written approval)"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-pre-gmail"
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M=$S/migrations/20261127001300_gmail.sql; D=$S/rollback/20261127001300_gmail.down.sql
[ "$(sha $M)" = 53f3282c4c206240d085a3868fa464ab19fe37706c0641399d0411c084821ab7 ] || { echo "refusing: 1300 differs from the rehearsed file"; exit 2; }
[ "$(sha $D)" = 75bef73f400cdee6b6dbecff03b287f2978ce5be3d7b5c62c4e11c6ce4077f77 ] || { echo "refusing: 1300 rollback differs from the rehearsed one"; exit 2; }
ro() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | pg -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
counts() { echo "select 'projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' resources='||(select count(*) from public.task_resources)||' members='||(select count(*) from public.project_members)||' comments='||(select count(*) from public.task_comments)||' events='||(select count(*) from public.activity_logs)||' notifications='||(select count(*) from public.notifications)||' profiles='||(select count(*) from public.profiles)||' auth.users='||(select count(*) from auth.users)||' links='||(select count(*) from public.external_resource_links)||' connections='||(select count(*) from public.google_connections)||' audit='||(select count(*) from public.integration_audit)||' trust='||(select count(*) from public.server_trust);" | ro; }
# content fingerprint of the existing Google rows over the columns they have NOW (1200): 1300 only adds columns/constraints
FPCOLS=$(echo "select string_agg(table_name || ':' || cols, ' ') from (select table_name, string_agg(column_name, ',' order by ordinal_position) cols from information_schema.columns where table_schema = 'public' and table_name in ('external_resource_links', 'google_connections', 'integration_audit', 'server_trust') group by table_name) t;" | ro)
fingerprint() {
  local q="select 'fp'" t c
  for tc in $FPCOLS; do t=${tc%%:*}; c=${tc#*:}; q="$q || ' $t=' || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from (select $c from public.$t) x), 'empty')"; done
  echo "$q;" | ro
}

echo "== 0. hosted state before (read-only)"
markers=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | ro)
case ",$markers," in
  *,20261125001100_collab_hardening,20261126001200_google_drive,) ;;
  *) echo "refusing: 1100/1200 must be the newest markers (and 1300 absent): $markers"; exit 2;;
esac
own() { echo "pg_has_role(current_user, (select relowner from pg_class where oid = 'public.$1'::regclass), 'USAGE')::text"; }
pre=$(echo "select (to_regprocedure('public.require_server_secret(text,text)') is not null)::text || ',' || $(own cards) || ',' || $(own projects) || ',' || $(own external_resource_links) || ',' || $(own integration_audit) || ',' || (to_regclass('public.gmail_link_sources') is null)::text || ',' || (to_regprocedure('public.google_connection_sub(text,text)') is null)::text || ',' || (select count(*) from public.server_trust where purpose = 'google')::text;" | ro)
[ "$pre" = "true,true,true,true,true,true,true,1" ] || { echo "refusing: prerequisites (require_server_secret, owner of cards/projects/links/audit, no 1300 objects, trust registered): $pre"; exit 2; }
CAT0=$(ro < $S/snapshot_catalog.sql | tail -1)
C0=$(counts); F0=$(fingerprint)
echo "ok - markers end at 1200, prerequisites present, catalog $CAT0"; echo "counts before: $C0"; echo "fingerprint before: $F0"

echo "== 1. backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
dump > "$BK/public.dump" 2> "$BK/pg_dump.stderr" && [ -s "$BK/public.dump" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
echo "$CAT0" > "$BK/catalog-before.txt"; echo "$C0" > "$BK/counts-before.txt"; echo "$F0" > "$BK/fingerprint-before.txt"
echo "ok - backup $(du -h "$BK/public.dump" | cut -f1)"

echo "== 2. apply (ONE transaction)"
if { echo "SET client_min_messages = warning;"; cat "$M"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied 20261127001300_gmail"
else echo "FAILED: the migration changed nothing (single transaction). STOP and report; do not retry blindly."; exit 1; fi

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
F1=$(fingerprint); [ "$F1" = "$F0" ] && echo "ok - existing Google rows unchanged (content fingerprint over their 1200 columns)" || { echo "fingerprint changed: $F1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'marker=' || (select count(*) from public.clearspace_migrations where version = '20261127001300_gmail')
  || ' rls=' || (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = 'gmail_link_sources' and c.relrowsecurity)
  || ' client_source_access=' || (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'gmail_link_sources' and grantee in ('anon', 'authenticated'))
  || ' anon_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'gmail\_%' or p.proname like 'google\_%') and has_function_privilege('anon', p.oid, 'EXECUTE'))
  || ' gmail_links=' || (select count(*) from public.external_resource_links where provider like 'gmail\_%')
  || ' gmail_sources=' || (select count(*) from public.gmail_link_sources);
SQL
)
echo "$v"
[ "$v" = "marker=1 rls=1 client_source_access=0 anon_exec=0 gmail_links=0 gmail_sources=0" ] && echo "ok - Gmail state as rehearsed" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (as the owner, one transaction): $D ; backup: $BK"; exit 1; fi
echo "DONE: Gmail migration applied and verified (backup $BK). Next (docs/run03/PRODUCTION_ROLLOUT.md): old build still serves; staged build of the RUN 03 code."
