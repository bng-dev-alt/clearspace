# Scenario K (sourced by run.sh): collaboration suite in AUTOCOMMIT mode on a fresh database.
# Each statement/DO block commits like a PostgREST request, so deferred event triggers really fire.
echo "== Scenario K: collaboration (roles, viewer guard, events, comments, notifications, invitations) -- committed transactions"
newdb cs_k
apply cs_k "$BASELINE" "${MIGRATIONS[@]}"
out="$(mktemp)"
if psql_admin -d cs_k -f - < "$HERE/collab/90_collaboration.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/90_collaboration.sql"; exit 1
fi

out="$(mktemp)"
newdb cs_k2
apply cs_k2 "$BASELINE" "${MIGRATIONS[@]}"
if psql_admin -d cs_k2 -f - < "$HERE/collab/91_hardening.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/91_hardening.sql"; exit 1
fi

echo "--- collaboration rollback: refused while it would widen access; otherwise restores the 0900 catalog exactly"
DOWN="$FRONTEND/supabase/rollback/20261124001000_collaboration.down.sql"
newdb cs_k0; apply cs_k0 "$BASELINE" "${UPTO_0900[@]}"
S0900=$(psql_admin -d cs_k0 -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
UPTO_1000=(); for f in "${MIGRATIONS[@]}"; do [[ "$(basename "$f")" > "20261124001000~" ]] || UPTO_1000+=("$f"); done
newdb cs_kr; apply cs_kr "$BASELINE" "${UPTO_1000[@]}"
psql_admin -d cs_kr -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := test.mkuser('r-a@example.test'); BEGIN
  INSERT INTO public.projects (id, name, user_id) VALUES ('pR', 'R', a);
  INSERT INTO public.workspace_members (id, owner_id, full_name, initials) VALUES ('m-r', a, 'R', 'R');
  INSERT INTO public.project_members (project_id, member_id, project_role) VALUES ('pR', 'm-r', 'viewer');
END $$;
SQL
if out=$(psql_admin -d cs_kr --single-transaction -f - < "$DOWN" 2>&1); then echo "FAIL: rollback ran although a viewer exists"; exit 1; fi
echo "$out" | grep -q "a viewer would otherwise become an editor" || { echo "FAIL: wrong refusal: $out"; exit 1; }
[ "$(psql_admin -d cs_kr -At -c "select to_regprocedure('public.project_role(text)') is not null")" = "t" ] || { echo "FAIL: refused rollback changed the database"; exit 1; }
echo "ok - rollback refused while a viewer exists, nothing changed"
psql_admin -d cs_kr -q -c "update public.project_members set project_role = 'member' where member_id = 'm-r'" >/dev/null
psql_admin -d cs_kr --single-transaction -f - < "$DOWN" >/dev/null
SR=$(psql_admin -d cs_kr -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR" = "$S0900" ] || { echo "FAIL: catalog after rollback ($SR) differs from 0900 ($S0900)"; exit 1; }
echo "ok - catalog after rollback == catalog at 0900 ($SR)"
apply cs_kr "$FRONTEND/supabase/migrations/20261124001000_collaboration.sql"
[ "$(psql_admin -d cs_kr -At -c "select count(*) from public.clearspace_migrations where version = '20261124001000_collaboration'")" = "1" ] || { echo "FAIL: re-apply after rollback"; exit 1; }
echo "ok - 20261124001000 applies again after its rollback"

echo "--- hardening rollback (1100): refused while edit history exists; otherwise restores the 1000 catalog exactly"
DOWN2="$FRONTEND/supabase/rollback/20261125001100_collab_hardening.down.sql"
newdb cs_kh0; apply cs_kh0 "$BASELINE" "${UPTO_1000[@]}"
S1000=$(psql_admin -d cs_kh0 -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
newdb cs_kh; apply cs_kh "$BASELINE" "${MIGRATIONS[@]}"
psql_admin -d cs_kh -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := test.mkuser('hr-a@example.test'); BEGIN
  PERFORM test.act_as(a, 'hr-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pHR', 'R');
  INSERT INTO public.columns (id, project_id, name, position) VALUES ('pHR-c', 'pHR', 'C', 0);
  INSERT INTO public.cards (id, column_id, title) VALUES ('pHR-k', 'pHR-c', 'K');
END $$;
DO $$ BEGIN PERFORM test.act_as((select id from auth.users where email = 'hr-a@example.test'), 'hr-a@example.test');
  INSERT INTO public.task_comments (id, card_id, author_name, content) VALUES ('pHR-m', 'pHR-k', 'x', 'v1'); END $$;
DO $$ BEGIN PERFORM test.act_as((select id from auth.users where email = 'hr-a@example.test'), 'hr-a@example.test');
  UPDATE public.task_comments SET content = 'v2' WHERE id = 'pHR-m'; END $$;
SQL
if out=$(psql_admin -d cs_kh --single-transaction -f - < "$DOWN2" 2>&1); then echo "FAIL: 1100 rollback ran although edit history exists"; exit 1; fi
echo "$out" | grep -q "comment edit-history rows would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
echo "ok - 1100 rollback refused while comment edit history exists, nothing changed"
{ echo "SET clearspace.rollback_allow_data_loss = 'on';"; cat "$DOWN2"; } | psql_admin -d cs_kh --single-transaction -f - >/dev/null
SR2=$(psql_admin -d cs_kh -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR2" = "$S1000" ] || { echo "FAIL: catalog after 1100 rollback ($SR2) differs from 1000 ($S1000)"; exit 1; }
echo "ok - catalog after 1100 rollback == catalog at 1000 ($SR2)"
apply cs_kh "$FRONTEND/supabase/migrations/20261125001100_collab_hardening.sql"
[ "$(psql_admin -d cs_kh -At -c "select count(*) from public.clearspace_migrations where version = '20261125001100_collab_hardening'")" = "1" ] || { echo "FAIL: re-apply 1100 after rollback"; exit 1; }
echo "ok - 20261125001100 applies again after its rollback"
