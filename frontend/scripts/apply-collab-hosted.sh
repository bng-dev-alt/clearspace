#!/usr/bin/env bash
# Apply the collaboration migrations 20261124001000 + 20261125001100 to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner).
# RUN ONLY AFTER THE OWNER'S WRITTEN APPROVAL (docs/collaboration/PRODUCTION_ROLLOUT.md, section 9).
#
#   CONFIRM_COLLAB=twjlnsxjtuntujarwner frontend/scripts/apply-collab-hosted.sh
#   optional: EMAIL_SERVER_SECRET_SHA256=<64 hex>   registers the e-mail server secret's HASH in server_trust('email') afterwards
#
# Interlocks (each stops BEFORE any hosted write): the confirmation names the project; the working tree is clean; both migrations
# and both rollbacks have exactly the rehearsed checksums; hosted holds exactly the 8 markers 0100..0900 (and not 1000/1100); the
# hosted public/storage catalog is exactly the one compared with the rehearsed 0900 state on 2026-11-24; role postgres may create
# policies on realtime.messages (supautils policy_grants) and realtime.send() exists. A fresh pg_dump of `public` is taken and
# checksummed before the first write. Each migration runs in ONE transaction. Afterwards: row counts unchanged, both markers
# present, realtime policies present, postgres_changes publication empty, every project has a realtime key, no e-mail left in the
# cards' assignee mirror. Not done here: Realtime "public access" setting, Vercel, Supabase Auth SMTP, DNS, deployment, Git.
#
# Rehearsal (local throwaway copy only): REHEARSAL_CONTAINER=<docker container> CONFIRM_COLLAB=rehearsal EXPECT_CATALOG='<md5 lines=N>'
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -n "${REHEARSAL_CONTAINER:-}" ]; then
  [ "${CONFIRM_COLLAB:-}" = rehearsal ] || { echo "refusing: rehearsal needs CONFIRM_COLLAB=rehearsal"; exit 2; }
  pg() { docker exec -i -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-sectest}" "$REHEARSAL_CONTAINER" psql -h localhost -U postgres -d postgres -X "$@"; }
  dump() { docker exec -e PGPASSWORD="${REHEARSAL_PGPASSWORD:-sectest}" "$REHEARSAL_CONTAINER" pg_dump -h localhost -U postgres -d postgres --schema=public -Fc; }
  BK="${TMPDIR:-/tmp}/cs-collab-rehearsal-backup-$STAMP"
  EXPECTED_CATALOG="${EXPECT_CATALOG:?rehearsal needs EXPECT_CATALOG}"
