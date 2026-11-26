#!/usr/bin/env bash
# RUN 05: apply the notification migration 20261129001500 to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# Applied BEFORE any build of the RUN 05 code goes live, with Slack + Telegram switched OFF. The RUN 04 code keeps working on 1500
# (rehearse-notify-prod.sh + the compatibility gate prove it). 1500 installs NO extension and schedules nothing.
# RUN ONLY WITHIN THE OWNER'S APPROVAL (docs/run05/RUN_PROMPT.md §0, docs/run05/PRODUCTION_ROLLOUT.md).
#
#   CONFIRM_NOTIFY=twjlnsxjtuntujarwner frontend/scripts/apply-notify-hosted.sh
#
# Interlocks (each stops BEFORE any hosted write): the confirmation names the project; the working tree is clean; migration and rollback
# have exactly the rehearsed checksums; hosted markers end at 1400 (1500 absent, no notify objects); the connecting role owns
# notifications/activity_logs/cards; the helper functions 1500 needs exist. A fresh pg_dump of `public` is taken and checksummed before the
# write. ONE transaction. Afterwards (read-only): row counts unchanged; notifications, activity, links, Google rows and trust have the
# SAME content fingerprint; marker present; new tables have RLS and no client grants; no client can EXECUTE the dispatcher; no channel /
# delivery exists; no extension was installed. Not done here: Vercel env, deployment, Git, the scheduler.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_NOTIFY=rehearsal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_NOTIFY:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_NOTIFY=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" psql -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-notify-rehearsal-backup-$STAMP"
else
  [ "${CONFIRM_NOTIFY:-}" = "$REF" ] || { echo "refusing: set CONFIRM_NOTIFY=$REF (only within the approval)"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-pre-notify"
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M=$S/migrations/20261129001500_notification_channels.sql; D=$S/rollback/20261129001500_notification_channels.down.sql
[ "$(sha $M)" = "${EXPECT_SHA_1500:-__SHA_1500__}" ] || { echo "refusing: 1500 differs from the rehearsed file"; exit 2; }
[ "$(sha $D)" = "${EXPECT_SHA_1500_DOWN:-__SHA_1500_DOWN__}" ] || { echo "refusing: 1500 rollback differs from the rehearsed one"; exit 2; }
ro() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | pg -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
counts() { echo "select 'projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' assignees='||(select count(*) from public.card_assignees)||' members='||(select count(*) from public.project_members)||' comments='||(select count(*) from public.task_comments)||' events='||(select count(*) from public.activity_logs)||' notifications='||(select count(*) from public.notifications)||' profiles='||(select count(*) from public.profiles)||' auth.users='||(select count(*) from auth.users)||' links='||(select count(*) from public.external_resource_links)||' connections='||(select count(*) from public.google_connections)||' audit='||(select count(*) from public.integration_audit)||' trust='||(select count(*) from public.server_trust)||' gmail_sources='||(select count(*) from public.gmail_link_sources)||' calendar_sources='||(select count(*) from public.calendar_link_sources);" | ro; }
FPCOLS=$(echo "select string_agg(table_name || ':' || cols, ' ') from (select table_name, string_agg(column_name, ',' order by ordinal_position) cols from information_schema.columns where table_schema = 'public' and table_name in ('notifications', 'activity_logs', 'card_assignees', 'external_resource_links', 'google_connections', 'integration_audit', 'server_trust', 'gmail_link_sources', 'calendar_link_sources') group by table_name) t;" | ro)
fingerprint() {
  local q="select 'fp'" t c
  for tc in $FPCOLS; do t=${tc%%:*}; c=${tc#*:}; q="$q || ' $t=' || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from (select $c from public.$t) x), 'empty')"; done
  echo "$q;" | ro
}
EXT="select string_agg(extname, ',' order by extname) from pg_extension;"

echo "== 0. hosted state before (read-only)"
markers=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | ro)
case ",$markers," in
  *,20261127001300_gmail,20261128001400_google_calendar,) ;;
  *) echo "refusing: 1300/1400 must be the newest markers (and 1500 absent): $markers"; exit 2;;
