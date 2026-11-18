# Scenario F (sourced by run.sh): the 0600/0700 rollback scripts work, refuse to destroy data, and leave a database that
# passes the 0500 suite and accepts the migrations again.
echo "== Scenario F: rollback of 20261118000700 and 20261118000600"
newdb cs_f
apply cs_f "$BASELINE"
apply cs_f "${MIGRATIONS[@]}"
ROLL="$FRONTEND/supabase/rollback"
echo "--- rollback is REFUSED while audio/role data exists"
psql_admin -d cs_f -q >/dev/null <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'f@example.test') on conflict do nothing;
SQL
psql_admin -d cs_f -q >/dev/null 2>&1 <<'SQL' || true
insert into public.profiles (id, email) values ('00000000-0000-4000-8000-0000000000f1', 'f@example.test') on conflict do nothing;
insert into public.projects (id, name) values ('pF', 'F') on conflict do nothing;
insert into public.columns (id, project_id, name, position, role) values ('pF-c', 'pF', 'X', 0, 'done') on conflict do nothing;
insert into public.meetings (id, project_id, title, source_kind, consent_at) values ('00000000-0000-4000-8000-0000000000f2', 'pF', 'A', 'audio', now()) on conflict do nothing;
SQL
if psql_admin -d cs_f -f - < "$ROLL/20261118000700_meeting_audio.down.sql" >/dev/null 2>&1; then echo "FAIL: 0700 rollback ran over consent data"; exit 1; fi
echo "ok - 0700 rollback refused while consent/audio data exists"
psql_admin -d cs_f -q -c "delete from public.meetings where id = '00000000-0000-4000-8000-0000000000f2'" >/dev/null
psql_admin -d cs_f -f - < "$ROLL/20261118000700_meeting_audio.down.sql" >/dev/null
echo "ok - 0700 rolled back (no data)"
if psql_admin -d cs_f -f - < "$ROLL/20261118000600_intelligence_quality.down.sql" >/dev/null 2>&1; then echo "FAIL: 0600 rollback ran over column roles"; exit 1; fi
echo "ok - 0600 rollback refused while columns carry roles"
psql_admin -d cs_f -q -c "update public.columns set role = null" >/dev/null
psql_admin -d cs_f -f - < "$ROLL/20261118000600_intelligence_quality.down.sql" >/dev/null
echo "ok - 0600 rolled back"
left=$(psql_admin -d cs_f -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('stt_reserve','stt_complete','record_audio_consent','attach_meeting_audio','project_intelligence_stamp','enforce_meeting_quota','intelligence_limits','lock_meeting_for_member')")
cols=$(psql_admin -d cs_f -At -c "select count(*) from information_schema.columns where table_schema='public' and ((table_name='meetings' and column_name in ('consent_at','audio_path','stt_state')) or (table_name='columns' and column_name='role') or (table_name='ai_requests' and column_name in ('audio_ms','provider')) or (table_name='meeting_transcripts' and column_name='parent_revision'))")
bucket=$(psql_admin -d cs_f -At -c "select count(*) from storage.buckets where id='meeting-audio'")
markers=$(psql_admin -d cs_f -At -c "select count(*) from public.clearspace_migrations where version in ('20261118000600_intelligence_quality','20261118000700_meeting_audio')")
[ "$left" = 0 ] && [ "$cols" = 0 ] && [ "$bucket" = 0 ] && [ "$markers" = 0 ] || { echo "FAIL: rollback left objects behind (functions=$left columns=$cols bucket=$bucket markers=$markers)"; exit 1; }
echo "ok - no function, column, bucket or marker of 0600/0700 remains"
run_test cs_f "$HERE/80_intelligence.test.sql"
echo "--- the migrations apply again on the rolled-back database and their suites pass"
apply cs_f "$FRONTEND/supabase/migrations/20261118000600_intelligence_quality.sql" "$FRONTEND/supabase/migrations/20261118000700_meeting_audio.sql"
run_test cs_f "$HERE/81_intelligence_quality.test.sql"
run_test cs_f "$HERE/82_meeting_audio.test.sql"
