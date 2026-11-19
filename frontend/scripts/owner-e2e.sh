#!/usr/bin/env bash
# LOCAL end-to-end of the owner-only Meeting Intelligence activation. Throwaway local Supabase stack (scripts/s1-local-stack.sh up) + LOCAL FAKE Gemini
# and FAKE Soniox: no key, no credit, no network out, everything on 127.0.0.1.
#   export S1_STACK_DIR=<throwaway stack project>; frontend/scripts/s1-local-stack.sh up
#   frontend/scripts/owner-e2e.sh
# Run 1 (production-like): AI_OWNER_USER_IDS=<fixed owner id>, NO allow-all -> owner-access.spec (owner / non-owner member / stranger / anonymous / cross-project)
#        and the WHOLE flow (meeting-flow.spec: consent -> Soniox -> speakers -> Gemini -> approvals -> tasks -> Project Intelligence) as the owner.
# Run 2 (regression, local allow-all opt-in): meetings, project-intelligence and meeting-audio specs (provider errors, uncertain outcomes, retention, ...).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
eval "$(scripts/s1-local-stack.sh env)" || exit 2
case "$E2E_SUPABASE_URL" in http://127.0.0.1:*) ;; *) echo "refusing: not a local stack"; exit 2;; esac
GP=55590; SP=55591; APP_PORT=${APP_PORT:-3413}
OWNER_ID=5eed0000-0000-4000-8000-0000000000a1; SECRET=$(openssl rand -hex 24); WORK=$(mktemp -d); PIDS=(); RC=0
for p in $GP $SP $APP_PORT; do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/" && { echo "refusing: something already listens on $p"; exit 2; }; done
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; [ -n "${SRV:-}" ] && kill -- "-$SRV" 2>/dev/null; rm -rf "$WORK"; echo "local processes stopped"; }
trap cleanup EXIT
node e2e/support/fake-gemini.mjs $GP >"$WORK/gemini.log" 2>&1 & PIDS+=($!)
node e2e/support/fake-soniox.mjs $SP >"$WORK/soniox.log" 2>&1 & PIDS+=($!)
sleep 1
start_app() { # $1 = mode env assignment
  set -m
  ( export NEXT_PUBLIC_SUPABASE_URL="$E2E_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 \
      SONIOX_API_KEY=fake-soniox-key SONIOX_BASE_URL="http://127.0.0.1:$SP/v1" STT_SERVER_SECRET="$SECRET" \
      GEMINI_API_KEY=fake GEMINI_BASE_URL="http://127.0.0.1:$GP" GEMINI_MODEL=fake-gemini AI_RATE_PER_USER_PER_MINUTE=60 AI_DAILY_TOKEN_BUDGET_PER_USER=5000000
    unset AI_OWNER_USER_IDS AI_ALLOW_ALL_AUTHENTICATED; export "$1"
    exec ./node_modules/.bin/next dev -p "$APP_PORT" -H 127.0.0.1 >"$WORK/next.log" 2>&1 ) &
  SRV=$!; set +m
  for i in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$APP_PORT/login" && return 0; sleep 2; done
  echo "app did not start"; tail -5 "$WORK/next.log"; return 1
}
stop_app() { [ -n "${SRV:-}" ] && kill -- "-$SRV" 2>/dev/null; SRV=""; for i in $(seq 1 20); do curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$APP_PORT/" || break; sleep 1; done; }
E2E_ENV=(E2E_SUPABASE_URL="$E2E_SUPABASE_URL" E2E_SUPABASE_ANON_KEY="$E2E_SUPABASE_ANON_KEY" E2E_SUPABASE_SERVICE_KEY="$E2E_SUPABASE_SERVICE_KEY" E2E_FAKE_GEMINI_URL="http://127.0.0.1:$GP" E2E_FAKE_SONIOX_URL="http://127.0.0.1:$SP" E2E_STT_SERVER_SECRET="$SECRET" PLAYWRIGHT_TEST_BASE_URL="http://127.0.0.1:$APP_PORT")
if [ -n "${ONLY_OWNER_ACCESS:-}" ]; then SPECS="e2e/owner-access.spec.ts"; else SPECS="e2e/owner-access.spec.ts e2e/meeting-flow.spec.ts"; fi
echo "== RUN 1: owner-only mode (AI_OWNER_USER_IDS set, no allow-all)"
start_app "AI_OWNER_USER_IDS=$OWNER_ID" || exit 1
env "${E2E_ENV[@]}" E2E_OWNER_USER_ID=$OWNER_ID npx playwright test $SPECS --workers=1 --retries=0 --reporter=list || RC=1
stop_app
[ -n "${ONLY_OWNER_ACCESS:-}" ] && { echo "== E2E exit code $RC (run 2 skipped)"; exit $RC; }
echo "== RUN 2: regression suites (local allow-all opt-in)"
start_app "AI_ALLOW_ALL_AUTHENTICATED=1" || exit 1
env "${E2E_ENV[@]}" npx playwright test e2e/meetings.spec.ts e2e/project-intelligence.spec.ts e2e/meeting-audio.spec.ts --workers=1 --retries=0 --reporter=list || RC=1
echo "== E2E exit code $RC"; exit $RC
