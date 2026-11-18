#!/usr/bin/env bash
# B2: apply migrations 0500, 0600, 0700 to the HOSTED ClearSpace V1 Supabase (twjlnsxjtuntujarwner). RUN ONLY AFTER THE OWNER'S WRITTEN B2 APPROVAL.
#
#   CONFIRM_B2_HOSTED_MIGRATIONS=twjlnsxjtuntujarwner frontend/scripts/apply-b2-hosted.sh
#
# Interlocks (each one stops the script BEFORE any hosted write): the confirmation variable names the project; the working tree is clean;
# the three migration files and the verification script have exactly the checksums that were rehearsed on a restored copy of the hosted data;
# the verified backup exists and matches its SHA256SUMS; the hosted database holds exactly the four markers 0100-0400 and none of the new
# objects. Each migration runs in ONE transaction (a failing statement changes nothing); the script stops at the first failure and prints the
# rollback. The database password comes from the macOS Keychain into an environment variable of the docker client only; it is never printed.
# Not done here: migration 0800, registering the STT secret hash, any Vercel / Cloudflare / firewall / deployment / Git change.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."          # repository root
REF=twjlnsxjtuntujarwner
[ "${CONFIRM_B2_HOSTED_MIGRATIONS:-}" = "$REF" ] || { echo "refusing: set CONFIRM_B2_HOSTED_MIGRATIONS=$REF (only after the written B2 approval)"; exit 2; }
[ -z "$(git status --short)" ] || { echo "refusing: working tree is not clean"; exit 2; }
BK=/Volumes/WORKSPACE/_G2_BACKUP/20261118-v1-pre-intelligence-migration
(cd "$BK" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1) || { echo "refusing: backup missing or its checksum does not match"; exit 2; }

M=frontend/supabase/migrations
declare -a FILES=(20261118000500_intelligence_core 20261118000600_intelligence_quality 20261118000700_meeting_audio)
declare -a SUMS=(14cde02eb78c1b0c9224ce1cda4cbb7e2103286d09726898241afcf3af1adb8b ebe53cfad6df477e2c51b5cdc2fc35e5eb4c8b2d2042b6059261b602433c79b2 c0777a184847e2536cafb96b88155c42be1af8a1ea540469d14844ced389b7cf)
for i in 0 1 2; do
  got=$(shasum -a 256 "$M/${FILES[$i]}.sql" | cut -d' ' -f1)
  [ "$got" = "${SUMS[$i]}" ] || { echo "refusing: ${FILES[$i]}.sql differs from the rehearsed file ($got)"; exit 2; }
done
[ "$(shasum -a 256 frontend/supabase/verify_hosted_intelligence.sql | cut -d' ' -f1)" = 4d0d85a10880bdd8427e4db98d74917ad8ae726bd138328d9a80e5cf1803fd65 ] || { echo "refusing: verify_hosted_intelligence.sql changed"; exit 2; }

DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
pg() { docker run --rm -i -e PGPASSWORD -v "$PWD/frontend/supabase:/w:ro" "$IMG" psql "$DB" -X "$@"; }
trap 'unset PGPASSWORD' EXIT

echo "== 0. hosted state before (read-only)"
markers=$(pg -At -c "select string_agg(version, ',' order by version) from public.clearspace_migrations" 2>/dev/null)
[ "$markers" = "20261117000100_security_foundation,20261117000200_restore_project_board,20261117000300_least_privilege_table_grants,20261117000400_task_resources_storage" ] \
  || { echo "refusing: unexpected markers on hosted: $markers"; exit 2; }
[ "$(pg -At -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('meetings','intelligence_runs','intelligence_items','stt_jobs','server_trust')")" = 0 ] \
  || { echo "refusing: some of the new objects already exist on hosted"; exit 2; }
echo "ok - exactly the 4 markers 0100-0400 and none of the new objects"

echo "== 1. apply (one transaction per file, stop at the first failure)"
for f in "${FILES[@]}"; do
  if pg -v ON_ERROR_STOP=1 -q --single-transaction -f "/w/migrations/$f.sql" >/dev/null; then echo "applied $f"
  else
    echo "FAILED $f -- nothing of this file was changed. STOP. Files applied before it stay applied; to undo them run, in this order and as role postgres:"
    echo "  frontend/supabase/rollback/20261118000700_meeting_audio.down.sql, then ...000600_intelligence_quality.down.sql, then ...000500_intelligence_core.down.sql (only those that were applied)"
    exit 1
  fi
done

echo "== 2. verify (read-only): every GATE line must say PASS"
out=$(pg -f /w/verify_hosted_intelligence.sql 2>&1); echo "$out" | grep -E "^(GATE|INFO|on$)"
if echo "$out" | grep -E "^GATE" | grep -qv "PASS"; then echo "VERIFY: at least one GATE is not PASS -- STOP and report; do not continue to B3"; exit 1; fi
echo "B2 DONE: migrations 0500, 0600, 0700 applied and verified. Next: hosted-verify.sh against the live (old) build, then wait for the B3a approval."
