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
cleanup() { unset KEY; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; [ -n "${SRV:-}" ] && kill -- "-$SRV" 2>/dev/null; echo "local processes stopped"; }
trap cleanup EXIT
scripts/make-synthetic-czech-audio.sh "$WORK/audio" || exit 1

if [ "${DRY_RUN:-}" = 1 ]; then
  unset CONFIRM_REAL_SONIOX_JOBS
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$FAKE_PORT/__stats" && { echo "refusing: something already listens on $FAKE_PORT"; exit 2; }
  node e2e/support/fake-soniox.mjs "$FAKE_PORT" >"$WORK/fake-soniox.log" 2>&1 & PIDS+=($!)
  KEY=fake-soniox-key; SBASE=http://127.0.0.1:$FAKE_PORT/v1; SEAM_ORIGIN=""; REGION=us; FAKE_ENV=http://127.0.0.1:$FAKE_PORT
else
  [ "${CONFIRM_REAL_SONIOX_JOBS:-}" = 1 ] || { echo "refusing: set CONFIRM_REAL_SONIOX_JOBS=1 to confirm ONE REAL Soniox job (or DRY_RUN=1)"; exit 2; }
  command -v cloudflared >/dev/null || { echo "cloudflared is required for the public signed-URL leg (brew install cloudflared)"; exit 2; }
  REGION=${SONIOX_REGION:-us}
  case "$REGION" in us) SBASE=https://api.soniox.com/v1;; eu) SBASE=https://api.eu.soniox.com/v1;; jp) SBASE=https://api.jp.soniox.com/v1;; in) SBASE=https://api.in.soniox.com/v1;; *) echo "SONIOX_REGION must be us|eu|jp|in"; exit 2;; esac
  printf 'Vlozte Soniox API klic (vstup je skryty) a stisknete Enter: '; IFS= read -rs KEY; echo
  [ -n "$KEY" ] || { echo "empty key, nothing done"; exit 1; }
  FAKE_ENV=""
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$GATE_PORT/x" && { echo "refusing: something already listens on $GATE_PORT"; exit 2; }
  node e2e/support/storage-gate.mjs "$GATE_PORT" "$E2E_SUPABASE_URL" >"$WORK/gate.log" 2>&1 & PIDS+=($!)
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$GATE_PORT" >"$WORK/tunnel.log" 2>&1 & PIDS+=($!)
  SEAM_ORIGIN=""
  for i in $(seq 1 40); do SEAM_ORIGIN=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$WORK/tunnel.log" | head -1); [ -n "$SEAM_ORIGIN" ] && break; sleep 1; done
  [ -n "$SEAM_ORIGIN" ] || { echo "the tunnel did not start (see $WORK/tunnel.log)"; exit 1; }
  for i in $(seq 1 45); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$SEAM_ORIGIN/probe")" = 404 ] && break; sleep 2; done   # the gate answers 404 to anything that is not a signed object URL
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$SEAM_ORIGIN/probe")" = 404 ] || { echo "the tunnel does not reach the gate"; exit 1; }
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$SEAM_ORIGIN/rest/v1/")" = 404 ] && echo "tunnel up; the gate refuses everything except signed meeting-audio object URLs"
fi
curl -s -o /dev/null --max-time 2 "$APP/login" && { echo "refusing: something already listens on $PORT"; exit 2; }
set -m
( export NEXT_PUBLIC_SUPABASE_URL="$E2E_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 \
         SONIOX_API_KEY="$KEY" SONIOX_REGION="$REGION" STT_SERVER_SECRET="$SECRET"
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
import json,sys; r=json.load(open('$REPORT')); print(json.dumps({k:r.get(k) for k in ['mode','finalState','providerSeconds','segments','speakers','diarizationSeparatedTwoVoices','werWithDiacritics','werWithoutDiacritics','timestampsMonotonic','lastEndMs','costUsd','ledger','jobs','providerAnswerForDeletedJob']}, ensure_ascii=False, indent=1))"
# key hygiene: the key (read through a file descriptor, never argv) must be in none of the logs of the app, the gate and the tunnel (the fake provider's own banner is not checked)
HITS=0; for f in "$WORK/next.log" "$WORK/gate.log" "$WORK/tunnel.log"; do n=$(grep -c -F -f <(printf '%s' "$KEY") "$f" 2>/dev/null || true); HITS=$((HITS + ${n:-0})); done
echo "key hygiene: $HITS occurrence(s) of the key in the local logs"
[ "$HITS" = 0 ] || RC=1
exit $RC
