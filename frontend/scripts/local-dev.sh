#!/usr/bin/env bash
# ONE COMMAND local ClearSpace with a working login (docs/LOCAL_DEV.md). Everything is isolated and on 127.0.0.1:
#   throwaway Supabase stack (s1-local-stack.sh, ports 55520-55529) + FAKE Gemini 55590 / FAKE Soniox 55591 + `next dev` on $PORT (default 3421).
#   scripts/local-dev.sh            # = up + seed + preflight + run the app in the foreground (also what .claude/launch.json runs)
#   scripts/local-dev.sh seed       # (re)create the synthetic dev identity on the LOCAL stack only
#   scripts/local-dev.sh preflight  # check the Auth target + identity (and the running app if APP_URL is set) without starting anything
# Login: NONE needed. Opening http://127.0.0.1:$PORT signs the synthetic dev owner in automatically (lib/devAutoLogin.ts: a real JWT from the
# isolated local GoTrue, RLS unchanged). Explicit-login mode for one tab: log out, or open /login?login=manual (back: ?login=auto);
# whole server without auto-login: DEV_AUTO_LOGIN=0. Real accounts do NOT exist here and must not be copied here; hosted Auth is refused.
# Monograph: MONOGRAPH=1 (default) builds the style selector in; MONOGRAPH=0 = existing style only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export S1_STACK_DIR=${S1_STACK_DIR:-${TMPDIR:-/tmp}/cs-intel-sb}
PORT=${PORT:-3421}; ID_FILE=$S1_STACK_DIR/dev-identity.env; EMAIL=dev-local@example.test
[ -f "$S1_STACK_DIR/supabase/config.toml" ] || { echo "no local stack project in $S1_STACK_DIR (one-time recipe: docs/LOCAL_DEV.md)"; exit 2; }

stack_env() { eval "$(scripts/s1-local-stack.sh env)"; case "$E2E_SUPABASE_URL" in http://127.0.0.1:*) ;; *) echo "refusing: stack URL is not loopback"; exit 2;; esac; }
up() { docker ps -q --filter name=supabase_db_cs-intel-sb | grep -q . || scripts/s1-local-stack.sh up; }
seed() {
  stack_env
  [ -f "$ID_FILE" ] || { umask 077; echo "DEV_LOGIN_PASSWORD=$(openssl rand -hex 24)" > "$ID_FILE"; }
  . "$ID_FILE"
  local h=(-H "apikey: $E2E_SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_KEY" -H 'Content-Type: application/json')
  local id; id=$(curl -s "$E2E_SUPABASE_URL/auth/v1/admin/users?per_page=1000" "${h[@]}" | python3 -c "import json,sys; print(next((u['id'] for u in json.load(sys.stdin).get('users',[]) if u['email']=='$EMAIL'),''))")
  if [ -z "$id" ]; then
    curl -s -o /dev/null -w '' -X POST "$E2E_SUPABASE_URL/auth/v1/admin/users" "${h[@]}" -d "{\"email\":\"$EMAIL\",\"password\":\"$DEV_LOGIN_PASSWORD\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"Dev Local\"}}"
  else # the synthetic identity only exists on this throwaway stack: keep its password in step with $ID_FILE
    curl -s -o /dev/null -X PUT "$E2E_SUPABASE_URL/auth/v1/admin/users/$id" "${h[@]}" -d "{\"password\":\"$DEV_LOGIN_PASSWORD\",\"email_confirm\":true}"
  fi
}
app_env() {
  stack_env; . "$ID_FILE"
  local id; id=$(curl -s "$E2E_SUPABASE_URL/auth/v1/admin/users?per_page=1000" -H "apikey: $E2E_SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_KEY" | python3 -c "import json,sys; print(next((u['id'] for u in json.load(sys.stdin).get('users',[]) if u['email']=='$EMAIL'),''))")
  export NEXT_PUBLIC_SUPABASE_URL=$E2E_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$E2E_SUPABASE_ANON_KEY
  export CLEARSPACE_DEV_LOGIN=1 NEXT_PUBLIC_DEV_LOGIN=1 DEV_LOGIN_EMAIL=$EMAIL DEV_LOGIN_PASSWORD
  if [ "${DEV_AUTO_LOGIN:-1}" = 1 ]; then export CLEARSPACE_DEV_AUTO_LOGIN=1 NEXT_PUBLIC_DEV_AUTO_LOGIN=1; else unset CLEARSPACE_DEV_AUTO_LOGIN NEXT_PUBLIC_DEV_AUTO_LOGIN; fi
  # the synthetic identity is the AI owner of THIS local instance; providers are local fakes (no key, no credit)
  export AI_OWNER_USER_IDS=$id GEMINI_API_KEY=fake GEMINI_BASE_URL=http://127.0.0.1:55590 GEMINI_MODEL=fake-gemini AI_RATE_PER_USER_PER_MINUTE=60
  export STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 SONIOX_API_KEY=fake-soniox-key SONIOX_BASE_URL=http://127.0.0.1:55591/v1 STT_SERVER_SECRET=$(openssl rand -hex 24)
  [ "${MONOGRAPH:-1}" = 1 ] && export NEXT_PUBLIC_ENABLE_MONOGRAPH=1
  unset NEXT_PUBLIC_FORCE_DEMO AI_ALLOW_ALL_AUTHENTICATED VERCEL
}

case "${1:-run}" in
  seed) up; seed; echo "dev identity $EMAIL ready on the local stack";;
  preflight) app_env; node scripts/local-auth-preflight.mjs;;
  run)
    up; seed; app_env; node scripts/local-auth-preflight.mjs
    # register the STT secret's hash on the LOCAL stack (what the owner does once on a real install)
    curl -s -o /dev/null -X POST "$E2E_SUPABASE_URL/rest/v1/server_trust" -H "apikey: $E2E_SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $E2E_SUPABASE_SERVICE_KEY" -H 'Content-Type: application/json' -H 'Prefer: resolution=merge-duplicates,return=minimal' \
      -d "{\"purpose\":\"stt\",\"secret_sha256\":\"$(printf %s "$STT_SERVER_SECRET" | shasum -a 256 | cut -d' ' -f1)\"}"
    node e2e/support/fake-gemini.mjs 55590 >/dev/null 2>&1 & G=$!
    node e2e/support/fake-soniox.mjs 55591 >/dev/null 2>&1 & X=$!
    trap 'kill $G $X 2>/dev/null' EXIT INT TERM
    ./node_modules/.bin/next dev -p "$PORT" -H 127.0.0.1;;
  *) echo "usage: $0 [run|seed|preflight]"; exit 2;;
esac
