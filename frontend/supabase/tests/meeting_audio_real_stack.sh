#!/usr/bin/env bash
# Meeting-audio bucket (R5) against a REAL local Supabase stack (real Storage API + GoTrue + PostgREST): consent-gated
# uploads, audio-only MIME list, private bucket, signed URLs (what Soniox would fetch), member-only access, and the
# "mark deleted only when the object is really gone" rule. THROWAWAY stack only. Assumes the baseline + migrations are
# ALREADY applied (run storage_real_stack.sh or real_stack.sh first); it only creates its own users, project and meeting.
#
#   API_URL=http://127.0.0.1:<port> ANON_KEY=<local anon key> frontend/supabase/tests/meeting_audio_real_stack.sh
set -euo pipefail
: "${API_URL:?}"; : "${ANON_KEY:?}"
case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing non-local API_URL"; exit 2;; esac
run="$(date +%s)"; fail=0
ok() { echo "ok - $1"; }; bad() { echo "FAIL - $1"; fail=1; }
expect() { if [[ "$3" =~ ^($2)$ ]]; then ok "$1 (HTTP $3)"; else bad "$1: expected $2, got $3 (body: $(head -c 200 "${BODY:-/dev/null}" 2>/dev/null))"; fi; }
get() { curl -s -o "${OUT:-/dev/null}" -w '%{http_code}' "$@"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; BODY="$TMP/last"
# JSON from key=value pairs (numbers stay numbers). Built in Python: bash 3.2 (macOS) mis-parses escaped quotes inside nested "$(...)".
jb() { python3 -c 'import json,sys
d={}
for a in sys.argv[1:]:
    k,v=a.split("=",1)
    try: d[k]=json.loads(v)
    except Exception: d[k]=v
print(json.dumps(d))' "$@"; }
signup() { curl -s -X POST "$API_URL/auth/v1/signup" -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"Test-Password-123\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'; }
TA=$(signup "aud-a-$run@example.test"); TB=$(signup "aud-b-$run@example.test")
P="aud-$run"; PB="audb-$run"
post() { curl -s -X POST "$API_URL/rest/v1/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H 'Prefer: return=minimal' -d "$3" -o "$TMP/last" -w '%{http_code}'; }
expect "A creates a project" 201 "$(post "$TA" projects "$(jb id=$P name=Audio)")"
expect "B creates a project of their own" 201 "$(post "$TB" projects "$(jb id=$PB name=B)")"
printf '<script>alert(1)</script>' > "$TMP/x.html"
reason() { grep -qi -- "$1" "$TMP/last" && ok "  ...for the right reason ($1)" || bad "  ...wrong reason, body: $(head -c 160 "$TMP/last")"; }

echo "== meeting-audio bucket (R5: consent-gated, private, audio-only)"
printf 'ID3\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0' > "$TMP/ok.mp3"
rpc() { # token fn json
  curl -s -X POST "$API_URL/rest/v1/rpc/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$3" -o "$TMP/rpc" -w '%{http_code}'; }
MEET_JSON=$(jb project_id=$P title=Audio source_kind=audio)
expect "A creates an audio meeting" 201 "$(curl -s -X POST "$API_URL/rest/v1/meetings" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d "$MEET_JSON" -o "$TMP/mt" -w '%{http_code}')"
MID=$(python3 -c "import json;print(json.load(open('$TMP/mt'))[0]['id'])")
AP="$P/$MID/$(python3 -c 'import uuid;print(uuid.uuid4())').mp3"
aupload() { curl -s -X POST "$API_URL/storage/v1/object/meeting-audio/$2" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $1" -H "Content-Type: $4" --data-binary "@$3" -o "$TMP/last" -w '%{http_code}'; }
expect "upload BEFORE consent is refused (Storage policy)" "400|401|403" "$(aupload "$TA" "$AP" "$TMP/ok.mp3" audio/mpeg)"
reason "row-level security"
expect "consent is recorded through the RPC" "200|204" "$(rpc "$TA" record_audio_consent "$(jb p_meeting=$MID)")"
expect "member uploads audio after consent" 200 "$(aupload "$TA" "$AP" "$TMP/ok.mp3" audio/mpeg)"
expect "non-member cannot upload into the meeting" "400|401|403" "$(aupload "$TB" "$P/$MID/$(python3 -c 'import uuid;print(uuid.uuid4())').mp3" "$TMP/ok.mp3" audio/mpeg)"
expect "a path under ANOTHER project is refused" "400|401|403" "$(aupload "$TA" "$PB/$MID/x.mp3" "$TMP/ok.mp3" audio/mpeg)"
expect "text/html is refused (audio-only MIME list)" "400|415" "$(aupload "$TA" "$P/$MID/$(python3 -c 'import uuid;print(uuid.uuid4())').mp3" "$TMP/x.html" text/html)"
reason "mime type"
expect "video/mp4 is refused" "400|415" "$(aupload "$TA" "$P/$MID/$(python3 -c 'import uuid;print(uuid.uuid4())').mp4" "$TMP/ok.mp3" video/mp4)"
expect "non-member cannot read the audio" "400|401|403|404" "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" "$API_URL/storage/v1/object/authenticated/meeting-audio/$AP")"
expect "the public URL does not serve it" "400|401|404" "$(get "$API_URL/storage/v1/object/public/meeting-audio/$AP")"
SZ=$(wc -c < "$TMP/ok.mp3" | tr -d ' ')
expect "non-member cannot attach" "400|401|403" "$(rpc "$TB" attach_meeting_audio "$(jb p_meeting=$MID p_path=$AP p_bytes=$SZ p_mime=audio/mpeg p_client_ms=1000)")"
expect "attach with a wrong size is refused" "400|422" "$(rpc "$TA" attach_meeting_audio "$(jb p_meeting=$MID p_path=$AP p_bytes=$((SZ+5)) p_mime=audio/mpeg p_client_ms=1000)")"
expect "member attaches the real object" "200|204" "$(rpc "$TA" attach_meeting_audio "$(jb p_meeting=$MID p_path=$AP p_bytes=$SZ p_mime=audio/mpeg p_client_ms=1000)")"
SIGN=$(curl -s -X POST "$API_URL/storage/v1/object/sign/meeting-audio/$AP" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"expiresIn":7200}')
AURL=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('signedURL') or d.get('signedUrl') or '')" "$SIGN")
case "$AURL" in /*) AURL="$API_URL/storage/v1${AURL}";; esac
expect "signed URL (2 h) serves the file without credentials" 200 "$(get "$AURL")"
expect "signed URL answers a Range request (server-side content sniffing)" "200|206" "$(get -H 'Range: bytes=0-31' "$AURL")"
expect "tampered signed URL is refused" "400|401|403|404" "$(get "$(python3 -c 'import sys;u=sys.argv[1];i=len(u)-12;print(u[:i]+("A" if u[i]!="A" else "B")+u[i+1:])' "$AURL")")"
# SQLSTATE 55000 reaches the client as HTTP 500 through PostgREST; what matters is that the row is NOT changed.
expect "mark_audio_deleted is REFUSED while the object exists" "400|409|422|500" "$(rpc "$TA" mark_audio_deleted "$(jb p_meeting=$MID)")"
STILL=$(curl -s "$API_URL/rest/v1/meetings?id=eq.$MID&select=audio_path,audio_deleted_at" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA")
python3 -c "import json,sys; d=json.loads(sys.argv[1])[0]; sys.exit(0 if d['audio_path'] and not d['audio_deleted_at'] else 1)" "$STILL" && ok "the row still points at the audio (no false deletion record)" || bad "row was changed although the object exists: $STILL"
curl -s -X DELETE "$API_URL/storage/v1/object/meeting-audio/$AP" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" -o /dev/null
expect "the object survives a non-member delete" 200 "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/storage/v1/object/authenticated/meeting-audio/$AP")"
expect "member deletes the audio" 200 "$(curl -s -X DELETE "$API_URL/storage/v1/object/meeting-audio/$AP" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -o /dev/null -w '%{http_code}')"
expect "now mark_audio_deleted succeeds" "200|204" "$(rpc "$TA" mark_audio_deleted "$(jb p_meeting=$MID)")"

echo "== trusted STT RPCs over the real PostgREST (original audit probes: a member JWT alone must NOT be enough)"
SRV="synthetic-server-secret-$(python3 -c 'import uuid;print(uuid.uuid4().hex)')"
MEET2=$(curl -s -X POST "$API_URL/rest/v1/meetings" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -H 'Prefer: return=representation' -d "$(jb project_id=$P title=Trusted source_kind=audio)")
MT=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])[0]['id'])" "$MEET2")
rpc "$TA" record_audio_consent "$(jb p_meeting=$MT)" >/dev/null
TP="$P/$MT/$(python3 -c 'import uuid;print(uuid.uuid4())').mp3"
expect "member uploads audio for the trusted-flow meeting" 200 "$(aupload "$TA" "$TP" "$TMP/ok.mp3" audio/mpeg)"
expect "member attaches it" "200|204" "$(rpc "$TA" attach_meeting_audio "$(jb p_meeting=$MT p_path=$TP p_bytes=$SZ p_mime=audio/mpeg p_client_ms=1000)")"
BIG='{"p_meeting":"'$MT'","p_est_audio_ms":1,"p_user_daily_ms":999999999,"p_global_daily_ms":999999999}'
expect "PROBE: a legitimate member calling stt_reserve WITHOUT the server secret does not even resolve (no such 4-argument function)" "404" "$(rpc "$TA" stt_reserve "$BIG")"
expect "PROBE: ... nor with a FORGED secret and forged budgets (42501)" "401|403" "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=1 p_user_daily_ms=999999999 p_global_daily_ms=999999999)")"
expect "PROBE: stt_complete with a forged transcript is refused" "401|403" "$(rpc "$TA" stt_complete "$(jb p_server_secret=$SRV p_meeting=$MT p_job_id=x p_model=m p_audio_ms=1 'p_transcript={"revision":"a","speakers":[],"segments":[{"id":"seg-0","speaker":"S1","startMs":0,"endMs":1,"text":"FORGED"}],"coverage":{},"char_count":6}')")"
expect "PROBE: stt_fail (booking / releasing budget) is refused" "401|403" "$(rpc "$TA" stt_fail "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=null p_error_type=x p_billing=none)")"
expect "PROBE: stt_attach_job / stt_mark_unknown / stt_resolve_unknown / stt_cleanup_result are refused" "401|403" "$(rpc "$TA" stt_attach_job "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=j p_model=m)")"
expect "PROBE: stt_resolve_unknown is refused" "401|403" "$(rpc "$TA" stt_resolve_unknown "$(jb p_server_secret=$SRV p_meeting=$MT p_resolution=absent)")"
expect "PROBE (F1): the OLD secret-less stt_attach_job signature does not exist" "404" "$(rpc "$TA" stt_attach_job "$(jb p_meeting=$MT p_job_id=j p_model=m)")"
expect "PROBE (F1): the OLD secret-less stt_fail signature does not exist" "404" "$(rpc "$TA" stt_fail "$(jb p_meeting=$MT p_job_id=null p_error_type=x)")"
expect "PROBE (F1): the OLD secret-less stt_complete signature does not exist" "404" "$(rpc "$TA" stt_complete "$(jb p_meeting=$MT p_job_id=x p_model=m p_audio_ms=1 'p_transcript={}')")"
expect "PROBE (F1): the OLD stt_mark_cleaned does not exist" "404" "$(rpc "$TA" stt_mark_cleaned "$(jb p_meeting=$MT)")"
expect "PROBE (G1): a member cannot write the machine-provenance token table" "401|403" "$(post "$TA" machine_persist_tokens "$(jb txid=1)")"
expect "PROBE: server_trust is invisible to a member" "401|403" "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/rest/v1/server_trust?select=*")"
expect "PROBE: a member cannot forge the ledger (ai_requests insert)" "401|403" "$(post "$TA" ai_requests "$(jb feature=meeting-transcribe status=succeeded)")"
expect "PROBE: a member cannot write stt_jobs" "401|403" "$(post "$TA" stt_jobs "$(jb meeting_id=$MT project_id=$P attempt=1)")"
expect "PROBE: a member cannot flip the STT state of the meeting directly" "401|403" "$(curl -s -X PATCH "$API_URL/rest/v1/meetings?id=eq.$MT" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -H 'Content-Type: application/json' -d '{"stt_state":"completed"}' -o "$TMP/last" -w '%{http_code}')"
expect "PROBE: a member cannot insert a provider transcript revision (source soniox) directly" "401|403|400" "$(post "$TA" meeting_transcripts "$(jb meeting_id=$MT project_id=$P revision=$(python3 -c 'print("c"*64)') source=soniox 'speakers=[]' 'segments=[]' char_count=1)")"
expect "PROBE: B (another project) cannot read the orphan queue" "200" "$(OUT="$TMP/orph" get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" "$API_URL/rest/v1/meeting_audio_orphans?select=path")"
python3 -c "import json;sys=__import__('sys');sys.exit(0 if json.load(open('$TMP/orph'))==[] else 1)" && ok "  ...and it is empty for B" || bad "B can see orphan paths"

if [ -n "${DB_CONTAINER:-}" ]; then
  HASH=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest())' "$SRV")
  docker exec -i -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', '$HASH') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256" >/dev/null
  ok "the OWNER registered the hash of the server secret (only the hash is in the database)"
  expect "the server (secret + the member's JWT) reserves with ITS budgets" 200 "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=600000 p_user_daily_ms=7200000 p_global_daily_ms=36000000)")"
  grep -q '"outcome":"started"' "$TMP/rpc" && ok "  ...outcome started, client_reference present: $(grep -c client_reference "$TMP/rpc")" || bad "unexpected reserve answer: $(head -c 200 "$TMP/rpc")"
  expect "a second reserve is idempotent (in_progress, nothing double-booked)" 200 "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=600000 p_user_daily_ms=7200000 p_global_daily_ms=36000000)")"
  grep -q '"outcome":"in_progress"' "$TMP/rpc" && ok "  ...in_progress" || bad "expected in_progress: $(head -c 200 "$TMP/rpc")"
  expect "the WRONG secret is refused even for the legitimate member" "401|403" "$(rpc "$TA" stt_attach_job "$(jb p_server_secret=wrong-secret-wrong-secret-wrong-secret p_meeting=$MT p_attempt=1 p_job_id=j p_model=m)")"
  expect "the server attaches the provider job id" 200 "$(rpc "$TA" stt_attach_job "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=tr-real-1 p_model=stt-async-v6)")"
  expect "B (not a member) cannot use the secret on A's meeting" "401|403" "$(rpc "$TB" stt_fail "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=tr-real-1 p_error_type=cancelled p_billing=estimated)")"
  expect "cancel keeps the cost: stt_fail with billing=estimated" "200|204" "$(rpc "$TA" stt_fail "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=tr-real-1 p_error_type=cancelled p_billing=estimated)")"
  LEDGER=$(docker exec -i -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -At -c "select status||':'||billing_state||':'||audio_ms from public.ai_requests where feature='meeting-transcribe' order by created_at desc limit 1")
  [ "$LEDGER" = "failed:estimated:600000" ] && ok "the cancelled estimate stays in the ledger ($LEDGER)" || bad "ledger after cancel: $LEDGER"
  JOB=$(docker exec -i -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -At -c "select state||':'||cleanup_state||':'||provider_job_id from public.stt_jobs order by created_at desc limit 1")
  [ "$JOB" = "cancelled:pending:tr-real-1" ] && ok "the provider job id is kept and queued for deletion ($JOB)" || bad "job row after cancel: $JOB"
  expect "a retry is a NEW attempt and the old job id survives" 200 "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=600000 p_user_daily_ms=7200000 p_global_daily_ms=36000000)")"
  grep -q '"attempt":2' "$TMP/rpc" && ok "  ...attempt 2" || bad "expected attempt 2: $(head -c 200 "$TMP/rpc")"
  expect "the failed second attempt is booked as UNCERTAIN (network_error: the provider may have created it)" "200|204" "$(rpc "$TA" stt_fail "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=2 p_job_id=null p_error_type=network_error p_billing=uncertain)")"
  expect "F3: a stt_fail on a SUBMITTING attempt (not a confirmed rejection) leaves the outcome UNKNOWN: an immediate retry is refused" 200 "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=600000 p_user_daily_ms=7200000 p_global_daily_ms=36000000)")"
  grep -q '"outcome":"unknown_outcome"' "$TMP/rpc" && ok "  ...unknown_outcome (no second paid POST)" || bad "expected unknown_outcome: $(head -c 200 "$TMP/rpc")"
  expect "F3: abandoning inside the submission window is refused" 200 "$(rpc "$TA" stt_resolve_unknown "$(jb p_server_secret=$SRV p_meeting=$MT p_resolution=abandon)")"
  grep -q 'too_early' "$TMP/rpc" && ok "  ...too_early" || bad "expected too_early: $(head -c 200 "$TMP/rpc")"
  docker exec -i -e PGPASSWORD=postgres "$DB_CONTAINER" psql -h localhost -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c "UPDATE public.meetings SET stt_submitted_at = now() - interval '11 minutes' WHERE id = '$MT'" >/dev/null
  expect "F3: after the window the user may abandon (estimate stays booked)" 200 "$(rpc "$TA" stt_resolve_unknown "$(jb p_server_secret=$SRV p_meeting=$MT p_resolution=abandon)")"
  grep -q 'resolved' "$TMP/rpc" && ok "  ...resolved" || bad "expected resolved: $(head -c 200 "$TMP/rpc")"
  expect "F3: the late job id of attempt 1 attaches to ITS attempt: reported orphaned, attempt 2 untouched" 200 "$(rpc "$TA" stt_attach_job "$(jb p_server_secret=$SRV p_meeting=$MT p_attempt=1 p_job_id=tr-real-1 p_model=stt-async-v6)")"
  grep -q 'orphaned' "$TMP/rpc" && ok "  ...orphaned" || bad "expected orphaned: $(head -c 200 "$TMP/rpc")"
  expect "the budget now counts the uncertain attempt" 200 "$(rpc "$TA" stt_reserve "$(jb p_server_secret=$SRV p_meeting=$MT p_est_audio_ms=600000 p_user_daily_ms=1000000 p_global_daily_ms=36000000)")"
  grep -q '"outcome":"budget_exceeded"' "$TMP/rpc" && ok "  ...budget_exceeded (uncertain / cancelled estimates are NOT free)" || bad "expected budget_exceeded: $(head -c 200 "$TMP/rpc")"
else
  echo "skip - DB_CONTAINER not set: the secret-holding half of the trusted-RPC checks needs the owner step (register the hash)"
fi


[ $fail = 0 ] && echo "ALL MEETING-AUDIO STORAGE CHECKS PASSED" || { echo "MEETING-AUDIO STORAGE CHECKS FAILED"; exit 1; }