else
  [ "${CONFIRM_COLLAB:-}" = "$REF" ] || { echo "refusing: set CONFIRM_COLLAB=$REF (only after the written approval)"; exit 2; }
  [ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
  DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  [ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
  trap 'unset PGPASSWORD' EXIT
  pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X "$@"; }
  dump() { docker run --rm -e PGPASSWORD "$IMG" pg_dump "$DB" --schema=public -Fc; }
  BK="/Volumes/WORKSPACE/_G2_BACKUP/${STAMP%%-*}-v1-pre-collab"
  EXPECTED_CATALOG="179d2398dc5818730f64c6f41e085a4e lines=2151"   # hosted, read-only, 2026-11-24 (== rehearsed 0900 state)
fi
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
S=frontend/supabase
M1=$S/migrations/20261124001000_collaboration.sql; M2=$S/migrations/20261125001100_collab_hardening.sql
D1=$S/rollback/20261124001000_collaboration.down.sql; D2=$S/rollback/20261125001100_collab_hardening.down.sql
[ "$(sha $M1)" = 9d3a4fc0070f54d63146d84d47a1dd270c562dd06c013bd5dc37573e6570b28b ] || { echo "refusing: 1000 differs from the rehearsed file"; exit 2; }
[ "$(sha $M2)" = c58f9fc874651506917cbd93165b98032be6983d725ff96d527ae8fc8c749a1f ] || { echo "refusing: 1100 differs from the rehearsed file"; exit 2; }
[ "$(sha $D1)" = d79c8718e98ea6ebb13caaf93221633c773f8db06745885c751759f8fb106f9d ] || { echo "refusing: 1000 rollback differs from the rehearsed one"; exit 2; }
[ "$(sha $D2)" = d89abbdb2bf4c036ddb931e9f81d895d35b33204ebeaede0166780bf4b6b8756 ] || { echo "refusing: 1100 rollback differs from the rehearsed one"; exit 2; }
[ "$(sha $S/snapshot_catalog.sql)" = 9ad7e38f67a6a885d848b010f952afe5c3223f96c2fb5d5ef6d3c2556deaadec ] || { echo "refusing: snapshot_catalog.sql changed"; exit 2; }
ro() { { echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"; cat; } | pg -At -q -v ON_ERROR_STOP=1 -f - | grep -v '^SET'; }
counts() { echo "select 'projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' card_assignees='||(select count(*) from public.card_assignees)||' members='||(select count(*) from public.project_members)||' workspace_members='||(select count(*) from public.workspace_members)||' comments='||(select count(*) from public.task_comments)||' checklists='||(select count(*) from public.task_checklists)||' history='||(select count(*) from public.task_activities)||' events='||(select count(*) from public.activity_logs)||' invitations='||(select count(*) from public.invitations)||' profiles='||(select count(*) from public.profiles)||' meetings='||(select count(*) from public.meetings)||' auth.users='||(select count(*) from auth.users);" | ro; }

echo "== 0. hosted state before (read-only)"
markers=$(echo "select string_agg(version, ',' order by version) from public.clearspace_migrations;" | ro)
[ "$markers" = "20261117000100_security_foundation,20261117000200_restore_project_board,20261117000300_least_privilege_table_grants,20261117000400_task_resources_storage,20261118000500_intelligence_core,20261118000600_intelligence_quality,20261118000700_meeting_audio,20261118000900_meeting_creator_erasure" ] \
  || { echo "refusing: unexpected markers: $markers"; exit 2; }
cat_now=$(ro < $S/snapshot_catalog.sql | tail -1)
[ "$cat_now" = "$EXPECTED_CATALOG" ] || { echo "refusing: the catalog is not the rehearsed one ($cat_now)"; exit 2; }
rt=$(echo "select (to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null)::text || ',' || (coalesce(current_setting('supautils.policy_grants', true), '') like '%\"realtime.messages\"%')::text || ',' || (to_regclass('realtime.messages') is not null)::text;" | ro)
[ "$rt" = "true,true,true" ] || { echo "refusing: realtime prerequisites missing (send(), policy grant, messages): $rt"; exit 2; }
C0=$(counts); echo "ok - markers 0100..0900, catalog == rehearsed ($cat_now), realtime prerequisites present"; echo "counts before: $C0"

echo "== 1. backup of schema public -> $BK"
umask 077; mkdir -p "$BK" || { echo "refusing: cannot create $BK"; exit 2; }
dump > "$BK/public.dump" 2> "$BK/pg_dump.stderr" && [ -s "$BK/public.dump" ] || { echo "refusing: backup failed (see $BK/pg_dump.stderr)"; exit 2; }
(cd "$BK" && shasum -a 256 public.dump > SHA256SUMS && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "refusing: backup checksum failed"; exit 2; }
echo "ok - backup $(du -h "$BK/public.dump" | cut -f1) $(cut -c1-16 "$BK/SHA256SUMS")…"

echo "== 2. apply (each migration in ONE transaction)"
for m in "$M1" "$M2"; do
  if { echo "SET client_min_messages = warning;"; cat "$m"; } | pg -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then echo "applied $(basename "$m" .sql)"
  else
    echo "FAILED: $(basename "$m") -- that migration changed nothing (single transaction). STOP and report; do not retry blindly."
    [ "$m" = "$M2" ] && echo "State: 1000 is applied and consistent on its own. To return to 0900: psql --single-transaction -f $D1 (as postgres)."
    exit 1
  fi
done

echo "== 3. verify (read-only)"
fail=0
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged" || { echo "row counts changed: $C1"; fail=1; }
v=$(cat <<'SQL' | ro
select 'markers=' || (select count(*) from public.clearspace_migrations where version in ('20261124001000_collaboration', '20261125001100_collab_hardening'))
  || ' realtime_policies=' || (select count(*) from pg_policies where schemaname = 'realtime' and policyname in ('clearspace_topic_read', 'clearspace_topic_presence_write'))
  || ' publication_tables=' || (select count(*) from pg_publication_tables where pubname = 'supabase_realtime')
  || ' projects_without_key=' || (select count(*) from public.projects where realtime_key is null)
  || ' assignee_mirror_emails=' || (select count(*) from public.cards where assignees::text like '%@%')
  || ' notifications=' || (select count(*) from public.notifications);
SQL
)
echo "$v"
[ "$v" = "markers=2 realtime_policies=2 publication_tables=0 projects_without_key=0 assignee_mirror_emails=0 notifications=0" ] && echo "ok - collaboration state as rehearsed" || fail=1
if [ $fail = 1 ]; then echo "UNEXPECTED state -- STOP and report. Rollback (as postgres, in order): $D2 then $D1; backup: $BK"; exit 1; fi

if [ -n "${EMAIL_SERVER_SECRET_SHA256:-}" ]; then
  [[ "$EMAIL_SERVER_SECRET_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "EMAIL_SERVER_SECRET_SHA256 must be 64 lowercase hex characters (the HASH, never the secret)"; exit 1; }
  echo "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('email', '$EMAIL_SERVER_SECRET_SHA256') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();" \
    | pg -q -v ON_ERROR_STOP=1 >/dev/null && echo "ok - e-mail server secret hash registered in server_trust('email')"
fi
echo "DONE: collaboration migrations applied and verified. Next (PRODUCTION_ROLLOUT.md section 5): staged deployment of the branch build, smoke, promote, then Realtime 'Allow public access' OFF."