esac
own() { echo "pg_has_role(current_user, (select relowner from pg_class where oid = 'public.$1'::regclass), 'USAGE')::text"; }
pre=$(echo "select (to_regprocedure('public.require_server_secret(text,text)') is not null)::text || ',' || (to_regprocedure('public.google_require_user()') is not null)::text || ',' || (to_regprocedure('public.project_role_of(text,uuid)') is not null)::text || ',' || (to_regprocedure('public.collab_is_done_column(text)') is not null)::text || ',' || (to_regprocedure('public.iso_date_or_null(text)') is not null)::text || ',' || $(own notifications) || ',' || $(own activity_logs) || ',' || $(own cards) || ',' || (to_regclass('public.notification_channels') is null)::text;" | ro)
[ "$pre" = "true,true,true,true,true,true,true,true,true" ] || { echo "refusing: prerequisites (helpers, owner of notifications/activity_logs/cards, no 1500 objects): $pre"; exit 2; }
CAT0=$(ro < $S/snapshot_catalog.sql | tail -1)
C0=$(counts); F0=$(fingerprint); E0=$(echo "$EXT" | ro)
echo "ok - markers end at 1400, prerequisites present, catalog $CAT0"; echo "counts before: $C0"; echo "fingerprint before: $F0"; echo "extensions before: $E0"

echo "== 1. backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
dump > "$BK/public.dump" 2> "$BK/pg_dump.stderr" && [ -s "$BK/public.dump" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
echo "$CAT0" > "$BK/catalog-before.txt"; echo "$C0" > "$BK/counts-before.txt"; echo "$F0" > "$BK/fingerprint-before.txt"
echo "ok - backup $(du -h "$BK/public.dump" | cut -f1)"

echo "== 2. apply (ONE transaction)"
if { echo "SET client_min_messages = warning;"; cat "$M"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied 20261129001500_notification_channels"
else echo "FAILED: the migration changed nothing (single transaction). STOP and report; do not retry blindly."; exit 1; fi

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
F1=$(fingerprint); [ "$F1" = "$F0" ] && echo "ok - notifications, activity, assignments, links, Google rows and trust unchanged (content fingerprint)" || { echo "fingerprint changed: $F1"; fail=1; }
E1=$(echo "$EXT" | ro); [ "$E1" = "$E0" ] && echo "ok - no extension installed (scheduler stays off)" || { echo "extensions changed: $E1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'marker=' || (select count(*) from public.clearspace_migrations where version = '20261129001500_notification_channels')
  || ' rls=' || (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('notification_channels', 'notification_preferences', 'notification_deliveries', 'notification_dispatch_runs') and c.relrowsecurity)
  || ' client_grants=' || (select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name like 'notification\_%' and table_name <> 'notifications' and grantee in ('anon', 'authenticated'))
  || ' anon_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'notify\_%' and has_function_privilege('anon', p.oid, 'EXECUTE'))
  || ' dispatch_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'notify\_dispatch\_%' or p.proname = 'notify_scheduler_tick') and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  || ' triggers=' || (select count(*) from pg_trigger t where t.tgname in ('z_notify_from_notification', 'z_notify_from_activity') and not t.tgisinternal)
  || ' channels=' || (select count(*) from public.notification_channels)
  || ' deliveries=' || (select count(*) from public.notification_deliveries);
SQL
)
echo "$v"
[ "$v" = "marker=1 rls=4 client_grants=0 anon_exec=0 dispatch_exec=0 triggers=2 channels=0 deliveries=0" ] && echo "ok - notification state as rehearsed" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (as the owner, one transaction): $D ; backup: $BK"; exit 1; fi
echo "DONE: notification migration applied and verified (backup $BK). Next (docs/run05/PRODUCTION_ROLLOUT.md): old build still serves; staged build of the RUN 05 code with both switches 0."
