#!/usr/bin/env bash
# Throwaway LOCAL Supabase stack for the S1 real-Soniox test (nothing hosted). The stack project lives in $S1_STACK_DIR (default $TMPDIR/cs-intel-sb, ports 55520-55529).
#   frontend/scripts/s1-local-stack.sh up      # start (Storage included), publish ONLY on 127.0.0.1, apply schema + migrations; refuses if anything is LAN-reachable
#   eval "$(frontend/scripts/s1-local-stack.sh env)"   # exports E2E_SUPABASE_* + PW_CHROMIUM_PATH into YOUR shell (local demo keys, not secrets)
#   frontend/scripts/s1-local-stack.sh status  # which ports of the stack listen and on which address
#   frontend/scripts/s1-local-stack.sh down    # stop and delete the stack and the helper proxy
# The Supabase CLI has no bind option (Docker would publish Kong 55521 and Postgres 55522 on ALL interfaces = the LAN). Without changing any global Docker
# setting, `up` runs the CLI against a tiny scoped Docker-API proxy (DOCKER_HOST for that one process; scripts/docker-loopback-proxy.mjs) which pins the
# published ports of the containers THIS stack creates to 127.0.0.1. Nothing else on this Docker daemon is affected. After the start the published
# bindings are verified; a stack that is still LAN-reachable is stopped again and the script fails.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); DIR=${S1_STACK_DIR:-${TMPDIR:-/tmp}/cs-intel-sb}
SOCK=/tmp/cs-s1-docker.sock; PIDF=$DIR/loopback-proxy.pid
REAL=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null | sed 's|^unix://||'); REAL=${REAL:-/var/run/docker.sock}
status() { (cd "$DIR" && DOCKER_HOST=unix://$SOCK supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)=') || (cd "$DIR" && supabase status -o env 2>/dev/null | grep -E '^(ANON_KEY|SERVICE_ROLE_KEY|API_URL)='); }
proxy_up() {
  [ -S "$SOCK" ] && [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null && return 0
  node "$HERE/scripts/docker-loopback-proxy.mjs" "$SOCK" "$REAL" >"$DIR/loopback-proxy.log" 2>&1 & echo $! >"$PIDF"
  for _ in $(seq 1 20); do [ -S "$SOCK" ] && return 0; sleep 0.25; done; echo "loopback proxy did not start"; exit 1
}
proxy_down() { [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF" "$SOCK"; }
lan_exposed() { docker ps --filter name=cs-intel-sb --format '{{.Ports}}' | tr ',' '\n' | grep -E '(^|[ ])(0\.0\.0\.0|\[::\]):[0-9]+->' || true; }
case "${1:-}" in
  up)
    [ -f "$DIR/supabase/config.toml" ] || { echo "no stack project in $DIR (recipe: docs/intelligence/IMPLEMENTATION_REPORT.md)"; exit 2; }
    [ -z "$(docker ps -q --filter name=cs-intel-sb)" ] || { echo "a cs-intel-sb stack is already running: run '$0 down' first (its ports may not be loopback-only)"; exit 2; }
    proxy_up
    (cd "$DIR" && DOCKER_HOST=unix://$SOCK supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,mailpit,supavisor,postgres-meta >/dev/null 2>&1) || { proxy_down; echo "supabase start failed"; exit 1; }
    EXP=$(lan_exposed)
    if [ -n "$EXP" ]; then echo "REFUSING: still LAN-reachable: $EXP"; (cd "$DIR" && DOCKER_HOST=unix://$SOCK supabase stop --no-backup >/dev/null 2>&1); proxy_down; exit 1; fi
    echo "published ports (all loopback): $(docker ps --filter name=cs-intel-sb --format '{{.Ports}}' | tr ',' '\n' | grep -E ':[0-9]+->' | sed 's/^ *//' | tr '\n' ' ')"
    eval "$(status)"; export ANON_KEY SERVICE_ROLE_KEY API_URL DB_CONTAINER=supabase_db_cs-intel-sb
    "$HERE/supabase/tests/real_stack.sh" 2>&1 | tail -2;;
  status) lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$9 ~ /:5552[0-9]$/ {print $1, $9}' | sort -u;;
  env)
    eval "$(status)"
    echo "export E2E_SUPABASE_URL=$API_URL E2E_SUPABASE_ANON_KEY=$ANON_KEY E2E_SUPABASE_SERVICE_KEY=$SERVICE_ROLE_KEY"
    echo "export PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell}";;
  down) (cd "$DIR" && supabase stop --no-backup 2>&1 | tail -1); proxy_down;;
  *) echo "usage: $0 up|env|status|down"; exit 2;;
esac
