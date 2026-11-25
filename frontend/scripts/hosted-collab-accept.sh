#!/usr/bin/env bash
# RUN 01C: invitation acceptance on the PRODUCTION stack with two DISPOSABLE confirmed accounts (@example.test, no e-mail is
# ever sent: reserved domains are suppressed). Creates the accounts through the GoTrue admin API (service key stays in a shell
# variable, never reaches the test process), runs e2e/collaboration-01c-hosted.spec.ts, deletes exactly those accounts.
#   BASE_URL=https://clearspace-ai.vercel.app PRODUCTION_SMOKE_OK=1 frontend/scripts/hosted-collab-accept.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REF=twjlnsxjtuntujarwner; URL=https://$REF.supabase.co
BASE=${BASE_URL:-}; [ "$BASE" = https://clearspace-ai.vercel.app ] && [ "${PRODUCTION_SMOKE_OK:-}" = 1 ] || { echo "refusing: BASE_URL must be the production domain and PRODUCTION_SMOKE_OK=1"; exit 2; }
KEYS=$(supabase projects api-keys --project-ref "$REF" --workdir "${TMPDIR:-/tmp}" --output-format json 2>/dev/null)
pick() { printf '%s' "$KEYS" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d['keys'] if isinstance(d,dict) else d;print(next(k['api_key'] for k in d if k['name']=='$1'))"; }
ANON=$(pick anon); SRK=$(pick service_role); unset KEYS
[ -n "$ANON" ] && [ -n "$SRK" ] || { echo "no keys"; exit 2; }
RUN=$(date +%s); PW="Cs!$(openssl rand -hex 10)"; A=cs-hc-a-$RUN@example.test; B=cs-hc-b-$RUN@example.test; IDS=()
mk() { curl -s -X POST "$URL/auth/v1/admin/users" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"$2\"}}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))'; }
cleanup() { for id in "${IDS[@]:-}"; do [ -n "$id" ] && echo "  delete ${id:0:8} -> $(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL/auth/v1/admin/users/$id" -H "apikey: $SRK" -H "Authorization: Bearer $SRK")"; done; }
trap cleanup EXIT
IDS+=("$(mk "$A" 'Olga Zkušební')"); IDS+=("$(mk "$B" 'Bára Zkušební')")
for id in "${IDS[@]}"; do [ -n "$id" ] || { echo "account creation failed"; exit 1; }; done
echo "== 2 disposable accounts created"
E2E_HOSTED_COLLAB=1 E2E_HOSTED_URL=$URL E2E_HOSTED_ANON=$ANON E2E_PASSWORD=$PW E2E_A_EMAIL=$A E2E_B_EMAIL=$B PLAYWRIGHT_TEST_BASE_URL=$BASE \
  npx playwright test e2e/collaboration-01c-hosted.spec.ts --workers=1 2>&1 | node scripts/redact-secrets.mjs
