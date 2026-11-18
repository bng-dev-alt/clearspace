# Scenario F (sourced by run.sh): the rollback scripts restore the EXACT catalog of the previous stage (functions, policies, triggers,
# columns, constraints, indexes, grants, buckets), refuse to destroy data, give precise reasons, and the migrations apply again.
echo "== Scenario F: rollback of 0700, 0600 and 0500 restores the previous catalog exactly"
ROLL="$FRONTEND/supabase/rollback"; MIG="$FRONTEND/supabase/migrations"
snapshot() { # $1 = db -> the md5 line of supabase/snapshot_catalog.sql
  psql_admin -d "$1" -At -f - < "$HERE/../snapshot_catalog.sql" | tail -1
}
newdb cs_f
apply cs_f "$BASELINE"
apply cs_f "$MIG"/20261117000100_security_foundation.sql "$MIG"/20261117000200_restore_project_board.sql "$MIG"/20261117000300_least_privilege_table_grants.sql "$MIG"/20261117000400_task_resources_storage.sql
S400=$(snapshot cs_f)
apply cs_f "$MIG"/20261118000500_intelligence_core.sql
S500=$(snapshot cs_f)
apply cs_f "$MIG"/20261118000600_intelligence_quality.sql
S600=$(snapshot cs_f)
apply cs_f "$MIG"/20261118000700_meeting_audio.sql
S700=$(snapshot cs_f)
echo "snapshots: 0400=${S400} 0500=${S500} 0600=${S600} 0700=${S700}"
[ "$S400" != "$S500" ] && [ "$S500" != "$S600" ] && [ "$S600" != "$S700" ] || { echo "FAIL: a migration changed nothing in the catalog snapshot (the snapshot is blind)"; exit 1; }

echo "--- order independence: re-applying the files in REVERSE and mixed order leaves the identical catalog"
apply cs_f "$MIG"/20261118000700_meeting_audio.sql "$MIG"/20261118000600_intelligence_quality.sql "$MIG"/20261118000500_intelligence_core.sql
[ "$(snapshot cs_f)" = "$S700" ] || { echo "FAIL: re-running the migrations out of order changed the catalog"; exit 1; }
apply cs_f "$MIG"/20261118000600_intelligence_quality.sql "$MIG"/20261118000500_intelligence_core.sql "$MIG"/20261118000700_meeting_audio.sql
[ "$(snapshot cs_f)" = "$S700" ] || { echo "FAIL: re-running the migrations in a mixed order changed the catalog"; exit 1; }
echo "ok - any order of re-application ends in the same catalog (no migration redefines another's function, grants survive)"

