#!/usr/bin/env bash
# RUN 10: apply migration 20261202001800_meeting_intelligence_live (ONE transaction) to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# Additive: new columns on meetings, 4 new tables (RLS), stt_live_* RPCs (server secret first), Google service RPCs accept the
# 'meetings' scope. The deployed code (RUN 09) works with and without 1800 (verified on the replica). Nothing is switched on here.
#
#   CONFIRM_MEETINGS=twjlnsxjtuntujarwner frontend/scripts/apply-meetings-hosted.sh
#
# Interlocks (each BEFORE any hosted write): confirmation names the project; clean working tree; migration + rollback have the rehearsed
# checksums (MIG_SHA / DOWN_SHA, printed by the rehearsal); markers end at 1700 and 1800 objects are absent. Backup: pg_dump -Fc of
# `public`, ENCRYPTED (AES-256, random key in the login Keychain), SHA256SUMS, and a verified restore into a throwaway container.
# After (read-only): counts + content fingerprints unchanged, marker present, 4 new tables with RLS, no anon EXECUTE on stt_live_*,
# no live rows, no extension installed. Not done here: Vercel env, deployment, Git.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_MEETINGS=rehearsal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_MEETINGS:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_MEETINGS=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" psql -h localhost -U "${REHEARSAL_USER:-postgres}" -d "${REHEARSAL_DB:-postgres}" -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U "${REHEARSAL_USER:-postgres}" -d "${REHEARSAL_DB:-postgres}" --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-run10-rehearsal-backup-$STAMP"
else
  [ "${CONFIRM_MEETINGS:-}" = "$REF" ] || { echo "refusing: set CONFIRM_MEETINGS=$REF"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-run10-pre-meetings-encrypted"
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M=$S/migrations/20261202001800_meeting_intelligence_live.sql; D=$S/rollback/20261202001800_meeting_intelligence_live.down.sql
[ -z "${MIG_SHA:-}" ] || [ "$(sha $M)" = "$MIG_SHA" ] || { echo "refusing: 1800 differs from the rehearsed file"; exit 2; }
[ -z "${DOWN_SHA:-}" ] || [ "$(sha $D)" = "$DOWN_SHA" ] || { echo "refusing: 1800 rollback differs from the rehearsed one"; exit 2; }
[ -n "${REHEARSAL_CONTAINER:-}" ] || { [ -n "${MIG_SHA:-}" ] && [ -n "${DOWN_SHA:-}" ]; } || { echo "refusing: production needs MIG_SHA and DOWN_SHA from the rehearsal"; exit 2; }
echo "migration sha256 $(sha $M)"; echo "rollback  sha256 $(sha $D)"
ro() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | pg -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
counts() { echo "select 'projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' assignees='||(select count(*) from public.card_assignees)||' members='||(select count(*) from public.project_members)||' comments='||(select count(*) from public.task_comments)||' events='||(select count(*) from public.activity_logs)||' notifications='||(select count(*) from public.notifications)||' profiles='||(select count(*) from public.profiles)||' auth.users='||(select count(*) from auth.users)||' links='||(select count(*) from public.external_resource_links)||' connections='||(select count(*) from public.google_connections)||' audit='||(select count(*) from public.integration_audit)||' trust='||(select count(*) from public.server_trust)||' gmail_sources='||(select count(*) from public.gmail_link_sources)||' calendar_sources='||(select count(*) from public.calendar_link_sources)||' notify_channels='||(select count(*) from public.notification_channels)||' notify_deliveries='||(select count(*) from public.notification_deliveries);" | ro; }
FPCOLS=$(echo "select string_agg(table_name || ':' || cols, ' ') from (select table_name, string_agg(column_name, ',' order by ordinal_position) cols from information_schema.columns where table_schema = 'public' and table_name in ('notifications', 'activity_logs', 'card_assignees', 'task_comments', 'external_resource_links', 'google_connections', 'integration_audit', 'server_trust', 'gmail_link_sources', 'calendar_link_sources', 'notification_channels', 'notification_preferences', 'notification_deliveries') group by table_name) t;" | ro)
fingerprint() {
  local q="select 'fp'" t c
  for tc in $FPCOLS; do t=${tc%%:*}; c=${tc#*:}; q="$q || ' $t=' || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from (select $c from public.$t) x), 'empty')"; done
  echo "$q;" | ro
}
EXT="select string_agg(extname, ',' order by extname) from pg_extension;"

echo "== 0. hosted state before (read-only)"
markers=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | ro)
case ",$markers," in
  *,20261201001700_hub_hardening,) ;;
  *) echo "refusing: 1700 must be the newest marker (and 1800 absent): $markers"; exit 2;;
esac
pre=$(echo "select (to_regclass('public.meeting_live_segments') is null)::text || ',' || (to_regprocedure('public.lock_meeting_for_member(uuid)') is not null)::text || ',' || (to_regprocedure('public.require_server_secret(text,text)') is not null)::text || ',' || (to_regclass('public.external_resource_links') is not null)::text;" | ro)
[ "$pre" = "true,true,true,true" ] || { echo "refusing: prerequisites / no 1800 objects: $pre"; exit 2; }
CAT0=$(ro < $S/snapshot_catalog.sql | tail -1)
C0=$(counts); F0=$(fingerprint); E0=$(echo "$EXT" | ro)
M0=$(echo "select 'meetings='||(select count(*) from public.meetings)||' transcripts='||(select count(*) from public.meeting_transcripts)||' items='||(select count(*) from public.intelligence_items)||' stt_ledger='||(select count(*) from public.ai_requests where feature='meeting-transcribe');" | ro)
echo "ok - markers end at 1700, catalog $CAT0"; echo "counts before: $C0"; echo "meetings before: $M0"

