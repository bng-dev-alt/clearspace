#!/usr/bin/env bash
# RUN 07/07B: apply the communication-hub migrations 20261130001600 + 20261201001700 (ONE transaction) to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# Only within the owner's rollout approval (docs/run07/PRODUCTION_ROLLOUT.md), BEFORE any build that switches the hub on. The deployed code
# (hub switches 0) works with and without 1600. 1600 installs NO extension, schedules nothing, registers no service principal / trust row.
#
#   CONFIRM_HUB=twjlnsxjtuntujarwner frontend/scripts/apply-hub-hosted.sh
#
# Interlocks (each stops BEFORE any hosted write): the confirmation names the project; the working tree is clean; migration and rollback
# have exactly the rehearsed checksums; hosted markers end at 1500 (1600 absent, no hub objects); the connecting role owns
# activity_logs/task_comments/cards; the helper functions 1600 needs exist. A fresh pg_dump of `public` is taken and checksummed before the
# write. ONE transaction. Afterwards (read-only): row counts unchanged; activity, comments, notifications, RUN 05 channels, links, Google rows
# and trust have the SAME content fingerprint; marker present; 12 new tables with RLS; no anonymous / client EXECUTE on dispatch functions;
# no destination / outbox row, no principal, no 'hub' trust; no extension installed. Not done here: Vercel env, deployment, Git, scheduler.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_HUB=rehearsal
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_HUB:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_HUB=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" psql -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-postgres}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U "${REHEARSAL_USER:-postgres}" -d postgres --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-hub-rehearsal-backup-$STAMP"
else
  [ "${CONFIRM_HUB:-}" = "$REF" ] || { echo "refusing: set CONFIRM_HUB=$REF (only within the approval)"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-pre-hub"
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M=$S/migrations/20261130001600_communication_hub.sql; D=$S/rollback/20261130001600_communication_hub.down.sql
M2=$S/migrations/20261201001700_hub_hardening.sql; D2=$S/rollback/20261201001700_hub_hardening.down.sql
[ "$(sha $M)" = "197b34499a50d1da12354ecb8d673435078e3adb66c2bfc7d13623f79992da2a" ] || { echo "refusing: 1600 differs from the rehearsed file"; exit 2; }
[ "$(sha $D)" = "cefcf28a6d0832626a505c051a08dc9ca3958594da986588e228167e8e1f01a7" ] || { echo "refusing: 1600 rollback differs from the rehearsed one"; exit 2; }
[ "$(sha $M2)" = "8d870e9101cec47910ce481973ced67ce8a0aff7a17295d36d5ab0f8644bc415" ] || { echo "refusing: 1700 differs from the rehearsed file"; exit 2; }
[ "$(sha $D2)" = "af5766494594653ef8d900b7fa07de2dc6c7771bac052ace60866ea8d914b442" ] || { echo "refusing: 1700 rollback differs from the rehearsed one"; exit 2; }
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
  *,20261128001400_google_calendar,20261129001500_notification_channels,) ;;
  *) echo "refusing: 1400/1500 must be the newest markers (and 1600 absent): $markers"; exit 2;;
esac
own() { echo "pg_has_role(current_user, (select relowner from pg_class where oid = 'public.$1'::regclass), 'USAGE')::text"; }
pre=$(echo "select (to_regprocedure('public.require_server_secret(text,text)') is not null)::text || ',' || (to_regprocedure('public.project_role_of(text,uuid)') is not null)::text || ',' || (to_regprocedure('public.is_project_member(text)') is not null)::text || ',' || (to_regprocedure('public.collab_is_done_column(text)') is not null)::text || ',' || (to_regprocedure('public.iso_date_or_null(text)') is not null)::text || ',' || (to_regprocedure('public.notify_due_window_start(date)') is not null)::text || ',' || (to_regprocedure('public.notify_due_window_end(date)') is not null)::text || ',' || $(own activity_logs) || ',' || $(own task_comments) || ',' || $(own cards) || ',' || (to_regclass('public.hub_destinations') is null)::text;" | ro)
[ "$pre" = "true,true,true,true,true,true,true,true,true,true,true" ] || { echo "refusing: prerequisites (helpers, owner of activity_logs/task_comments/cards, no 1600 objects): $pre"; exit 2; }
CAT0=$(ro < $S/snapshot_catalog.sql | tail -1)
C0=$(counts); F0=$(fingerprint); E0=$(echo "$EXT" | ro)
echo "ok - markers end at 1500, prerequisites present, catalog $CAT0"; echo "counts before: $C0"; echo "fingerprint before: $F0"; echo "extensions before: $E0"

echo "== 1. backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
dump > "$BK/public.dump" 2> "$BK/pg_dump.stderr" && [ -s "$BK/public.dump" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
echo "$CAT0" > "$BK/catalog-before.txt"; echo "$C0" > "$BK/counts-before.txt"; echo "$F0" > "$BK/fingerprint-before.txt"
echo "ok - backup $(du -h "$BK/public.dump" | cut -f1)"

echo "== 2. apply (ONE transaction)"
if { echo "SET client_min_messages = warning;"; cat "$M" "$M2"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied 20261130001600_communication_hub + 20261201001700_hub_hardening (one transaction)"
else echo "FAILED: the migration changed nothing (single transaction). STOP and report; do not retry blindly."; exit 1; fi

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
F1=$(fingerprint); [ "$F1" = "$F0" ] && echo "ok - activity, comments, notifications, RUN 05 channels, links, Google rows and trust unchanged (content fingerprint)" || { echo "fingerprint changed: $F1"; fail=1; }
E1=$(echo "$EXT" | ro); [ "$E1" = "$E0" ] && echo "ok - no extension installed (hub scheduler stays off)" || { echo "extensions changed: $E1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'marker=' || (select count(*) from public.clearspace_migrations where version in ('20261130001600_communication_hub', '20261201001700_hub_hardening'))
  || ' rls=' || (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'hub\_%' and c.relrowsecurity)
  || ' anon_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'hub\_%' and has_function_privilege('anon', p.oid, 'EXECUTE'))
  || ' dispatch_exec=' || (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'hub\_dispatch\_%' or p.proname in ('hub_scheduler_tick', 'hub_act_as', 'hub_require_manager')) and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  || ' triggers=' || (select count(*) from pg_trigger t where t.tgname in ('z_hub_from_activity', 'z_hub_from_comment') and not t.tgisinternal)
  || ' destinations=' || (select count(*) from public.hub_destinations)
  || ' outbox=' || (select count(*) from public.hub_outbox)
  || ' principal=' || (select count(*) from public.hub_service_principal)
  || ' hub_trust=' || (select count(*) from public.server_trust where purpose = 'hub')
  || ' inbox=' || (select count(*) from public.hub_inbox);
SQL
)
echo "$v"
[ "$v" = "marker=2 rls=12 anon_exec=0 dispatch_exec=0 triggers=2 destinations=0 outbox=0 principal=0 hub_trust=0 inbox=0" ] && echo "ok - hub state as rehearsed (empty, switched off)" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (as the owner, one transaction): $D ; backup: $BK"; exit 1; fi
echo "DONE: communication-hub migrations applied and verified (backup $BK). Next (docs/run07/PRODUCTION_ROLLOUT.md): the deployed build keeps serving; staged build of the RUN 07 code with the hub switches 0."
