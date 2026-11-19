#!/usr/bin/env bash
# RUN B / B4: bounded AI QUALITY run on SYNTHETIC data. Local app + THROWAWAY LOCAL Supabase stack only; the real Gemini key
# goes only into the environment of the one local `next dev` process (hidden prompt, never argv/file/log).
#
#   DRY_RUN=1 scripts/ai-quality-run.sh                                    # fake Gemini, proves the harness, no key, no credits
#   CONFIRM_REAL_GEMINI_CALLS=4 scripts/ai-quality-run.sh                  # 4 REAL calls (3 meetings + 1 brief), key prompted
#
# Required env (local stack, see docs/intelligence/IMPLEMENTATION_REPORT.md): E2E_SUPABASE_URL (http://127.0.0.1:<port>),
# E2E_SUPABASE_ANON_KEY. Optional: N_REAL (4..6, default 4), PORT (3411), PW_CHROMIUM_PATH, QUALITY_REPORT (report path).
# No retries: Playwright runs serially with --retries=0 and stops at the first failure. Calls beyond N_REAL are refused by the spec.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PORT=${PORT:-3411}; N=${N_REAL:-4}; BASE=http://127.0.0.1:$PORT; FAKE_PORT=${FAKE_PORT:-55591}
[ "$N" -ge 4 ] && [ "$N" -le 6 ] || { echo "N_REAL must be 4..6"; exit 2; }
case "${E2E_SUPABASE_URL:-}" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: E2E_SUPABASE_URL must be a LOCAL stack (http://127.0.0.1:<port>)"; exit 2;; esac
[ -n "${E2E_SUPABASE_ANON_KEY:-}" ] || { echo "E2E_SUPABASE_ANON_KEY missing"; exit 2; }
REPORT=${QUALITY_REPORT:-${TMPDIR:-/tmp}/ai-quality-report.json}
FAKE_PID=""
if [ "${DRY_RUN:-}" = 1 ]; then
  unset CONFIRM_REAL_GEMINI_CALLS
  KEY=fake-key; GBASE=http://127.0.0.1:$FAKE_PORT; MODEL=fake-gemini
  curl -s -o /dev/null --max-time 2 "$GBASE/__stats" && { echo "refusing: something already listens on $FAKE_PORT"; exit 2; }
  node e2e/support/fake-gemini.mjs "$FAKE_PORT" >"${TMPDIR:-/tmp}/ai-quality-fake.log" 2>&1 & FAKE_PID=$!
else
  [ "${CONFIRM_REAL_GEMINI_CALLS:-}" = "$N" ] || { echo "refusing: set CONFIRM_REAL_GEMINI_CALLS=$N to confirm up to $N REAL Gemini calls (or DRY_RUN=1)"; exit 2; }
  printf 'Vlozte Gemini API klic pro ClearSpace V1 (vstup je skryty) a stisknete Enter: '; IFS= read -rs KEY; echo
  [ -n "$KEY" ] || { echo "empty key, nothing done"; exit 1; }
  GBASE=""; MODEL=${GEMINI_MODEL:-gemini-3.6-flash}
fi
curl -s -o /dev/null --max-time 2 "$BASE/login" && { echo "refusing: something already listens on $PORT"; [ -n "$FAKE_PID" ] && kill "$FAKE_PID"; exit 2; }
set -m
( export GEMINI_API_KEY="$KEY" GEMINI_MODEL="$MODEL" AI_RATE_PER_USER_PER_MINUTE=$N AI_RATE_GLOBAL_PER_MINUTE=60 \
         NEXT_PUBLIC_SUPABASE_URL="$E2E_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" \
         AI_ALLOW_ALL_AUTHENTICATED=1   # local throwaway stack only: the owner allowlist (AI_OWNER_USER_IDS) is not set here, ignored on Vercel production
  if [ -n "$GBASE" ]; then export GEMINI_BASE_URL="$GBASE"; else unset GEMINI_BASE_URL; fi
  unset KEY
  exec ./node_modules/.bin/next dev -p "$PORT" -H 127.0.0.1 >"${TMPDIR:-/tmp}/ai-quality-next.log" 2>&1 ) &
SRV=$!
stop() { unset KEY; kill -- "-$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; echo "local server stopped"; }
trap stop EXIT
for i in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "$BASE/login" && break; sleep 2; done
curl -s -o /dev/null --max-time 5 "$BASE/login" || { echo "server did not start (see ${TMPDIR:-/tmp}/ai-quality-next.log)"; exit 1; }
E2E_QUALITY_RUN=1 E2E_REAL_MAX_CALLS=$N QUALITY_REPORT="$REPORT" PLAYWRIGHT_TEST_BASE_URL="$BASE" \
  npx playwright test e2e/quality-real.spec.ts --workers=1 --retries=0 --reporter=line
RC=$?
[ -f "$REPORT" ] && echo "report: $REPORT (synthetic data only; contains model output, no secrets)"
echo "key hygiene: $(grep -c 'AIza' "${TMPDIR:-/tmp}/ai-quality-next.log" 2>/dev/null || true) 'AIza' hits in server log"
exit $RC