echo "== 1. encrypted backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
KEYNAME="g2-backup-${STAMP%%-*}-v1-run10-pre-meetings"
KEY=$(security find-generic-password -s "$KEYNAME" -a backup -w 2>/dev/null || true)
if [ -z "$KEY" ]; then KEY=$(openssl rand -hex 32); printf 'add-generic-password -U -s "%s" -a backup -w "%s"\n' "$KEYNAME" "$KEY" | security -i >/dev/null 2>&1; fi
[ "$(security find-generic-password -s "$KEYNAME" -a backup -w 2>/dev/null)" = "$KEY" ] || { echo "refusing: backup key not stored in the Keychain"; exit 2; }
dump 2> "$BK/pg_dump.stderr" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass fd:3 3<<<"$KEY" > "$BK/public.dump.enc"
[ -s "$BK/public.dump.enc" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump.enc > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
# verified restore: decrypt and restore into a throwaway Postgres, compare the table count
RC=cs-run10-restore-$$; docker run -d --name $RC -e POSTGRES_PASSWORD=restore "$IMG" >/dev/null
for _ in $(seq 1 40); do docker exec $RC pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 2; done; sleep 2
openssl enc -d -aes-256-cbc -pbkdf2 -pass fd:3 -in "$BK/public.dump.enc" 3<<<"$KEY" | docker exec -i -e PGPASSWORD=restore $RC pg_restore -h localhost -U supabase_admin -d postgres --schema=public --no-owner --no-privileges 2> "$BK/restore.stderr"
RT=$(docker exec -e PGPASSWORD=restore $RC psql -h localhost -U supabase_admin -d postgres -At -c "select count(*) from pg_tables where schemaname='public'")
docker rm -f $RC >/dev/null 2>&1
ST=$(echo "select count(*) from pg_tables where schemaname='public';" | ro)
[ "$RT" = "$ST" ] && [ "$RT" -gt 20 ] || { echo "refusing: restore check failed (restored tables $RT, source $ST; see $BK/restore.stderr)"; exit 2; }
echo "$CAT0" > "$BK/catalog-before.txt"; echo "$C0" > "$BK/counts-before.txt"; echo "$F0" > "$BK/fingerprint-before.txt"; echo "$M0" > "$BK/meetings-before.txt"
echo "ok - encrypted backup $(du -h "$BK/public.dump.enc" | cut -f1), restore verified ($RT tables), key in Keychain: $KEYNAME"

echo "== 2. apply (ONE transaction)"
if { echo "SET client_min_messages = warning;"; cat "$M"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied 20261202001800_meeting_intelligence_live"
else echo "FAILED: the migration changed nothing (single transaction). STOP and report; do not retry blindly."; exit 1; fi

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
F1=$(fingerprint); [ "$F1" = "$F0" ] && echo "ok - content fingerprints unchanged" || { echo "fingerprint changed: $F1"; fail=1; }
E1=$(echo "$EXT" | ro); [ "$E1" = "$E0" ] && echo "ok - no extension installed" || { echo "extensions changed: $E1"; fail=1; }
M1=$(echo "select 'meetings='||(select count(*) from public.meetings)||' transcripts='||(select count(*) from public.meeting_transcripts)||' items='||(select count(*) from public.intelligence_items)||' stt_ledger='||(select count(*) from public.ai_requests where feature='meeting-transcribe');" | ro)
[ "$M1" = "$M0" ] && echo "ok - meetings, transcripts, items, STT ledger unchanged" || { echo "meeting data changed: $M1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'marker=' || (select count(*) from public.clearspace_migrations where version = '20261202001800_meeting_intelligence_live')
  || ' rls=' || (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname in ('meeting_resource_links','meeting_attendees','meeting_live_segments','meeting_live_chunks') and c.relrowsecurity)
  || ' anon_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'stt\_live\_%' or p.proname like 'meeting\_live\_%') and has_function_privilege('anon', p.oid, 'EXECUTE'))
  || ' internal_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('meeting_live_settle','meeting_live_reap','meeting_is_organizer') and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  || ' live_rows=' || ((select count(*) from public.meeting_live_segments) + (select count(*) from public.meeting_live_chunks))
  || ' meetings_scope=' || (select (prosrc like '%calendar.events.owned''%')::text from pg_proc where proname = 'google_service_remove' and pronamespace = 'public'::regnamespace);
SQL
)
echo "$v"
[ "$v" = "marker=1 rls=4 anon_exec=0 internal_exec=0 live_rows=0 meetings_scope=true" ] && echo "ok - 1800 state as rehearsed (empty, nothing switched on)" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (one transaction): $D ; backup: $BK"; exit 1; fi
echo "DONE: 1800 applied and verified (backup $BK). The deployed RUN 09 build keeps serving; next: staged build of RUN 10 with every new switch OFF."