echo "--- rollback is REFUSED, with the right reason, while data would be lost"
psql_admin -d cs_f -q >/dev/null 2>&1 <<'SQL' || true
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'f@example.test') on conflict do nothing;
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'f@example.test') on conflict do nothing;
insert into public.projects (id, name) values ('pF', 'F') on conflict do nothing;
insert into public.columns (id, project_id, name, position, role, role_source) values ('pF-c', 'pF', 'X', 0, 'done', 'user') on conflict do nothing;
insert into public.meetings (id, project_id, title, source_kind, consent_at) values ('00000000-0000-4000-8000-0000000000f2', 'pF', 'A', 'audio', now()) on conflict do nothing;
SQL
refuse() { # $1 = db, $2 = down script, $3 = expected reason fragment
  local out; out=$(psql_admin -d "$1" -f - < "$2" 2>&1) && { echo "FAIL: $(basename "$2") ran although data exists"; exit 1; }
  echo "$out" | grep -q "$3" || { echo "FAIL: $(basename "$2") refused for the wrong reason: $(echo "$out" | grep -m1 'Rollback refused\|ERROR' )"; exit 1; }
  echo "ok - $(basename "$2") refused: $3"
}
refuse cs_f "$ROLL/20261118000600_intelligence_quality.down.sql" "roll back 20261118000700_meeting_audio first"
refuse cs_f "$ROLL/20261118000500_intelligence_core.down.sql" "roll back 20261118000700 and 20261118000600 first"
refuse cs_f "$ROLL/20261118000700_meeting_audio.down.sql" "meetings with consent/audio/STT data exist"
psql_admin -d cs_f -q -c "delete from public.meetings where id = '00000000-0000-4000-8000-0000000000f2'" >/dev/null
psql_admin -d cs_f -q -c "insert into public.stt_jobs (project_id, attempt, client_reference, state, provider_job_id, cleanup_state) values ('pF', 1, 'f:1', 'failed', 'job-f', 'pending')" >/dev/null
refuse cs_f "$ROLL/20261118000700_meeting_audio.down.sql" "stt_jobs rows exist"
psql_admin -d cs_f -q -c "delete from public.stt_jobs" >/dev/null
psql_admin -d cs_f -q -c "insert into public.meeting_audio_orphans (path, project_id) values ('pF/x/y.mp3', 'pF')" >/dev/null
refuse cs_f "$ROLL/20261118000700_meeting_audio.down.sql" "orphaned audio is still queued"
psql_admin -d cs_f -q -c "delete from public.meeting_audio_orphans" >/dev/null
psql_admin -d cs_f -q -c "insert into public.ai_requests (user_id, feature, status, provider, audio_ms) values ('00000000-0000-4000-8000-0000000000f1', 'meeting-transcribe', 'failed', 'soniox', 1)" >/dev/null
refuse cs_f "$ROLL/20261118000700_meeting_audio.down.sql" "ledger history of audio usage exists"
psql_admin -d cs_f -q -c "delete from public.ai_requests where feature = 'meeting-transcribe'" >/dev/null

echo "--- rollback of 0700 restores the 0600 catalog exactly"
psql_admin -d cs_f -f - < "$ROLL/20261118000700_meeting_audio.down.sql" >/dev/null
[ "$(snapshot cs_f)" = "$S600" ] || { echo "FAIL: after rolling back 0700 the catalog differs from the 0600 stage"; exit 1; }
echo "ok - catalog after rollback of 0700 == catalog at 0600"
refuse cs_f "$ROLL/20261118000600_intelligence_quality.down.sql" "columns carry roles chosen by a person"
psql_admin -d cs_f -q -c "update public.columns set role = null, role_source = 'backfill'" >/dev/null
psql_admin -d cs_f -q -c "delete from public.meetings" >/dev/null
psql_admin -d cs_f -f - < "$ROLL/20261118000600_intelligence_quality.down.sql" >/dev/null
[ "$(snapshot cs_f)" = "$S500" ] || { echo "FAIL: after rolling back 0600 the catalog differs from the 0500 stage"; exit 1; }
echo "ok - catalog after rollback of 0600 == catalog at 0500"
psql_admin -d cs_f -f - < "$ROLL/20261118000500_intelligence_core.down.sql" >/dev/null
[ "$(snapshot cs_f)" = "$S400" ] || { echo "FAIL: after rolling back 0500 the catalog differs from the 0400 stage"; exit 1; }
echo "ok - catalog after rollback of 0500 == catalog at 0400 (the state of the hosted project today)"

echo "--- the migrations apply again on the rolled-back database and their suites pass"
apply cs_f "$MIG"/20261118000500_intelligence_core.sql "$MIG"/20261118000600_intelligence_quality.sql "$MIG"/20261118000700_meeting_audio.sql
[ "$(snapshot cs_f)" = "$S700" ] || { echo "FAIL: forward re-application does not reproduce the 0700 catalog"; exit 1; }
run_test cs_f "$HERE/80_intelligence.test.sql"
run_test cs_f "$HERE/81_intelligence_quality.test.sql"
run_test cs_f "$HERE/82_meeting_audio.test.sql"
run_test cs_f "$HERE/83_intelligence_hardening.test.sql"
