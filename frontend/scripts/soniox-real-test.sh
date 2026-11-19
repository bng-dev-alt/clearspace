#!/usr/bin/env bash
# BOUNDED real Soniox test: ONE synthetic Czech recording (<= 60 s), ONE transcription job, local app + THROWAWAY local Supabase only.
# Gemini is not configured at all (AI routes answer 503), so only Soniox can bill. The Soniox key is read from a HIDDEN prompt into the
# environment of the local app process and of the one test process: never argv, file, history, .env.local or log.
#
#   DRY_RUN=1 frontend/scripts/soniox-real-test.sh                       # local FAKE Soniox, proves the harness, no key, no cost
#   CONFIRM_REAL_SONIOX_JOBS=1 frontend/scripts/soniox-real-test.sh      # ONE REAL job; asks for the key; opens a short-lived public tunnel
#
# Required env (throwaway local stack, see docs/intelligence/IMPLEMENTATION_REPORT.md): E2E_SUPABASE_URL, E2E_SUPABASE_ANON_KEY, E2E_SUPABASE_SERVICE_KEY.
# Optional: SONIOX_REGION (us|eu|jp|in; must match the key's project, default us), PORT (3412), PW_CHROMIUM_PATH, SONIOX_REPORT, GATE_PORT (55592).
#
# WHY a tunnel: Soniox downloads the audio from the internet and the local Storage is private to this machine. `cloudflared tunnel --url` is an
# ACCOUNT-LESS quick tunnel (nothing is created in any Cloudflare account, no zone or firewall is touched, it dies with this script). It points at
# e2e/support/storage-gate.mjs, which serves ONLY GET/HEAD of signed `meeting-audio` object URLs; nothing else of the local stack is reachable.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT=${PORT:-3412}; APP=http://127.0.0.1:$PORT; GATE_PORT=${GATE_PORT:-55592}; FAKE_PORT=${FAKE_PORT:-55591}
case "${E2E_SUPABASE_URL:-}" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: E2E_SUPABASE_URL must be a LOCAL throwaway stack"; exit 2;; esac
[ -n "${E2E_SUPABASE_ANON_KEY:-}" ] && [ -n "${E2E_SUPABASE_SERVICE_KEY:-}" ] || { echo "E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_KEY missing"; exit 2; }
WORK=$(mktemp -d); REPORT=${SONIOX_REPORT:-$WORK/soniox-report.json}
SECRET=$(openssl rand -hex 24)
PIDS=()
cleanup() { keep_tunnel_log; unset KEY; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; [ -n "${SRV:-}" ] && kill -- "-$SRV" 2>/dev/null; echo "local processes stopped"; }
trap cleanup EXIT
# Sanitized copy of the tunnel log (quick-tunnel hostnames and tokens masked) is KEPT for diagnosis: $S1_LOG_DIR (default: next to the local stack project).
LOGDIR=${S1_LOG_DIR:-${S1_STACK_DIR:-${TMPDIR:-/tmp}/cs-intel-sb}}
keep_tunnel_log() { [ -s "$WORK/tunnel.log" ] && mkdir -p "$LOGDIR" && sed -E 's#https://[a-z0-9-]+\.trycloudflare\.com#https://<quick-tunnel>#g; s#token=[A-Za-z0-9._-]+#token=<masked>#g' "$WORK/tunnel.log" >"$LOGDIR/last-tunnel.log" 2>/dev/null && echo "sanitized tunnel log kept: $LOGDIR/last-tunnel.log"; }
# Gate + account-less quick tunnel + checks. A FRESH quick-tunnel hostname is printed by cloudflared a few seconds after start, but public DNS answers NXDOMAIN for it
# for roughly 1-1.5 min more (measured 2026-11-19: printed at 6 s, resolvable at 69 s, HTTP 404 at 78 s). Soniox needs that same public DNS, so we wait on the PUBLIC
# resolvers (1.1.1.1 and 8.8.8.8, which also leaves no negative answer in the local resolver cache) and then probe with the resolved IP pinned. Bounded: 180 s in total.
start_tunnel() {
  command -v dig >/dev/null || { echo "dig is required"; exit 2; }
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$GATE_PORT/x" && { echo "refusing: something already listens on $GATE_PORT"; exit 2; }
  node e2e/support/storage-gate.mjs "$GATE_PORT" "$E2E_SUPABASE_URL" >"$WORK/gate.log" 2>&1 & PIDS+=($!)
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$GATE_PORT" >"$WORK/tunnel.log" 2>&1 & PIDS+=($!)
  local T0=$SECONDS A B c; H=""; IP=""   # H, IP stay global: tc() is used again by the TUNNEL_CHECK leg
  SEAM_ORIGIN=""
  for i in $(seq 1 40); do SEAM_ORIGIN=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$WORK/tunnel.log" | head -1); [ -n "$SEAM_ORIGIN" ] && break; sleep 1; done
  [ -n "$SEAM_ORIGIN" ] || { echo "the tunnel did not start"; exit 1; }
  H=${SEAM_ORIGIN#https://}
  while [ $((SECONDS - T0)) -lt 180 ]; do
    A=$(dig +short +time=2 +tries=1 @1.1.1.1 "$H" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1); B=$(dig +short +time=2 +tries=1 @8.8.8.8 "$H" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
    [ -n "$A" ] && [ -n "$B" ] && { IP=$A; break; }; sleep 3
  done
  [ -n "$IP" ] || { echo "the tunnel hostname is not in public DNS (1.1.1.1 + 8.8.8.8) after $((SECONDS - T0)) s: no job was sent"; return 1; }
  echo "tunnel hostname resolvable on public DNS after $((SECONDS - T0)) s"
  tc() { curl -s --resolve "$H:443:$IP" --max-time 6 "$@"; }
  c=""; while [ $((SECONDS - T0)) -lt 180 ]; do c=$(tc -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/probe"); [ "$c" = 404 ] && break; sleep 2; done   # the gate answers 404 to anything that is not a signed object URL
  [ "$c" = 404 ] || { echo "the tunnel does not reach the gate within 180 s (last HTTP $c)"; return 1; }
  echo "gate reachable through the tunnel after $((SECONDS - T0)) s"
  # path tricks must not get past the gate either (dot segments are refused before anything is forwarded)
  [ "$(tc --path-as-is -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/storage/v1/object/sign/meeting-audio/../../../../auth/v1/settings?token=a")" = 404 ] || { echo "the gate let a dot-segment path through"; return 1; }
  [ "$(tc -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/rest/v1/")" = 404 ] || { echo "the gate answered /rest/v1/"; return 1; }
  [ "$(tc -o /dev/null -w '%{http_code}' -X POST "$SEAM_ORIGIN/storage/v1/object/sign/meeting-audio/x.mp3?token=a")" = 404 ] || { echo "the gate answered a POST"; return 1; }
  echo "tunnel up; the gate refuses everything except signed meeting-audio object URLs"
}
scripts/make-synthetic-czech-audio.sh "$WORK/audio" || exit 1

if [ "${DRY_RUN:-}" = 1 ]; then
  unset CONFIRM_REAL_SONIOX_JOBS
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$FAKE_PORT/__stats" && { echo "refusing: something already listens on $FAKE_PORT"; exit 2; }
  node e2e/support/fake-soniox.mjs "$FAKE_PORT" >"$WORK/fake-soniox.log" 2>&1 & PIDS+=($!)
  KEY=fake-soniox-key; SBASE=http://127.0.0.1:$FAKE_PORT/v1; SEAM_ORIGIN=""; REGION=us; FAKE_ENV=http://127.0.0.1:$FAKE_PORT
else
  if [ "${TUNNEL_CHECK:-}" = 1 ]; then   # diagnostic: gate + tunnel + authorized synthetic audio only; NO key, NO Soniox, nothing billed
    command -v cloudflared >/dev/null || { echo "cloudflared is required"; exit 2; }
    start_tunnel || exit 1
    OBJ="tunnel-check/$(openssl rand -hex 6).mp3"; SB="$E2E_SUPABASE_URL/storage/v1"; AUTH=(-H "apikey: $E2E_SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_KEY")
    [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${AUTH[@]}" -H 'Content-Type: audio/mpeg' --data-binary "@$WORK/audio/synthetic-cs.mp3" "$SB/object/meeting-audio/$OBJ")" = 200 ] || { echo "upload of the synthetic file to the LOCAL stack failed"; exit 1; }
    SIGNED=$(curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"expiresIn":120}' "$SB/object/sign/meeting-audio/$OBJ" | python3 -c 'import json,sys; print(json.load(sys.stdin)["signedURL"])')
    want=$(wc -c <"$WORK/audio/synthetic-cs.mp3" | tr -d ' ')
    got=$(tc -o /dev/null -w '%{http_code} %{size_download}' "$SEAM_ORIGIN/storage/v1$SIGNED")
    [ "$got" = "200 $want" ] && echo "authorized synthetic audio through the tunnel: 200, $want bytes" || { echo "signed audio fetch through the tunnel failed: $got (expected 200 $want)"; exit 1; }
    BAD=$(tc -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/storage/v1/object/meeting-audio/$OBJ"); BADT=$(tc -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/storage/v1/object/sign/meeting-audio/$OBJ?token=wrong"); OTH=$(tc -o /dev/null -w '%{http_code}' "$SEAM_ORIGIN/storage/v1${SIGNED/meeting-audio/other-bucket}")
    echo "unsigned object path: $BAD, wrong token: $BADT, other bucket with a valid token: $OTH (expect 404, 400/401/403/404, 404)"
    curl -s -o /dev/null -X DELETE "${AUTH[@]}" "$SB/object/meeting-audio/$OBJ"; echo "synthetic test object deleted from the local stack"
    [ "$BAD" = 404 ] && [ "$OTH" = 404 ] && case "$BADT" in 400|401|403|404) true;; *) false;; esac || { echo "TUNNEL_CHECK FAILED"; exit 1; }
    echo "TUNNEL_CHECK PASSED (no key, no Soniox request)"; exit 0
  fi
  [ "${CONFIRM_REAL_SONIOX_JOBS:-}" = 1 ] || { echo "refusing: set CONFIRM_REAL_SONIOX_JOBS=1 to confirm ONE REAL Soniox job (or DRY_RUN=1)"; exit 2; }
  command -v cloudflared >/dev/null || { echo "cloudflared is required for the public signed-URL leg (brew install cloudflared)"; exit 2; }
  printf 'Vlozte Soniox API klic (vstup je skryty) a stisknete Enter: '; IFS= read -rs KEY; echo
  [ -n "$KEY" ] || { echo "empty key, nothing done"; exit 1; }
  # REGION: never assumed. A FREE read-only call (GET /v1/files?limit=1, nothing is billed, nothing is created) decides which regional host accepts this key.
  # The key goes only to Soniox hosts, through curl's stdin config (never argv). SONIOX_REGION=<r> restricts the check to that one region.
  host_of() { case "$1" in us) echo https://api.soniox.com/v1;; eu) echo https://api.eu.soniox.com/v1;; jp) echo https://api.jp.soniox.com/v1;; in) echo https://api.in.soniox.com/v1;; *) echo "SONIOX_REGION must be us|eu|jp|in" >&2; return 1;; esac; }
  probe() { printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -K - "$(host_of "$1")/files?limit=1"; }
  ACCEPT=(); CODES=""
  for r in ${SONIOX_REGION:-us eu jp in}; do host_of "$r" >/dev/null || exit 2; c=$(probe "$r"); CODES="$CODES $r=$c"; [ "$c" = 200 ] && ACCEPT+=("$r"); done
  echo "key check (free GET /v1/files?limit=1):$CODES"
  [ "${#ACCEPT[@]}" = 1 ] || { echo "region NOT determined (accepted by ${#ACCEPT[@]} regions): no job was sent. Set SONIOX_REGION explicitly if more than one accepts, or check the key's project region in the Soniox Console."; exit 1; }
  REGION=${ACCEPT[0]}; SBASE=$(host_of "$REGION"); echo "Soniox region for this key: $REGION ($SBASE)"
  FAKE_ENV=""
  start_tunnel || exit 1
fi
curl -s -o /dev/null --max-time 2 "$APP/login" && { echo "refusing: something already listens on $PORT"; exit 2; }
set -m
( export NEXT_PUBLIC_SUPABASE_URL="$E2E_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 \
         SONIOX_API_KEY="$KEY" SONIOX_REGION="$REGION" STT_SERVER_SECRET="$SECRET" \
         AI_ALLOW_ALL_AUTHENTICATED=1   # local throwaway stack only (the owner allowlist is a production concern; ignored on Vercel production)
  unset GEMINI_API_KEY GEMINI_BASE_URL GEMINI_MODEL   # NO Gemini at all: the AI routes answer 503, so nothing else can bill
  if [ "${DRY_RUN:-}" = 1 ]; then export SONIOX_BASE_URL="$SBASE"; else unset SONIOX_BASE_URL; export STT_TEST_PUBLIC_STORAGE_ORIGIN="$SEAM_ORIGIN"; fi
  unset KEY
  exec ./node_modules/.bin/next dev -p "$PORT" -H 127.0.0.1 >"$WORK/next.log" 2>&1 ) &
SRV=$!
for i in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "$APP/login" && break; sleep 2; done
curl -s -o /dev/null --max-time 5 "$APP/login" || { echo "app did not start (see $WORK/next.log)"; exit 1; }
if [ "${DRY_RUN:-}" = 1 ]; then WHAT="DRY RUN against the fake provider"; else WHAT="REAL Soniox, region $REGION"; fi
echo "== running the ONE bounded job ($WHAT); no retries"
E2E_REAL_SONIOX=1 E2E_STT_SERVER_SECRET="$SECRET" E2E_SYNTH_DIR="$WORK/audio" E2E_SONIOX_BASE="$SBASE" E2E_FAKE_SONIOX_URL="$FAKE_ENV" SONIOX_API_KEY="$KEY" SONIOX_REPORT="$REPORT" \
  PLAYWRIGHT_TEST_BASE_URL="$APP" npx playwright test e2e/soniox-real.spec.ts --workers=1 --retries=0 --reporter=line
RC=$?
[ -f "$REPORT" ] && echo "report: $REPORT (synthetic data only; contains no secret)" && python3 -c "
import json,sys; r=json.load(open('$REPORT')); print(json.dumps({k:r.get(k) for k in ['mode','finalState','wallClockSeconds','segments','speakers','diarizationSeparatedTwoVoices','werWithDiacritics','werWithoutDiacritics','werPerTurn','timestampsMonotonic','lastEndMs','costUsd','ledger','jobs','providerAnswerForDeletedJob']}, ensure_ascii=False, indent=1))"
# key hygiene: the key (read through a file descriptor, never argv) must be in none of the logs of the app, the gate and the tunnel (the fake provider's own banner is not checked)
HITS=0; for f in "$WORK/next.log" "$WORK/gate.log" "$WORK/tunnel.log"; do n=$(grep -c -F -f <(printf '%s' "$KEY") "$f" 2>/dev/null || true); HITS=$((HITS + ${n:-0})); done
echo "key hygiene: $HITS occurrence(s) of the key in the local logs"
[ "$HITS" = 0 ] || RC=1
exit $RC
