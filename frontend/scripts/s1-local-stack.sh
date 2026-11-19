#!/usr/bin/env bash
# Throwaway LOCAL Supabase stack for the S1 real-Soniox test (nothing hosted). The stack lives in $TMPDIR/cs-intel-sb (ports 55520-55529).
#   frontend/scripts/s1-local-stack.sh up      # start (Storage included) and apply the schema + migrations; safe to re-run only on a fresh stack
#   eval "$(frontend/scripts/s1-local-stack.sh env)"   # exports E2E_SUPABASE_* + PW_CHROMIUM_PATH into YOUR shell (local demo keys, not secrets)
#   frontend/scripts/s1-local-stack.sh down    # stop and delete it (supabase binds to 0.0.0.0 while it runs: stop it after the test)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); DIR=${S1_STACK_DIR:-${TMPDIR:-/tmp}/cs-intel-sb}
status() { (cd "$DIR" && supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)='); }
case "${1:-}" in
  up)
    [ -f "$DIR/supabase/config.toml" ] || { echo "no stack project in $DIR (recipe: docs/intelligence/IMPLEMENTATION_REPORT.md)"; exit 2; }
    (cd "$DIR" && supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,mailpit,supavisor,postgres-meta >/dev/null 2>&1)
    eval "$(status)"; export ANON_KEY SERVICE_ROLE_KEY API_URL DB_CONTAINER=supabase_db_cs-intel-sb
    "$HERE/supabase/tests/real_stack.sh" 2>&1 | tail -2;;
  env)
    eval "$(status)"
    echo "export E2E_SUPABASE_URL=$API_URL E2E_SUPABASE_ANON_KEY=$ANON_KEY E2E_SUPABASE_SERVICE_KEY=$SERVICE_ROLE_KEY"
    echo "export PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell}";;
  down) (cd "$DIR" && supabase stop --no-backup 2>&1 | tail -1);;
  *) echo "usage: $0 up|env|down"; exit 2;;
esac
