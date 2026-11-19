#!/usr/bin/env bash
# Real-application verification against the HOSTED "ClearSpace V1" project (see e2e/supabase-hosted.spec.ts).
#
#  * needs a dev server on loopback WITHOUT a Gemini key:  AI_ALLOW_ALL_AUTHENTICATED=1 npm run dev -- -p 3410 -H 127.0.0.1
#    (or BASE_URL=https://clearspace-ai.vercel.app PRODUCTION_SMOKE_OK=1 for the post-promote smoke: AI routes are then
#     expected to answer 403 from the firewall and are never called with a real request)
#  * creates 3 DISPOSABLE accounts (A, B confirmed; D unconfirmed) through the GoTrue admin API. The service-role
#    key comes from the Supabase CLI into a shell variable: never printed, never written to disk, never passed
#    to the test process.
#  * runs the Realtime check and the Playwright spec, then DELETES exactly those accounts by id and verifies with
#    the DB password from the macOS Keychain that no data of this run is left.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REF=twjlnsxjtuntujarwner
BASE=${BASE_URL:-http://127.0.0.1:3410}
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-); ANON=$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
[ "$URL" = "https://$REF.supabase.co" ] || { echo "refusing: .env.local does not point at $REF"; exit 2; }
# AI_MODE tells the spec what the AI routes must do: local dev server without a key -> 503 (fail closed);
# the PRODUCTION domain (only with PRODUCTION_SMOKE_OK=1) while the firewall deny is active -> 403 and NO provider call.
case "$BASE" in
  http://127.0.0.1:*|http://localhost:*) AI_MODE=local;;
  https://clearspace-ai.vercel.app) [ "${PRODUCTION_SMOKE_OK:-}" = 1 ] || { echo "refusing the production domain without PRODUCTION_SMOKE_OK=1"; exit 2; }; AI_MODE=firewall;;
  # a STAGED deployment of this project (protected by Vercel Deployment Protection): needs the bypass secret in STAGED_BYPASS_SECRET
  https://clearspace-[a-z0-9]*-bng-dev-alt-webadvisor.vercel.app)
    [ "${PRODUCTION_SMOKE_OK:-}" = 1 ] && [ -n "${STAGED_BYPASS_SECRET:-}" ] || { echo "refusing the staged URL without PRODUCTION_SMOKE_OK=1 and STAGED_BYPASS_SECRET"; exit 2; }; AI_MODE=firewall; E2E_BYPASS_SECRET=$STAGED_BYPASS_SECRET; export E2E_BYPASS_SECRET;;
  *) echo "refusing BASE_URL $BASE (only loopback, the production domain, or a staged deployment of this project, with PRODUCTION_SMOKE_OK=1)"; exit 2;;
esac
curl -s -o /dev/null ${E2E_BYPASS_SECRET:+-H "x-vercel-protection-bypass: $E2E_BYPASS_SECRET"} "$BASE/login" || { echo "no server at $BASE"; exit 2; }
SRK=$(supabase projects api-keys --project-ref "$REF" --workdir "${TMPDIR:-/tmp}" --output-format json | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='service_role'))")
[ -n "$SRK" ] || { echo "no service key"; exit 2; }
RUN=$(date +%s); PW="Cs!$(openssl rand -hex 10)"
IDS=()
mkuser() { # email confirm(true|false)
  curl -s -X POST "$URL/auth/v1/admin/users" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":$2,\"user_metadata\":{\"display_name\":\"P5 ${1%%@*}\"}}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))'; }
cleanup() {
  echo "== cleanup: deleting exactly the accounts created by this run"
  for id in "${IDS[@]:-}"; do [ -n "$id" ] && printf '  delete %s -> %s\n' "${id:0:8}" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL/auth/v1/admin/users/$id" -H "apikey: $SRK" -H "Authorization: Bearer $SRK")"; done
  PGPASSWORD=$(security find-generic-password -s "ClearSpace V1 – Supabase Database" -a "postgres.$REF" -w 2>/dev/null) \
  docker run --rm -e PGPASSWORD public.ecr.aws/supabase/postgres:17.6.1.147 psql "host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" -X -At -c \
   "select 'leftovers: run-users='||(select count(*) from auth.users where email like 'cs-p5-%@example.test')||' projects='||(select count(*) from public.projects)||' cards='||(select count(*) from public.cards)||' invitations='||(select count(*) from public.invitations)||' workspace_members='||(select count(*) from public.workspace_members where email like 'cs-p5-%')||' ai_requests='||(select count(*) from public.ai_requests)"
}
trap cleanup EXIT
A=cs-p5-a-$RUN@example.test; B=cs-p5-b-$RUN@example.test; D=cs-p5-d-$RUN@example.test
IDS+=("$(mkuser "$A" true)"); IDS+=("$(mkuser "$B" true)"); IDS+=("$(mkuser "$D" false)")
for id in "${IDS[@]}"; do [ -n "$id" ] || { echo "account creation failed"; exit 1; }; done
echo "== accounts created (3, disposable)"
rc=0
echo "== Realtime check (hosted)"
RT_URL=$URL RT_ANON=$ANON RT_A_EMAIL=$A RT_A_PASS=$PW RT_B_EMAIL=$B RT_B_PASS=$PW node supabase/tests/realtime_check.mjs || rc=1
echo "== Playwright (hosted, real UI)"
E2E_AI_MODE=$AI_MODE E2E_HOSTED=1 E2E_HOSTED_URL=$URL E2E_HOSTED_ANON=$ANON E2E_PASSWORD=$PW E2E_A_EMAIL=$A E2E_B_EMAIL=$B E2E_D_EMAIL=$D PLAYWRIGHT_TEST_BASE_URL=$BASE \
  npx playwright test e2e/supabase-hosted.spec.ts --workers=1 || rc=1
exit $rc
