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

echo "--- collaboration rollback: refused while it would widen access; otherwise restores the 0900 catalog exactly"
DOWN="$FRONTEND/supabase/rollback/20261124001000_collaboration.down.sql"
newdb cs_k0; apply cs_k0 "$BASELINE" "${UPTO_0900[@]}"
S0900=$(psql_admin -d cs_k0 -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
newdb cs_kr; apply cs_kr "$BASELINE" "${MIGRATIONS[@]}"
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
