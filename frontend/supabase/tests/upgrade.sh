# Scenario G (sourced by run.sh): UPGRADE of an installation that already applied the PRE-STABILIZATION 0500-0700 (commit 383cf20).
# Its tooling treats those versions as applied, so the repair path is: apply ONLY the forward-only 20261118000800 repair. Proves that
#  (1) the old vulnerabilities really exist in the old state (the test is not vacuous), (2) after the repair no obsolete secret-less
#  overload is left, (3) the catalog is IDENTICAL to a fresh install, (4) legacy rows are repaired, (5) the second upgrade path
#  (re-applying the edited 0500-0700) converges to the same catalog, (6) the suites that guard the trust boundary pass on the upgraded DB.
echo "== Scenario G: upgrade from the pre-stabilization state (383cf20) -> 0800 repair == fresh install"
OLDREF=383cf20
OLDP="frontend/supabase/migrations"
if ! git -C "$FRONTEND" cat-file -e "$OLDREF:$OLDP/20261118000700_meeting_audio.sql" 2>/dev/null; then
  echo "SKIP: commit $OLDREF is not available in this checkout; the upgrade scenario could not run (reported, NOT passed)"
else
OLDDIR="$(mktemp -d)"
for f in 20261118000500_intelligence_core 20261118000600_intelligence_quality 20261118000700_meeting_audio; do
  git -C "$FRONTEND" show "$OLDREF:$OLDP/$f.sql" > "$OLDDIR/$f.sql"
done
MIGG="$FRONTEND/supabase/migrations"
BASE4=("$MIGG"/20261117000100_security_foundation.sql "$MIGG"/20261117000200_restore_project_board.sql "$MIGG"/20261117000300_least_privilege_table_grants.sql "$MIGG"/20261117000400_task_resources_storage.sql)
snapg() { snapshot "$1"; }
mk_old() { newdb "$1"; apply "$1" "$BASELINE" "${BASE4[@]}" "$OLDDIR"/20261118000500_intelligence_core.sql "$OLDDIR"/20261118000600_intelligence_quality.sql "$OLDDIR"/20261118000700_meeting_audio.sql; }

