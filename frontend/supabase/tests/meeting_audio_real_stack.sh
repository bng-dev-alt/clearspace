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
expect "tampered signed URL is refused" "400|401|403|404" "$(get "${AURL%?}X")"
# SQLSTATE 55000 reaches the client as HTTP 500 through PostgREST; what matters is that the row is NOT changed.
expect "mark_audio_deleted is REFUSED while the object exists" "400|409|422|500" "$(rpc "$TA" mark_audio_deleted "$(jb p_meeting=$MID)")"
STILL=$(curl -s "$API_URL/rest/v1/meetings?id=eq.$MID&select=audio_path,audio_deleted_at" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA")
python3 -c "import json,sys; d=json.loads(sys.argv[1])[0]; sys.exit(0 if d['audio_path'] and not d['audio_deleted_at'] else 1)" "$STILL" && ok "the row still points at the audio (no false deletion record)" || bad "row was changed although the object exists: $STILL"
curl -s -X DELETE "$API_URL/storage/v1/object/meeting-audio/$AP" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TB" -o /dev/null
expect "the object survives a non-member delete" 200 "$(get -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" "$API_URL/storage/v1/object/authenticated/meeting-audio/$AP")"
expect "member deletes the audio" 200 "$(curl -s -X DELETE "$API_URL/storage/v1/object/meeting-audio/$AP" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TA" -o /dev/null -w '%{http_code}')"
expect "now mark_audio_deleted succeeds" "200|204" "$(rpc "$TA" mark_audio_deleted "$(jb p_meeting=$MID)")"


[ $fail = 0 ] && echo "ALL MEETING-AUDIO STORAGE CHECKS PASSED" || { echo "MEETING-AUDIO STORAGE CHECKS FAILED"; exit 1; }
