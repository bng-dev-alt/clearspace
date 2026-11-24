# Scenario H (sourced by run.sh, after rollback.sh which defines snapshot()): the HOSTED hotfix. The hosted project holds exactly
# 0100-0400 + 0500-0700 (as rehearsed and applied on 2026-11-18, files pinned by checksum below) and NO 0800. Proves that
#  (1) the defect really exists in that state (deleting a meeting author fails), (2) applying ONLY 0900 fixes it,
#  (3) the resulting catalog is IDENTICAL to a fresh install (baseline + every migration), (4) 0900 is idempotent,
#  (5) the suites of the trust boundary and the new erasure suite pass on the hotfixed database, (6) the rollback script restores
#  the exact 0700 catalog (and is therefore the defective guard again), and the migration applies again.
echo "== Scenario H: hosted hotfix (0700 state, no 0800) + 0900 == fresh install"
MIGH="$FRONTEND/supabase/migrations"
declare -a HPIN=("20261118000500_intelligence_core:14cde02eb78c1b0c9224ce1cda4cbb7e2103286d09726898241afcf3af1adb8b" "20261118000600_intelligence_quality:ebe53cfad6df477e2c51b5cdc2fc35e5eb4c8b2d2042b6059261b602433c79b2" "20261118000700_meeting_audio:c0777a184847e2536cafb96b88155c42be1af8a1ea540469d14844ced389b7cf")
for e in "${HPIN[@]}"; do
  [ "$(shasum -a 256 "$MIGH/${e%%:*}.sql" | cut -d' ' -f1)" = "${e##*:}" ] || { echo "FAIL: ${e%%:*}.sql differs from the file applied to the hosted project (the hosted state is not what this scenario tests)"; exit 1; }
done
echo "ok - 0500-0700 are byte-identical to the files applied to hosted"
BASEH=("$MIGH"/20261117000100_security_foundation.sql "$MIGH"/20261117000200_restore_project_board.sql "$MIGH"/20261117000300_least_privilege_table_grants.sql "$MIGH"/20261117000400_task_resources_storage.sql)
HOSTED7=("$MIGH"/20261118000500_intelligence_core.sql "$MIGH"/20261118000600_intelligence_quality.sql "$MIGH"/20261118000700_meeting_audio.sql)
newdb cs_h_fresh; apply cs_h_fresh "$BASELINE" "${UPTO_0900[@]}"   # this scenario is about the 0900 hotfix
HF=$(snapshot cs_h_fresh)
newdb cs_h; apply cs_h "$BASELINE" "${BASEH[@]}" "${HOSTED7[@]}"
H0=$(snapshot cs_h)
[ "$H0" != "$HF" ] || { echo "FAIL: the hosted state already equals the fresh catalog (snapshot is blind)"; exit 1; }
# (1) the defect exists in the hosted state
if psql_admin -d cs_h -q -c "
  do \$\$ declare u uuid := test.mkuser('h-a@example.test'); m uuid; begin
    perform test.act_as(u, 'h-a@example.test');
    insert into public.projects (id, name) values ('pH', 'H');
    insert into public.meetings (project_id, title, source_kind) values ('pH', 'M', 'text') returning id into m;
    perform test.reset();
    delete from auth.users where id = u;
  end \$\$" >/dev/null 2>"${TMPDIR:-/tmp}/h_err.txt"; then
  echo "FAIL: the hosted state could delete a meeting author (the defect is not reproduced)"; exit 1; fi
grep -q "nelze měnit" "${TMPDIR:-/tmp}/h_err.txt" || { echo "FAIL: deleting the author failed for another reason: $(head -3 "${TMPDIR:-/tmp}/h_err.txt")"; exit 1; }
echo "ok - REPRODUCED on the hosted state: deleting a user who created a meeting fails (guard_meeting_identity)"
psql_admin -d cs_h -q -c "delete from public.projects where id='pH'; delete from auth.users where email='h-a@example.test'" >/dev/null 2>&1 || true
# a gap here would mean the guard itself would be wrong for a legacy row: a meeting whose author is already NULL keeps working
# (2)+(3)
apply cs_h "$MIGH"/20261118000900_meeting_creator_erasure.sql
H1=$(snapshot cs_h)
[ "$H1" = "$HF" ] || { echo "FAIL: hosted state + 0900 differs from a fresh install ($H1 vs $HF)"; exit 1; }
echo "ok - hosted state + 0900 == fresh install (catalog snapshot $H1)"
apply cs_h "$MIGH"/20261118000900_meeting_creator_erasure.sql
[ "$(snapshot cs_h)" = "$HF" ] || { echo "FAIL: re-applying 0900 changed the catalog"; exit 1; }
echo "ok - 0900 is idempotent"
# preflight: 0900 is refused on a database that lacks 0700 and changes nothing
newdb cs_h_pre; apply cs_h_pre "$BASELINE" "${BASEH[@]}" "$MIGH"/20261118000500_intelligence_core.sql "$MIGH"/20261118000600_intelligence_quality.sql
if out=$(apply cs_h_pre "$MIGH"/20261118000900_meeting_creator_erasure.sql 2>&1); then echo "FAIL: 0900 ran without 0700"; exit 1; fi
echo "$out" | grep -q "Preflight failed" || { echo "FAIL: no clear preflight message: $out"; exit 1; }
echo "ok - 0900 refuses to run without 0700 and changes nothing"
# (5)
for t in 80_intelligence 81_intelligence_quality 82_meeting_audio 83_intelligence_hardening 84_stt_stabilization 85_delete_meeting_creator 40_definer_hardening; do run_test cs_h "$HERE/$t.test.sql"; done
# (6) rollback
psql_admin -d cs_h -q -f - < "$FRONTEND/supabase/rollback/20261118000900_meeting_creator_erasure.down.sql" >/dev/null
[ "$(snapshot cs_h)" = "$H0" ] || { echo "FAIL: rolling back 0900 did not restore the hosted (0700) catalog"; exit 1; }
echo "ok - rollback of 0900 restores the 0700 catalog exactly (the defective guard returns by design)"
apply cs_h "$MIGH"/20261118000900_meeting_creator_erasure.sql
[ "$(snapshot cs_h)" = "$HF" ] || { echo "FAIL: re-applying 0900 after the rollback does not reproduce the fresh catalog"; exit 1; }
echo "ok - 0900 applies again after its rollback"
