#!/usr/bin/env bash
# BOUNDED AI validation (release step R11). At most N (default 3, hard cap 4) requests can reach the AI provider.
#
#   local dry run (no Gemini key, nothing leaves the machine):
#     AI_RATE_PER_USER_PER_MINUTE=3 npm run dev -- -p 3410 -H 127.0.0.1      # in another terminal, GEMINI_API_KEY empty
#     EXPECT_STATUSES=503,503,503,429 scripts/ai-bounded-test.sh
#   production (ONLY after the owner relaxed the firewall for their own IP; makes REAL Gemini calls):
#     BASE_URL=https://clearspace-ai.vercel.app CONFIRM_REAL_GEMINI_CALLS=3 scripts/ai-bounded-test.sh
#
# What it does: creates two DISPOSABLE confirmed accounts (admin API, key only in a shell variable), a one-card project
# for A, then: no token -> 401 (no provider call); B on A's project -> 403 (no provider call); A sends N improve
# requests; one more must be rate limited (429, no provider call). Prints statuses, the ledger rows (status, tokens)
# and the number of rows to compare with the Google usage graph. Deletes exactly its accounts afterwards.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REF=twjlnsxjtuntujarwner
BASE=${BASE_URL:-http://127.0.0.1:3410}
N=${N_REAL:-3}
[ "$N" -ge 1 ] && [ "$N" -le 4 ] || { echo "N_REAL must be 1..4"; exit 2; }
case "$BASE" in
  http://127.0.0.1:*|http://localhost:*) REAL=0;;
  https://clearspace-ai.vercel.app)
    [ "${CONFIRM_REAL_GEMINI_CALLS:-}" = "$N" ] || { echo "refusing: set CONFIRM_REAL_GEMINI_CALLS=$N to confirm $N REAL Gemini calls"; exit 2; }; REAL=1;;
  *) echo "refusing BASE_URL $BASE"; exit 2;;
esac
if [ "$REAL" = 1 ]; then EXPECT=${EXPECT_STATUSES:-$(python3 -c "print(','.join(['200']*$N+['429']))")}; else EXPECT=${EXPECT_STATUSES:-$(python3 -c "print(','.join(['503']*$N+['429']))")}; fi
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-); ANON=$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
[ "$URL" = "https://$REF.supabase.co" ] || { echo "refusing: .env.local does not point at $REF"; exit 2; }
SRK=$(supabase projects api-keys --project-ref "$REF" --workdir "${TMPDIR:-/tmp}" --output-format json | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='service_role'))")
[ -n "$SRK" ] || { echo "no service key"; exit 2; }
RUN=$(date +%s); PW="Ai!$(openssl rand -hex 10)"; IDS=()
mkuser() { curl -s -X POST "$URL/auth/v1/admin/users" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\",\"email_confirm\":true}" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))'; }
cleanup() {
  for id in "${IDS[@]:-}"; do [ -n "$id" ] && printf 'cleanup: delete account %s -> %s\n' "${id:0:8}" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$URL/auth/v1/admin/users/$id" -H "apikey: $SRK" -H "Authorization: Bearer $SRK")"; done
}
trap cleanup EXIT
A=cs-ai-a-$RUN@example.test; B=cs-ai-b-$RUN@example.test
IDS+=("$(mkuser "$A")"); IDS+=("$(mkuser "$B")")
for id in "${IDS[@]}"; do [ -n "$id" ] || { echo "account creation failed"; exit 1; }; done
tok() { curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'; }
TA=$(tok "$A"); TB=$(tok "$B")
rest() { curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/rest/v1/$1" -H "apikey: $ANON" -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' -d "$2"; }
P="ai-p-$RUN"
J1=$(python3 -c "import json;print(json.dumps({'id':'$P','name':'AI bounded test'}))")
J2=$(python3 -c "import json;print(json.dumps({'id':'$P-c','project_id':'$P','name':'Todo','position':0}))")
J3=$(python3 -c "import json;print(json.dumps({'id':'$P-k','column_id':'$P-c','title':'Write a status note'}))")
c1=$(rest projects "$J1"); c2=$(rest columns "$J2"); c3=$(rest cards "$J3")
[ "$c1$c2$c3" = "201201201" ] || { echo "seeding failed ($c1 $c2 $c3)"; exit 1; }
BODY=$(python3 -c "import json;print(json.dumps({'projectId':'$P','card':{'id':'k','title':'Write a status note','details':''}}))")
call() { curl -4 -s -o "${TMPDIR:-/tmp}/ai_last.json" -w '%{http_code}' -X POST "$BASE/api/ai/improve" -H 'Content-Type: application/json' ${1:+-H "Authorization: Bearer $1"} -d "$BODY"; }
fail=0
echo "== no provider call expected"
s=$(call ""); [ "$s" = 401 ] && echo "ok - no token -> 401" || { echo "FAIL - no token -> $s"; fail=1; }
s=$(call "$TB"); [ "$s" = 403 ] && echo "ok - stranger on A's project -> 403" || { echo "FAIL - stranger -> $s"; fail=1; }
echo "== A sends $N request(s) that may reach the provider, then one over the limit (expected: $EXPECT)"
got=()
for i in $(seq 1 "$N"); do got+=("$(call "$TA")"); python3 -c "
import json; d=json.load(open('${TMPDIR:-/tmp}/ai_last.json')); print('  request $i ->', {k:d.get(k) for k in ('code','model') if k in d}, 'usage:', d.get('usage'))" 2>/dev/null; done
got+=("$(call "$TA")")
GOT=$(IFS=,; echo "${got[*]}"); echo "statuses: $GOT"
[ "$GOT" = "$EXPECT" ] && echo "ok - statuses match" || { echo "FAIL - expected $EXPECT"; fail=1; }
echo "== ledger rows of A (compare the count with the Google usage graph)"
curl -s "$URL/rest/v1/ai_requests?select=feature,status,error_code,model,total_tokens&order=created_at" -H "apikey: $ANON" -H "Authorization: Bearer $TA" | python3 -c "
import sys,json; r=json.load(sys.stdin); print('rows:',len(r)); [print(' ',x) for x in r]"
[ $fail = 0 ] && echo "AI BOUNDED TEST PASSED" || echo "AI BOUNDED TEST FAILED"
exit $fail
