#!/usr/bin/env bash
# Storage API behaviour against a REAL local Supabase stack (real GoTrue + Storage API + Kong): privacy of the
# bucket, membership policies, size and MIME limits, signed URLs. THROWAWAY stack only -- it applies the schema
# (as the non-superuser `postgres`) and creates users there.
#
#   DB_CONTAINER=supabase_db_<project> API_URL=http://127.0.0.1:<port> ANON_KEY=<local anon key> \
#   SERVICE_ROLE_KEY=<local service key> frontend/supabase/tests/storage_real_stack.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; FRONTEND="$(cd "$HERE/../.." && pwd)"
: "${DB_CONTAINER:?}"; : "${API_URL:?}"; : "${ANON_KEY:?}"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local API_URL"; exit 2;; esac
psql_pg() { docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS='-c client_min_messages=warning' "$DB_CONTAINER" psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
run="$(date +%s)"; fail=0
ok() { echo "ok - $1"; }; bad() { echo "FAIL - $1"; fail=1; }
expect() { # name expected-status-regex actual
  if [[ "$3" =~ ^($2)$ ]]; then ok "$1 (HTTP $3)"; else bad "$1: expected $2, got $3"; fi; }
http() { curl -s -o "${OUT:-/dev/null}" -w '%{http_code}' "$@"; }

echo "== apply baseline + migrations as role postgres (non-superuser)"
psql_pg -c "select 'postgres is superuser: ' || rolsuper from pg_roles where rolname = current_user" -At
# A hosted project grants new public tables to the API roles through default privileges of role postgres
# (inspect_hosted.sql section 9). The local CLI stack only does so for supabase_admin, so replicate the hosted
# defaults first -- otherwise nothing the app does would be allowed and every negative check below would be vacuous.
psql_pg -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
            ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;"
psql_pg --single-transaction -f - < "$FRONTEND/supabase_schema.sql" >/dev/null
for f in "$FRONTEND"/supabase/migrations/*.sql; do psql_pg --single-transaction -f - < "$f" >/dev/null; done
psql_pg -c "NOTIFY pgrst, 'reload schema'" ; sleep 3   # PostgREST must see the new tables/functions
psql_pg -At -c "select 'bucket: public=' || public || ' limit=' || file_size_limit from storage.buckets where id='task-resources'"

signup() { curl -s -X POST "$API_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"Test-Password-123\"}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["access_token"])'; }
TA=$(signup "stor-a-$run@example.test"); TB=$(signup "stor-b-$run@example.test")
rest() { # token method path [data]
  local a=(); [ -n "${4:-}" ] && a=(-d "$4")
  curl -s -X "$2" "$API_URL/rest/v1/$3" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' ${a[@]+"${a[@]}"} -o /dev/null -w '%{http_code}'; }
P="stp-$run"; K="$P-k1"; KB="$P-kb"
j() { python3 -c 'import json,sys; print(json.dumps(dict(a.split("=",1) for a in sys.argv[1:]) | ({"position":0} if any(x.startswith("project_id=") for x in sys.argv[1:]) else {})))' "$@"; }
J_PROJ=$(j "id=$P" "name=Storage"); J_COL=$(j "id=$P-c" "project_id=$P" "name=Todo"); J_CARD=$(j "id=$K" "column_id=$P-c" "title=T")
expect "A creates project" 201 "$(rest "$TA" POST projects "$J_PROJ")"
expect "A creates column" 201 "$(rest "$TA" POST columns "$J_COL")"
expect "A creates card" 201 "$(rest "$TA" POST cards "$J_CARD")"
PB="stpb-$run"
expect "B creates own project" 201 "$(rest "$TB" POST projects "$(j "id=$PB" "name=B")")"
rest "$TB" POST columns "$(j "id=$PB-c" "project_id=$PB" "name=Todo")" >/dev/null
rest "$TB" POST cards "$(j "id=$KB" "column_id=$PB-c" "title=B")" >/dev/null

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'PY'
import sys,os,struct,zlib
d=sys.argv[1]
def png():
    def ch(t,b): c=struct.pack('>I',len(b))+t+b; return c+struct.pack('>I',zlib.crc32(t+b)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+ch(b'IDAT',zlib.compress(b'\x00\xff\x00\x00'))+ch(b'IEND',b'')
open(d+'/ok.png','wb').write(png())
open(d+'/big.png','wb').write(png()+b'\0'*(11*1024*1024))
open(d+'/x.html','w').write('<script>alert(1)</script>')
open(d+'/x.svg','w').write('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
PY
upload() { # token path file mime
  curl -s -X POST "$API_URL/storage/v1/object/task-resources/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H "Content-Type: $4" --data-binary "@$3" -o "$TMP/last" -w '%{http_code}'; }

reason() { grep -qi -- "$1" "$TMP/last" && ok "  ...for the right reason ($1)" || { bad "  ...wrong reason, body: $(head -c 160 "$TMP/last")"; }; }
echo "== uploads"
expect "member uploads a PNG to tasks/<own card>/" 200 "$(upload "$TA" "tasks/$K/res-1.png" "$TMP/ok.png" image/png)"
expect "non-member cannot upload to a foreign card" "400|401|403" "$(upload "$TB" "tasks/$K/evil.png" "$TMP/ok.png" image/png)"
reason "row-level security"
expect "member cannot upload outside tasks/<card>/" "400|401|403" "$(upload "$TA" "elsewhere/x.png" "$TMP/ok.png" image/png)"
reason "row-level security"
expect "member cannot write into another user's card path" "400|401|403" "$(upload "$TA" "tasks/$KB/x.png" "$TMP/ok.png" image/png)"
reason "row-level security"
expect "file over 10 MiB is refused" "400|413" "$(upload "$TA" "tasks/$K/big.png" "$TMP/big.png" image/png)"
reason "exceeded the maximum allowed size"
expect "text/html is refused (MIME allow-list)" "400|415" "$(upload "$TA" "tasks/$K/x.html" "$TMP/x.html" text/html)"
reason "mime type"
expect "image/svg+xml is refused (script-capable)" "400|415" "$(upload "$TA" "tasks/$K/x.svg" "$TMP/x.svg" image/svg+xml)"
reason "mime type"
expect "anon (no session) cannot upload" "400|401|403" "$(upload "$ANON_KEY" "tasks/$K/anon.png" "$TMP/ok.png" image/png)"
expect "same path twice (no upsert) is refused" "400|409" "$(upload "$TA" "tasks/$K/res-1.png" "$TMP/ok.png" image/png)"

echo "== reads"
get() { curl -s -o "${OUT:-/dev/null}" -w '%{http_code}' "$@"; }
expect "public URL of a private bucket does not serve the file" "400|401|404" "$(get "$API_URL/storage/v1/object/public/task-resources/tasks/$K/res-1.png")"
expect "member reads via authenticated endpoint" 200 "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/storage/v1/object/authenticated/task-resources/tasks/$K/res-1.png")"
expect "non-member cannot read it" "400|401|403|404" "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" "$API_URL/storage/v1/object/authenticated/task-resources/tasks/$K/res-1.png")"
expect "anon cannot read it" "400|401|403|404" "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" "$API_URL/storage/v1/object/authenticated/task-resources/tasks/$K/res-1.png")"
OUT="$TMP/list" expect "non-member cannot list the card's folder (empty)" 200 "$(curl -s -X POST "$API_URL/storage/v1/object/list/task-resources" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" -H 'Content-Type: application/json' -d "{\"prefix\":\"tasks/$K\"}" -o "$TMP/list" -w '%{http_code}')"
[ "$(python3 -c "import json;print(len(json.load(open('$TMP/list'))))")" = 0 ] && ok "foreign list returned no objects" || bad "non-member listing leaked objects"

echo "== signed URLs"
sign() { curl -s -X POST "$API_URL/storage/v1/object/sign/task-resources/tasks/$K/res-1.png" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d '{"expiresIn":60}' -o "$TMP/sign" -w '%{http_code}'; }
expect "member can create a signed URL" 200 "$(sign "$TA")"
SURL=$(python3 -c "import json;d=json.load(open('$TMP/sign'));print(d.get('signedURL') or d.get('signedUrl') or '')")
case "$SURL" in /*) SURL="$API_URL/storage/v1${SURL}";; esac
expect "signed URL serves the file without credentials" 200 "$(get "$SURL")"
expect "tampered signed URL is refused" "400|401|403|404" "$(get "${SURL%?}X")"
expect "non-member cannot create a signed URL" "400|401|403|404" "$(sign "$TB")"

echo "== delete"
curl -s -X DELETE "$API_URL/storage/v1/object/task-resources/tasks/$K/res-1.png" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" -o /dev/null
expect "file survives a non-member delete attempt" 200 "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/storage/v1/object/authenticated/task-resources/tasks/$K/res-1.png")"
expect "member can delete" 200 "$(curl -s -X DELETE "$API_URL/storage/v1/object/task-resources/tasks/$K/res-1.png" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -o /dev/null -w '%{http_code}')"
expect "file is gone" "400|404" "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/storage/v1/object/authenticated/task-resources/tasks/$K/res-1.png")"

[ $fail = 0 ] && echo "ALL STORAGE CHECKS PASSED" || { echo "STORAGE CHECKS FAILED"; exit 1; }
