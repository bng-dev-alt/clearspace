#!/usr/bin/env bash
# HOTFIX: apply migration 20261118000900_meeting_creator_erasure to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner). RUN ONLY AFTER THE OWNER'S WRITTEN APPROVAL.
#
#   CONFIRM_HOTFIX_0900=twjlnsxjtuntujarwner frontend/scripts/apply-hotfix-0900-hosted.sh
#
# Why: meetings.created_by is ON DELETE SET NULL but guard_meeting_identity() refused that update, so deleting a user who created a meeting failed (HTTP 500).
# Interlocks (each one stops the script BEFORE any hosted write): the confirmation names the project; the working tree is clean; the pre-hotfix backup exists and
# matches its SHA256SUMS; the migration, its rollback and the verification script have exactly the rehearsed checksums; hosted holds exactly the 7 markers 0100-0700
# and NOT 0900; the hosted public/storage CATALOG snapshot is exactly the one that was compared with the rehearsed 0700 state; the guard is still the defective one.
# The migration runs in ONE transaction. Afterwards: exactly ONE catalog line may have changed (the guard function), the verification script must say PASS on every GATE,
# and the old-table row counts must be unchanged. Not done here: 0800, any secret, Vercel / Cloudflare / firewall / deployment / Git.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
[ "${CONFIRM_HOTFIX_0900:-}" = "$REF" ] || { echo "refusing: set CONFIRM_HOTFIX_0900=$REF (only after the written approval)"; exit 2; }
[ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
BK=/Volumes/WORKSPACE/_G2_BACKUP/20261118-v1-pre-hotfix-0900
(cd "$BK" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) || { echo "refusing: backup missing or its checksum does not match"; exit 2; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
M=frontend/supabase/migrations/20261118000900_meeting_creator_erasure.sql
[ "$(sha $M)" = 333b103db38b6e36c56fed7ca1de9fc31f86355f2fa9e17e6dcbf5e4edb8360a ] || { echo "refusing: 0900 differs from the rehearsed file"; exit 2; }
[ "$(sha frontend/supabase/rollback/20261118000900_meeting_creator_erasure.down.sql)" = 369e4b7c6c504a418c9af10e71195b313a036f39ae664bb04d2f0700aa15be11 ] || { echo "refusing: the rollback script differs from the rehearsed one"; exit 2; }
[ "$(sha frontend/supabase/verify_hosted_intelligence.sql)" = dc8b31e2e0d13efb0aa33f7b34ad1d1e33bb2a587d9498ff504f7d1b6375297d ] || { echo "refusing: verify_hosted_intelligence.sql changed"; exit 2; }

DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
pg() { docker run --rm -i -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" "$IMG" psql "$DB" -X "$@"; }
trap 'unset PGPASSWORD' EXIT
snap_lines() { python3 - <<'PY' | pg -At -f - | grep -v '^SET'
s = open('frontend/supabase/snapshot_catalog.sql').read().rstrip().rstrip(';')
s = s.replace("select md5(string_agg(x, E'\\n' order by x)) || ' lines=' || count(*) from (", "select x from (")
print("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"); print(s + " order by x;")
PY
}
counts() { pg -At -c "select 'profiles='||(select count(*) from public.profiles)||' projects='||(select count(*) from public.projects)||' columns='||(select count(*) from public.columns)||' cards='||(select count(*) from public.cards)||' workspace_members='||(select count(*) from public.workspace_members)||' invitations='||(select count(*) from public.invitations)||' ai_requests='||(select count(*) from public.ai_requests)||' auth.users='||(select count(*) from auth.users)||' meetings='||(select count(*) from public.meetings)"; }

echo "== 0. hosted state before (read-only)"
markers=$(pg -At -c "select string_agg(version, ',' order by version) from public.clearspace_migrations" 2>/dev/null)
[ "$markers" = "20261117000100_security_foundation,20261117000200_restore_project_board,20261117000300_least_privilege_table_grants,20261117000400_task_resources_storage,20261118000500_intelligence_core,20261118000600_intelligence_quality,20261118000700_meeting_audio" ] \
  || { echo "refusing: unexpected markers on hosted: $markers"; exit 2; }
snapmd5=$(pg -At -c "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY" -f /w/snapshot_catalog.sql | tail -1)
[ "$snapmd5" = "2af129a4d386111d1456bba9d127fecf lines=2151" ] || { echo "refusing: the hosted catalog is not the rehearsed one ($snapmd5)"; exit 2; }
[ "$(pg -At -c "select count(*) from pg_proc p where p.oid='public.guard_meeting_identity()'::regprocedure and not p.prosecdef")" = 1 ] || { echo "refusing: the guard is not the defective 0700 one (already fixed?)"; exit 2; }
BEFORE=$(snap_lines); C0=$(counts)
echo "ok - 7 markers (0100-0700, no 0900), catalog == rehearsed 0700 state ($snapmd5), defective guard present"; echo "counts before: $C0"

echo "== 1. apply 0900 in ONE transaction"
if pg -v ON_ERROR_STOP=1 -q --single-transaction -f /w/migrations/20261118000900_meeting_creator_erasure.sql >/dev/null; then echo "applied 20261118000900_meeting_creator_erasure"
else
  echo "FAILED -- nothing was changed (single transaction). STOP. Report the error; do not retry blindly."; exit 1
fi

echo "== 2. verify (read-only)"
AFTER=$(snap_lines)
CHG=$(diff <(echo "$BEFORE") <(echo "$AFTER") | grep -c '^[<>]')
echo "catalog lines changed: $CHG (expected exactly 2 = the guard function line removed + added)"
diff <(echo "$BEFORE") <(echo "$AFTER") | grep '^[<>]' | cut -c1-90
[ "$CHG" = 2 ] || { echo "UNEXPECTED catalog change -- STOP and report; rollback: frontend/supabase/rollback/20261118000900_meeting_creator_erasure.down.sql as role postgres"; exit 1; }
C1=$(counts); [ "$C1" = "$C0" ] && echo "ok - row counts unchanged ($C1)" || { echo "row counts changed: $C1 -- STOP"; exit 1; }
out=$(pg -f /w/verify_hosted_intelligence.sql 2>&1); echo "$out" | grep -E "^(GATE|INFO)" | cut -c1-200
if echo "$out" | grep -E "^GATE" | grep -qv "PASS"; then echo "VERIFY: at least one GATE is not PASS -- STOP and report"; exit 1; fi
echo "HOTFIX DONE: 0900 applied and verified. Next: staged smoke (frontend/scripts/staged-intelligence-smoke.sh) -- its account deletion is the regression check -- then wait for the B3 approvals."
