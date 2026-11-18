#!/usr/bin/env bash
# Smoke of the Intelligence screens against the HOSTED database through a STAGED deployment of this project (Vercel Deployment Protection bypass
# secret read from the project settings into a shell variable: never printed or written) or through a local dev server on loopback.
#   STAGED_URL=https://clearspace-<id>-bng-dev-alt-webadvisor.vercel.app PW_CHROMIUM_PATH=... frontend/scripts/staged-intelligence-smoke.sh
# Creates 2 DISPOSABLE confirmed accounts through the GoTrue admin API (service-role key from the Supabase CLI into a variable), drives the real UI (login, board,
# Porady, create a meeting from pasted text, "Analyzovat" and the project brief must answer with the AI-disabled message after a firewall 403), checks RLS over HTTP,
# then DELETES the accounts. The deletion of an account that created a meeting is itself the regression check of migration 0900: it must answer 200.
# Afterwards the leftovers are counted with the DB password from the macOS Keychain; anything left = exit 1.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REF=twjlnsxjtuntujarwner; URL=https://$REF.supabase.co; HERE=$(pwd)
BASE=${STAGED_URL:?set STAGED_URL (a staged deployment of this project, or http://127.0.0.1:<port> for a local server)}
V=${VERCEL_BIN:-/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel}; SCOPE=${VERCEL_SCOPE:-bng-dev-alt-webadvisor}; PROJ=prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg
case "$BASE" in
  http://127.0.0.1:*|http://localhost:*) BYPASS=none;;
  https://clearspace-[a-z0-9]*-bng-dev-alt-webadvisor.vercel.app)
    BYPASS=$("$V" api "/v9/projects/$PROJ" --scope "$SCOPE" 2>/dev/null | python3 -c "import json,sys; print(next(iter(json.load(sys.stdin)['protectionBypass'])))") || BYPASS=""
    [ -n "$BYPASS" ] || { echo "no protection-bypass secret available for the staged URL"; exit 2;};;
  *) echo "refusing STAGED_URL $BASE (a staged deployment of this project or a loopback server only)"; exit 2;;
esac
KEYS=$(supabase projects api-keys --project-ref $REF --workdir "${TMPDIR:-/tmp}" --output-format json)
SRK=$(echo "$KEYS" | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='service_role'))")
ANON=$(echo "$KEYS" | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='anon'))")
[ -n "$SRK" ] && [ -n "$ANON" ] || { echo "no API keys"; exit 2; }
RUN=$(date +%s); PW="Cs!$(openssl rand -hex 10)"; IDS=(); DEL_BAD=0
mk() { curl -s -X POST "$URL/auth/v1/admin/users" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"P5 smoke\"}}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))'; }
cleanup() {
  echo "== cleanup: deleting exactly the accounts of this run"
  for id in "${IDS[@]:-}"; do [ -n "$id" ] || continue; c=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL/auth/v1/admin/users/$id" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"); echo "  delete ${id:0:8} -> $c"; [ "$c" = 200 ] || DEL_BAD=1; done
  L=$(PGPASSWORD=$(security find-generic-password -s "ClearSpace V1 – Supabase Database" -a "postgres.$REF" -w 2>/dev/null) docker run --rm -e PGPASSWORD public.ecr.aws/supabase/postgres:17.6.1.147 psql "host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" -X -At -c "select 'users='||(select count(*) from auth.users where email like 'cs-p5-%@example.test')||' projects='||(select count(*) from public.projects)||' meetings='||(select count(*) from public.meetings)||' transcripts='||(select count(*) from public.meeting_transcripts)||' runs='||(select count(*) from public.intelligence_runs)||' items='||(select count(*) from public.intelligence_items)||' ai_requests='||(select count(*) from public.ai_requests)||' stt_jobs='||(select count(*) from public.stt_jobs)")
  echo "leftovers: $L"
  case "$L" in "users=0 projects=1 meetings=0 transcripts=0 runs=0 items=0 ai_requests=0 stt_jobs=0") ;; *) DEL_BAD=1;; esac
  [ "$DEL_BAD" = 0 ] && echo "CLEANUP OK: accounts deleted (HTTP 200, including the one that created a meeting) and nothing left" || echo "CLEANUP PROBLEM: see above (exit 1)"
}
trap cleanup EXIT
A=cs-p5-sa-$RUN@example.test; B=cs-p5-sb-$RUN@example.test
IDS+=("$(mk $A)"); IDS+=("$(mk $B)"); for id in "${IDS[@]}"; do [ -n "$id" ] || { echo "account creation failed"; exit 1; }; done
BASE=$BASE BYPASS=$BYPASS SB=$URL ANON=$ANON A=$A B=$B PW=$PW node "$HERE/scripts/staged-intelligence-smoke.mjs"; RC=$?
[ "$RC" = 0 ] || exit "$RC"
trap - EXIT; cleanup; [ "$DEL_BAD" = 0 ]
