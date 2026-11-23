#!/usr/bin/env bash
# Real-browser Monograph QA on the throwaway LOCAL stack (no hosted service, no paid provider call, everything on 127.0.0.1):
#   S1_STACK_DIR=<stack project> frontend/scripts/s1-local-stack.sh up      # once
#   frontend/scripts/monograph-stack.sh shots     # seed owner + meeting + analysis, capture MODE=stack screenshots
#   frontend/scripts/monograph-stack.sh e2e       # owner-access + meeting-flow with the style set to Monograph (E2E_STYLE=monograph)
# Port 3421 (app), 55590/55591 (fake Gemini / fake Soniox) -- the same fakes owner-e2e.sh uses. Everything started here is stopped on exit.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
MODE_ARG=${1:-shots}
eval "$(scripts/s1-local-stack.sh env)" || exit 2
case "$E2E_SUPABASE_URL" in http://127.0.0.1:*) ;; *) echo "refusing: not a local stack"; exit 2;; esac
GP=55590; SP=55591; APP_PORT=${APP_PORT:-3421}
OWNER_ID=5eed0000-0000-4000-8000-0000000000a1; SECRET=$(openssl rand -hex 24); WORK=$(mktemp -d); PIDS=(); RC=0
for p in $GP $SP $APP_PORT; do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/" && { echo "refusing: something already listens on $p"; exit 2; }; done
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; [ -n "${SRV:-}" ] && kill -- "-$SRV" 2>/dev/null; rm -rf "$WORK"; echo "local processes stopped"; }
trap cleanup EXIT
node e2e/support/fake-gemini.mjs $GP >"$WORK/gemini.log" 2>&1 & PIDS+=($!)
node e2e/support/fake-soniox.mjs $SP >"$WORK/soniox.log" 2>&1 & PIDS+=($!)
sleep 1
set -m
( export NEXT_PUBLIC_SUPABASE_URL="$E2E_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 NEXT_PUBLIC_ENABLE_MONOGRAPH=1 \
    SONIOX_API_KEY=fake-soniox-key SONIOX_BASE_URL="http://127.0.0.1:$SP/v1" STT_SERVER_SECRET="$SECRET" \
    GEMINI_API_KEY=fake GEMINI_BASE_URL="http://127.0.0.1:$GP" GEMINI_MODEL=fake-gemini AI_RATE_PER_USER_PER_MINUTE=60 AI_DAILY_TOKEN_BUDGET_PER_USER=5000000 AI_OWNER_USER_IDS=$OWNER_ID
  unset AI_ALLOW_ALL_AUTHENTICATED
  exec ./node_modules/.bin/next dev -p "$APP_PORT" -H 127.0.0.1 >"$WORK/next.log" 2>&1 ) &
SRV=$!; set +m
for i in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$APP_PORT/login" && break; sleep 2; done
export E2E_FAKE_SONIOX_URL="http://127.0.0.1:$SP" E2E_FAKE_GEMINI_URL="http://127.0.0.1:$GP" E2E_STT_SERVER_SECRET="$SECRET" E2E_OWNER_USER_ID=$OWNER_ID BASE_URL="http://127.0.0.1:$APP_PORT" PLAYWRIGHT_TEST_BASE_URL="http://127.0.0.1:$APP_PORT"
if [ "$MODE_ARG" = shots ]; then
  export STACK_CTX="$WORK/ctx.json"
  node scripts/monograph-stack-seed.mjs || { RC=1; tail -5 "$WORK/next.log"; exit 1; }
  MODE=stack OUT=${OUT:-../docs/monograph/shots-full} node scripts/monograph-shots.mjs "${@:2}" || RC=1
else
  E2E_STYLE=monograph npx playwright test e2e/monograph-style.spec.ts e2e/owner-access.spec.ts e2e/meeting-flow.spec.ts --workers=1 --retries=0 --reporter=list || RC=1
fi
exit $RC