# fresh reference
newdb cs_g_fresh; apply cs_g_fresh "$BASELINE" "$MIGG"/*.sql
SF=$(snapg cs_g_fresh)

# old state + legacy data (created through the OLD member-callable functions)
mk_old cs_g
SOLD=$(snapg cs_g)
[ "$SOLD" != "$SF" ] || { echo "FAIL: the old state already equals the fresh catalog (snapshot is blind)"; exit 1; }
psql_admin -d cs_g -q >/dev/null <<'SQL'
DO $$
DECLARE
  a uuid := test.mkuser('g-a@example.test'); r record; m1 uuid; m2 uuid; m3 uuid; m4 uuid; p text; n int;
  tr jsonb := '{"revision":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","char_count":20,"speakers":[],"segments":[{"id":"seg-0-0","startMs":0,"endMs":1000,"speakerId":null,"text":"Ahoj světe tady."}],"coverage":{}}';
BEGIN
  PERFORM test.act_as(a, 'g-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pG', 'Legacy');
  FOR n IN 1..4 LOOP
    INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pG', 'L' || n, 'audio') RETURNING id INTO m1;
    IF n = 1 THEN m2 := m1; ELSIF n = 2 THEN m3 := m1; ELSIF n = 3 THEN m4 := m1; END IF;
    PERFORM public.record_audio_consent(m1);
    p := 'pG/' || m1 || '/' || gen_random_uuid() || '.mp3';
    PERFORM test.reset(); INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', p, a, '{"size":500,"mimetype":"audio/mpeg"}'); PERFORM test.act_as(a, 'g-a@example.test');
    PERFORM public.attach_meeting_audio(m1, p, 500, 'audio/mpeg', 30000);
    IF n <= 3 THEN PERFORM public.stt_reserve(m1, 600000, 72000000, 360000000); END IF;   -- OLD member-callable signature, own budgets
    IF n = 2 THEN PERFORM public.stt_attach_job(m1, 'job-old-2', 'stt-async-v6'); END IF;
    IF n = 3 THEN PERFORM public.stt_attach_job(m1, 'job-old-3', 'stt-async-v6'); PERFORM public.stt_complete(m1, 'job-old-3', 'stt-async-v6', 60000, tr); END IF;
  END LOOP;
  -- (1) the old vulnerability exists: a member reserves with their OWN budgets and forges a machine transcript without any secret
  INSERT INTO public.meetings (project_id, title, source_kind) VALUES ('pG', 'Forge', 'audio') RETURNING id INTO m1;
  PERFORM public.record_audio_consent(m1);
  p := 'pG/' || m1 || '/' || gen_random_uuid() || '.mp3';
  PERFORM test.reset(); INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ('meeting-audio', p, a, '{"size":500,"mimetype":"audio/mpeg"}'); PERFORM test.act_as(a, 'g-a@example.test');
  PERFORM public.attach_meeting_audio(m1, p, 500, 'audio/mpeg', 30000);
  SELECT * INTO r FROM public.stt_reserve(m1, 1, 999999999, 999999999);
  IF r.outcome IS DISTINCT FROM 'started' THEN RAISE EXCEPTION 'old-state probe: stt_reserve without secret did not start (%)', r.outcome; END IF;
  RAISE NOTICE 'old state confirmed vulnerable: secret-less stt_reserve with member-chosen budgets -> %', r.outcome;
END $$;
SQL
echo "ok - the OLD state is exploitable (a member reserves with their own budgets without any secret)"

# (2)+(3) apply ONLY the repair
apply cs_g "$MIGG"/20261118000800_stt_stabilization_repair.sql "$MIGG"/20261118000900_meeting_creator_erasure.sql   # the repair + the later forward-only fix
SG=$(snapg cs_g)
[ "$SG" = "$SF" ] || { echo "FAIL: the upgraded catalog differs from a fresh install ($SG vs $SF)"; exit 1; }
echo "ok - old state + 0800 repair == fresh install (catalog snapshot $SG)"
# applying the repair again changes nothing
apply cs_g "$MIGG"/20261118000800_stt_stabilization_repair.sql "$MIGG"/20261118000900_meeting_creator_erasure.sql
[ "$(snapg cs_g)" = "$SF" ] || { echo "FAIL: re-applying the repair changed the catalog"; exit 1; }
echo "ok - the repair is idempotent"

# (4) legacy rows are repaired
G=$(psql_admin -d cs_g -At -c "select
  (select count(*) from public.stt_jobs where project_id='pG') || '|' ||
  (select coalesce(string_agg(state || ':' || coalesce(provider_job_id,'-') || ':' || cleanup_state, ',' order by created_at, provider_job_id), '') from public.stt_jobs where project_id='pG') || '|' ||
  (select count(*) from public.meetings where project_id='pG' and audio_path is not null and audio_delete_after is null)" | tail -1)
echo "legacy repair result: $G"
case "$G" in 4\|*"|0") ;; *) echo "FAIL: legacy rows were not repaired as expected (jobs|states|audio without deadline): $G"; exit 1;; esac
echo "$G" | grep -q "active:job-old-2:not_needed" || { echo "FAIL: in-flight legacy attempt did not get its job row"; exit 1; }
echo "$G" | grep -q "succeeded:job-old-3:pending" || { echo "FAIL: completed legacy job with pending provider cleanup was not queued"; exit 1; }
echo "ok - legacy attempts got stt_jobs rows (provider ids kept, pending cleanup queued) and every audio file has a deletion deadline"

# (6) the trust-boundary suites pass on the UPGRADED database
for t in 82_meeting_audio 83_intelligence_hardening 84_stt_stabilization; do run_test cs_g "$HERE/$t.test.sql"; done

# (5) second path: re-applying the EDITED 0500-0700 on the old state converges to the same catalog
mk_old cs_g2
apply cs_g2 "$MIGG"/20261118000500_intelligence_core.sql "$MIGG"/20261118000600_intelligence_quality.sql "$MIGG"/20261118000700_meeting_audio.sql "$MIGG"/20261118000900_meeting_creator_erasure.sql
[ "$(snapg cs_g2)" = "$(psql_admin -d cs_g_fresh -At -c "select 1" >/dev/null; snapg cs_g_fresh)" ] || { echo "FAIL: old state + edited 0500-0700 differs from a fresh install"; exit 1; }
echo "ok - old state + re-applied 0500-0700 == fresh install as well"
rm -rf "$OLDDIR"
fi
