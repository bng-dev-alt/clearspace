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
UPTO_1100=(); for f in "${MIGRATIONS[@]}"; do [[ "$(basename "$f")" > "20261125001100~" ]] || UPTO_1100+=("$f"); done
newdb cs_kh; apply cs_kh "$BASELINE" "${UPTO_1100[@]}"
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

# ---------------------------------------------------------------- RUN 02: Google connections + Drive links
echo "== Scenario K3: Google Drive (credentials isolation, OAuth state, links, roles, events) -- committed transactions"
newdb cs_k3
apply cs_k3 "$BASELINE" "${MIGRATIONS[@]}"
out="$(mktemp)"
if psql_admin -d cs_k3 -f - < "$HERE/collab/92_google_drive.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/92_google_drive.sql"; exit 1
fi

echo "--- Drive rollback (1200): refused while links or connections exist; otherwise restores the 1100 catalog exactly"
DOWN3="$FRONTEND/supabase/rollback/20261126001200_google_drive.down.sql"
newdb cs_kd0; apply cs_kd0 "$BASELINE" "${UPTO_1100[@]}"
S1100=$(psql_admin -d cs_kd0 -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
# RUN 03: the 1200 rollback is tested on the 1200 catalog (1300 must be rolled back first; it has its own scenario below)
UPTO_1200=(); for f in "${MIGRATIONS[@]}"; do [[ "$(basename "$f")" > "20261126001200~" ]] || UPTO_1200+=("$f"); done
newdb cs_kd; apply cs_kd "$BASELINE" "${UPTO_1200[@]}"
psql_admin -d cs_kd -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := test.mkuser('dr-a@example.test'); BEGIN
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  PERFORM test.act_as(a, 'dr-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pDR', 'R');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pDR', 'member-owner-' || a::text);
  PERFORM public.drive_link_add(repeat('g', 40), 'pDR', null, 'fileRollback001', 'Soubor', 'application/pdf', 'https://drive.google.com/file/d/fileRollback001/view', 1, now(), 'ok');
  PERFORM test.reset();
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES (a, '999', 'r@example.test', '{openid}', 'v1.0000aaaa.a.b.c');
END $$;
SQL
if out=$(psql_admin -d cs_kd --single-transaction -f - < "$DOWN3" 2>&1); then echo "FAIL: 1200 rollback ran although Drive links exist"; exit 1; fi
echo "$out" | grep -q "Drive links would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
echo "ok - 1200 rollback refused while Drive links exist, nothing changed"
psql_admin -d cs_kd -q -c "delete from public.external_resource_links" >/dev/null
if out=$(psql_admin -d cs_kd --single-transaction -f - < "$DOWN3" 2>&1); then echo "FAIL: 1200 rollback ran although connections exist"; exit 1; fi
echo "$out" | grep -q "Google connections exist" || { echo "FAIL: wrong refusal: $out"; exit 1; }
[ "$(psql_admin -d cs_kd -At -c "select count(*) from public.google_connections")" = "1" ] || { echo "FAIL: refused rollback changed data"; exit 1; }
echo "ok - 1200 rollback refused while Google connections exist (they must be revoked at Google first), nothing changed"
{ echo "SET clearspace.rollback_allow_data_loss = 'on';"; cat "$DOWN3"; } | psql_admin -d cs_kd --single-transaction -f - >/dev/null
SR3=$(psql_admin -d cs_kd -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR3" = "$S1100" ] || { echo "FAIL: catalog after 1200 rollback ($SR3) differs from 1100 ($S1100)"; exit 1; }
echo "ok - catalog after 1200 rollback == catalog at 1100 ($SR3)"
apply cs_kd "$FRONTEND/supabase/migrations/20261126001200_google_drive.sql"
[ "$(psql_admin -d cs_kd -At -c "select count(*) from public.clearspace_migrations where version = '20261126001200_google_drive'")" = "1" ] || { echo "FAIL: re-apply 1200 after rollback"; exit 1; }
echo "ok - 20261126001200 applies again after its rollback"

# ---------------------------------------------------------------- RUN 03: Gmail resources
echo "== Scenario K4: Gmail (private sources, owner-only content, roles, purge, per-service permission, Drive compatibility) -- committed transactions"
newdb cs_k4
apply cs_k4 "$BASELINE" "${MIGRATIONS[@]}"
out="$(mktemp)"
if psql_admin -d cs_k4 -f - < "$HERE/collab/93_gmail.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/93_gmail.sql"; exit 1
fi

echo "--- upgrade from run02-complete (1200 with Drive data) -> 1300: Drive rows, connections and audit unchanged"
newdb cs_kg; apply cs_kg "$BASELINE" "${UPTO_1200[@]}"
S1200=$(psql_admin -d cs_kg -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
psql_admin -d cs_kg -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := test.mkuser('gu-a@example.test'); BEGIN
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  PERFORM test.act_as(a, 'gu-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pGU', 'U');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pGU', 'member-owner-' || a::text);
  PERFORM public.drive_link_add(repeat('g', 40), 'pGU', null, 'fileUpgrade0001', 'Soubor', 'application/pdf', 'https://drive.google.com/file/d/fileUpgrade0001/view', 1, now(), 'ok');
  PERFORM test.reset();
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES (a, '991', 'u@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file'], 'v1.0000aaaa.a.b.c');
  INSERT INTO public.integration_audit (user_id, provider, event) VALUES (a, 'google', 'connected');
END $$;
SQL
BEFORE=$(psql_admin -d cs_kg -At -c "select md5(string_agg(t::text, '|' order by t::text)) from (select id, project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, provider_state, linked_by from public.external_resource_links) t")
apply cs_kg "$FRONTEND/supabase/migrations/20261127001300_gmail.sql"
apply cs_kg "$FRONTEND/supabase/migrations/20261127001300_gmail.sql"      # idempotent
AFTER=$(psql_admin -d cs_kg -At -c "select md5(string_agg(t::text, '|' order by t::text)) from (select id, project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, provider_state, linked_by from public.external_resource_links) t")
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: Drive rows changed by the upgrade"; exit 1; }
[ "$(psql_admin -d cs_kg -At -c "select count(*) from public.google_connections where status = 'active'")/$(psql_admin -d cs_kg -At -c "select count(*) from public.integration_audit")" = "1/1" ] || { echo "FAIL: connections/audit changed"; exit 1; }
echo "ok - upgrade 1200 -> 1300 keeps Drive links, connections and audit byte-identical; re-apply is a no-op"

echo "--- Gmail rollback (1300): refused while Gmail links / per-service audit exist; otherwise restores the 1200 catalog exactly"
DOWN4="$FRONTEND/supabase/rollback/20261127001300_gmail.down.sql"
psql_admin -d cs_kg -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := (select id from auth.users where email = 'gu-a@example.test'); BEGIN
  PERFORM test.reset();
  UPDATE public.google_connections SET scopes = scopes || ARRAY['https://www.googleapis.com/auth/gmail.readonly'] WHERE user_id = a;
  PERFORM test.act_as(a, 'gu-a@example.test');
  PERFORM public.gmail_link_add(repeat('g', 40), 'pGU', null, 'message', 'refRollback000000000001', '991', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 1, null, 'ok');
END $$;
SQL
if out=$(psql_admin -d cs_kg --single-transaction -f - < "$DOWN4" 2>&1); then echo "FAIL: 1300 rollback ran although Gmail links exist"; exit 1; fi
echo "$out" | grep -q "Gmail links would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
[ "$(psql_admin -d cs_kg -At -c "select count(*) from public.gmail_link_sources")" = "1" ] || { echo "FAIL: refused rollback changed data"; exit 1; }
echo "ok - 1300 rollback refused while Gmail links exist, nothing changed"
psql_admin -d cs_kg -q -c "delete from public.external_resource_links where provider <> 'google_drive'; update public.google_connections set scopes = array_remove(scopes, 'https://www.googleapis.com/auth/gmail.readonly')" >/dev/null
psql_admin -d cs_kg -q -c "insert into public.integration_audit (user_id, provider, event, detail) select id, 'google', 'service_removed', 'gmail' from auth.users where email = 'gu-a@example.test'" >/dev/null
if out=$(psql_admin -d cs_kg --single-transaction -f - < "$DOWN4" 2>&1); then echo "FAIL: 1300 rollback ran although per-service audit rows exist"; exit 1; fi
echo "$out" | grep -q "per-service audit rows would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
echo "ok - 1300 rollback refused while per-service audit rows exist"
{ echo "SET clearspace.rollback_allow_data_loss = 'on';"; cat "$DOWN4"; } | psql_admin -d cs_kg --single-transaction -f - >/dev/null
SR4=$(psql_admin -d cs_kg -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR4" = "$S1200" ] || { echo "FAIL: catalog after 1300 rollback ($SR4) differs from 1200 ($S1200)"; exit 1; }
echo "ok - catalog after 1300 rollback == catalog at 1200 ($SR4)"
[ "$(psql_admin -d cs_kg -At -c "select count(*) from public.external_resource_links where provider = 'google_drive'")" = "1" ] || { echo "FAIL: rollback lost Drive links"; exit 1; }
echo "ok - Drive links survive the 1300 rollback"
apply cs_kg "$FRONTEND/supabase/migrations/20261127001300_gmail.sql"
[ "$(psql_admin -d cs_kg -At -c "select count(*) from public.clearspace_migrations where version = '20261127001300_gmail'")" = "1" ] || { echo "FAIL: re-apply 1300 after rollback"; exit 1; }
echo "ok - 20261127001300 applies again after its rollback"

# ---------------------------------------------------------------- RUN 04: Google Calendar events
echo "== Scenario K5: Google Calendar (private sources, roles, duplicates, refresh, purge, per-service permission, Gmail/Drive compatibility) -- committed transactions"
newdb cs_k5
apply cs_k5 "$BASELINE" "${MIGRATIONS[@]}"
out="$(mktemp)"
if psql_admin -d cs_k5 -f - < "$HERE/collab/94_google_calendar.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/94_google_calendar.sql"; exit 1
fi

echo "--- upgrade from run03c-complete (1300 with Drive + Gmail data) -> 1400: Drive / Gmail rows, sources, connections and audit unchanged"
UPTO_1300=(); for f in "${MIGRATIONS[@]}"; do [[ "$(basename "$f")" > "20261127001300~" ]] || UPTO_1300+=("$f"); done
newdb cs_kc; apply cs_kc "$BASELINE" "${UPTO_1300[@]}"
S1300=$(psql_admin -d cs_kc -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
psql_admin -d cs_kc -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := test.mkuser('cu-a@example.test'); BEGIN
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES (a, '992', 'c@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'], 'v1.0000aaaa.a.b.c');
  INSERT INTO public.integration_audit (user_id, provider, event) VALUES (a, 'google', 'connected');
  PERFORM test.act_as(a, 'cu-a@example.test');
  INSERT INTO public.projects (id, name) VALUES ('pCU', 'U');
  INSERT INTO public.project_members (project_id, member_id) VALUES ('pCU', 'member-owner-' || a::text);
  PERFORM public.drive_link_add(repeat('g', 40), 'pCU', null, 'fileUpgrade0002', 'Soubor', 'application/pdf', 'https://drive.google.com/file/d/fileUpgrade0002/view', 1, now(), 'ok');
  PERFORM public.gmail_link_add(repeat('g', 40), 'pCU', null, 'thread', 'refUpgradeGmail00000001', '992', '18c3a5e000000000', '18c3a5e000000000', 'S', 'F', now(), 2, null, 'ok');
  PERFORM public.google_service_audit(repeat('g', 40), 'service_added', 'gmail');
END $$;
SQL
FP="select md5(string_agg(t::text, '|' order by t::text)) from (select id, project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, modified_at, provider_state, linked_by, email_from, email_count, email_attachments from public.external_resource_links) t"
FPS="select md5(string_agg(t::text, '|' order by t::text)) from (select * from public.gmail_link_sources) t"
FPC="select md5(string_agg(t::text, '|' order by t::text)) from (select user_id, google_sub, scopes, status, refresh_token_enc from public.google_connections) t"
FPA="select md5(string_agg(t::text, '|' order by t::text)) from (select user_id, provider, event, detail, created_at from public.integration_audit) t"
BEFORE="$(psql_admin -d cs_kc -At -c "$FP")/$(psql_admin -d cs_kc -At -c "$FPS")/$(psql_admin -d cs_kc -At -c "$FPC")/$(psql_admin -d cs_kc -At -c "$FPA")"
CAL="$FRONTEND/supabase/migrations/20261128001400_google_calendar.sql"
apply cs_kc "$CAL"
apply cs_kc "$CAL"      # idempotent
AFTER="$(psql_admin -d cs_kc -At -c "$FP")/$(psql_admin -d cs_kc -At -c "$FPS")/$(psql_admin -d cs_kc -At -c "$FPC")/$(psql_admin -d cs_kc -At -c "$FPA")"
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: Drive/Gmail rows, sources, connections or audit changed by the 1400 upgrade"; exit 1; }
echo "ok - upgrade 1300 -> 1400 keeps Drive + Gmail links, Gmail sources, connections and audit byte-identical; re-apply is a no-op"

echo "--- Calendar rollback (1400): refused while Calendar links / Calendar audit exist; otherwise restores the 1300 catalog exactly"
DOWN5="$FRONTEND/supabase/rollback/20261128001400_google_calendar.down.sql"
psql_admin -d cs_kc -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := (select id from auth.users where email = 'cu-a@example.test'); BEGIN
  PERFORM test.reset();
  UPDATE public.google_connections SET scopes = scopes || ARRAY['https://www.googleapis.com/auth/calendar.events.owned.readonly'] WHERE user_id = a;
  PERFORM test.act_as(a, 'cu-a@example.test');
  PERFORM public.calendar_link_add(repeat('g', 40), 'pCU', null, 'refRollbackCal000000001', '992', 'evtrollback01', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok');
END $$;
SQL
if out=$(psql_admin -d cs_kc --single-transaction -f - < "$DOWN5" 2>&1); then echo "FAIL: 1400 rollback ran although Calendar links exist"; exit 1; fi
echo "$out" | grep -q "Calendar links would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
[ "$(psql_admin -d cs_kc -At -c "select count(*) from public.calendar_link_sources")" = "1" ] || { echo "FAIL: refused rollback changed data"; exit 1; }
echo "ok - 1400 rollback refused while Calendar links exist, nothing changed"
psql_admin -d cs_kc -q -c "delete from public.external_resource_links where provider = 'google_calendar_event'; update public.google_connections set scopes = array_remove(scopes, 'https://www.googleapis.com/auth/calendar.events.owned.readonly')" >/dev/null
psql_admin -d cs_kc -q -c "insert into public.integration_audit (user_id, provider, event, detail) select id, 'google', 'service_removed', 'calendar' from auth.users where email = 'cu-a@example.test'" >/dev/null
if out=$(psql_admin -d cs_kc --single-transaction -f - < "$DOWN5" 2>&1); then echo "FAIL: 1400 rollback ran although Calendar audit rows exist"; exit 1; fi
echo "$out" | grep -q "Calendar audit rows would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
echo "ok - 1400 rollback refused while Calendar audit rows exist"
{ echo "SET clearspace.rollback_allow_data_loss = 'on';"; cat "$DOWN5"; } | psql_admin -d cs_kc --single-transaction -f - >/dev/null
SR5=$(psql_admin -d cs_kc -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR5" = "$S1300" ] || { echo "FAIL: catalog after 1400 rollback ($SR5) differs from 1300 ($S1300)"; exit 1; }
echo "ok - catalog after 1400 rollback == catalog at 1300 ($SR5)"
AFTER_RB="$(psql_admin -d cs_kc -At -c "$FP")/$(psql_admin -d cs_kc -At -c "$FPS")"
[ "$AFTER_RB" = "$(echo "$BEFORE" | cut -d/ -f1-2)" ] || { echo "FAIL: rollback changed Drive/Gmail links"; exit 1; }
echo "ok - Drive + Gmail links and Gmail sources survive the 1400 rollback byte-identical"
apply cs_kc "$CAL"
[ "$(psql_admin -d cs_kc -At -c "select count(*) from public.clearspace_migrations where version = '20261128001400_google_calendar'")" = "1" ] || { echo "FAIL: re-apply 1400 after rollback"; exit 1; }
echo "ok - 20261128001400 applies again after its rollback"

# ---------------------------------------------------------------- RUN 05: notifications outside the app (Slack / Telegram)
echo "== Scenario K6: notification channels (no client access, linking, enqueue, preferences, dispatcher, due dates / DST, cascades) -- committed transactions"
newdb cs_k6
apply cs_k6 "$BASELINE" "${MIGRATIONS[@]}"
out="$(mktemp)"
if psql_admin -d cs_k6 -f - < "$HERE/collab/95_notification_channels.sql" >"$out" 2>&1; then
  k=$(grep -cE "NOTICE:  ok" "$out" || true); TOTAL=$((TOTAL + k))
  grep -E "NOTICE:  ok" "$out" | sed -E 's/^.*NOTICE:  //'
  echo "    ($k assertions)"; rm -f "$out"
else
  cat "$out"; rm -f "$out"; echo "FAIL: collab/95_notification_channels.sql"; exit 1
fi

echo "--- N12 parity: the same RUN 01 actions on 1400 and on 1500 (every user with an active channel) leave identical in-app notifications"
UPTO_1400=(); for f in "${MIGRATIONS[@]}"; do [[ "$(basename "$f")" > "20261128001400~" ]] || UPTO_1400+=("$f"); done
newdb cs_kp4; apply cs_kp4 "$BASELINE" "${UPTO_1400[@]}"
newdb cs_kp5; apply cs_kp5 "$BASELINE" "${MIGRATIONS[@]}"
P4=$(psql_admin -d cs_kp4 -At -f - < "$HERE/collab/95_parity_scenario.sql" | grep '^parity:')
P5=$(psql_admin -d cs_kp5 -At -f - < "$HERE/collab/95_parity_scenario.sql" | grep '^parity:')
[ -n "$P4" ] && [ "$P4" = "$P5" ] || { echo "FAIL: in-app notifications differ: 1400 $P4 / 1500 $P5"; exit 1; }
QUEUED=$(psql_admin -d cs_kp5 -At -c "select count(*) from public.notification_deliveries")
[ "$QUEUED" -gt 0 ] || { echo "FAIL: parity run on 1500 queued nothing (triggers did not run)"; exit 1; }
echo "ok - in-app notifications identical on 1400 and 1500 ($P5); on 1500 the same actions also queued $QUEUED external deliveries"

echo "--- upgrade from run04-complete (1400 with Drive + Gmail + Calendar data and notifications) -> 1500: existing rows unchanged"
newdb cs_kn; apply cs_kn "$BASELINE" "${UPTO_1400[@]}"
S1400=$(psql_admin -d cs_kn -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
EXT_BEFORE=$(psql_admin -d cs_kn -At -c "select string_agg(extname, ',' order by extname) from pg_extension")
psql_admin -d cs_kn -At -f - < "$HERE/collab/95_parity_scenario.sql" >/dev/null
psql_admin -d cs_kn -q >/dev/null <<'SQL'
DO $$ DECLARE a uuid := (select id from auth.users where email = 'p-own@example.test'); BEGIN
  INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('google', encode(sha256(convert_to(repeat('g', 40), 'UTF8')), 'hex'))
  ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256;
  INSERT INTO public.google_connections (user_id, google_sub, google_email, scopes, refresh_token_enc) VALUES (a, '995', 'n@example.test', ARRAY['openid', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.owned.readonly'], 'v1.0000aaaa.a.b.c');
  INSERT INTO public.integration_audit (user_id, provider, event) VALUES (a, 'google', 'connected');
  PERFORM test.act_as(a, 'p-own@example.test');
  PERFORM public.drive_link_add(repeat('g', 40), 'pP', null, 'fileUpgrade0005', 'Soubor', 'application/pdf', 'https://drive.google.com/file/d/fileUpgrade0005/view', 1, now(), 'ok');
  PERFORM public.gmail_link_add(repeat('g', 40), 'pP', null, 'thread', 'refUpgradeGmail00000005', '995', '18c3a5e000000005', '18c3a5e000000005', 'S', 'F', now(), 2, null, 'ok');
  PERFORM public.calendar_link_add(repeat('g', 40), 'pP', null, 'refUpgradeCal0000000005', '995', 'evtupgrade05', null, 'T', now(), now(), false, null, false, 0, null, now(), 'ok');
END $$;
SQL
FPN="select md5(string_agg(t::text, '|' order by t::text)) from (select * from public.notifications) t"
FPL="select md5(string_agg(t::text, '|' order by t::text)) from (select * from public.external_resource_links) t"
FPG="select md5(string_agg(t::text, '|' order by t::text)) from (select user_id, google_sub, scopes, status, refresh_token_enc from public.google_connections) t"
FPX="select md5(string_agg(t::text, '|' order by t::text)) from (select id, project_id, card_id, action_type, details from public.activity_logs) t"
FPT="select md5(string_agg(t::text, '|' order by t::text)) from (select * from public.server_trust) t"
BEFORE6="$(psql_admin -d cs_kn -At -c "$FPN")/$(psql_admin -d cs_kn -At -c "$FPL")/$(psql_admin -d cs_kn -At -c "$FPG")/$(psql_admin -d cs_kn -At -c "$FPX")/$(psql_admin -d cs_kn -At -c "$FPT")"
NTF="$FRONTEND/supabase/migrations/20261129001500_notification_channels.sql"
apply cs_kn "$NTF"
apply cs_kn "$NTF"      # idempotent
AFTER6="$(psql_admin -d cs_kn -At -c "$FPN")/$(psql_admin -d cs_kn -At -c "$FPL")/$(psql_admin -d cs_kn -At -c "$FPG")/$(psql_admin -d cs_kn -At -c "$FPX")/$(psql_admin -d cs_kn -At -c "$FPT")"
[ "$BEFORE6" = "$AFTER6" ] || { echo "FAIL: notifications / links / connections / activity / trust changed by the 1500 upgrade"; exit 1; }
echo "ok - upgrade 1400 -> 1500 keeps notifications, Drive/Gmail/Calendar links, connections, activity and server_trust byte-identical; re-apply is a no-op"
[ "$(psql_admin -d cs_kn -At -c "select count(*) from public.notification_channels")" = "0" ] && [ "$(psql_admin -d cs_kn -At -c "select string_agg(extname, ',' order by extname) from pg_extension")" = "$EXT_BEFORE" ] \
  || { echo "FAIL: 1500 created channels or installed extensions"; exit 1; }
echo "ok - 1500 installs no extension and schedules nothing (scheduler only via supabase/ops, switched on by the owner)"

echo "--- notification rollback (1500): refused while channels / preferences / deliveries exist; otherwise restores the 1400 catalog exactly"
DOWN6="$FRONTEND/supabase/rollback/20261129001500_notification_channels.down.sql"
psql_admin -d cs_kn -q -c "insert into public.notification_channels (user_id, provider, status, secret_enc, label) select id, 'telegram', 'active', 'v1.0000beef.aaaa.bbbb.cccc', 'R' from auth.users where email = 'p-ed@example.test'" >/dev/null
if out=$(psql_admin -d cs_kn --single-transaction -f - < "$DOWN6" 2>&1); then echo "FAIL: 1500 rollback ran although channels exist"; exit 1; fi
echo "$out" | grep -q "notification channels would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
[ "$(psql_admin -d cs_kn -At -c "select count(*) from public.notification_channels")" = "1" ] || { echo "FAIL: refused rollback changed data"; exit 1; }
echo "ok - 1500 rollback refused while channels exist, nothing changed"
psql_admin -d cs_kn -q -c "delete from public.notification_channels; insert into public.notification_preferences (user_id) select id from auth.users where email = 'p-ed@example.test'" >/dev/null
if out=$(psql_admin -d cs_kn --single-transaction -f - < "$DOWN6" 2>&1); then echo "FAIL: 1500 rollback ran although preferences exist"; exit 1; fi
echo "$out" | grep -q "preference / delivery rows would be lost" || { echo "FAIL: wrong refusal: $out"; exit 1; }
echo "ok - 1500 rollback refused while preferences exist"
{ echo "SET clearspace.rollback_allow_data_loss = 'on';"; cat "$DOWN6"; } | psql_admin -d cs_kn --single-transaction -f - >/dev/null
SR6=$(psql_admin -d cs_kn -At -f - < "$FRONTEND/supabase/snapshot_catalog.sql" | tail -1)
[ "$SR6" = "$S1400" ] || { echo "FAIL: catalog after 1500 rollback ($SR6) differs from 1400 ($S1400)"; exit 1; }
echo "ok - catalog after 1500 rollback == catalog at 1400 ($SR6)"
AFTER_RB6="$(psql_admin -d cs_kn -At -c "$FPN")/$(psql_admin -d cs_kn -At -c "$FPL")/$(psql_admin -d cs_kn -At -c "$FPG")/$(psql_admin -d cs_kn -At -c "$FPX")/$(psql_admin -d cs_kn -At -c "$FPT")"
[ "$AFTER_RB6" = "$BEFORE6" ] || { echo "FAIL: rollback changed existing rows"; exit 1; }
echo "ok - existing rows survive the 1500 rollback byte-identical"
apply cs_kn "$NTF"
[ "$(psql_admin -d cs_kn -At -c "select count(*) from public.clearspace_migrations where version = '20261129001500_notification_channels'")" = "1" ] || { echo "FAIL: re-apply 1500 after rollback"; exit 1; }
echo "ok - 20261129001500 applies again after its rollback"
