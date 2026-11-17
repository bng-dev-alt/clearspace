#!/usr/bin/env bash
# Black-box checks of a DEPLOYED ClearSpace V1 build (staged URL or the production domain). Read-only: only GETs and
# two POSTs that must be refused. Exit 1 on any FAIL.
#
#   scripts/check-deployment.sh https://clearspace-ai.vercel.app                       # public production domain (direct curl)
#   MODE=vercel DEPLOYMENT=<staged-url> scripts/check-deployment.sh <staged-url>      # protected URL via `vercel curl`
#                                                                                      # (CLI-authenticated protection bypass)
# EXPECT_REF  = Supabase ref that MUST be in the bundle      (default: the new project)
# FORBID_REF  = ref that MUST NOT be in the bundle           (default: the retired project)
set -uo pipefail
BASE=${1:?usage: check-deployment.sh <base-url>}
MODE=${MODE:-direct}
EXPECT_REF=${EXPECT_REF:-twjlnsxjtuntujarwner}
FORBID_REF=${FORBID_REF:-bjycwqfessddbfocrggt}
V=${VERCEL_BIN:-/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel}
SCOPE=${VERCEL_SCOPE:-bng-dev-alt-webadvisor}
fail=0
ok() { echo "ok   - $1"; }; bad() { echo "FAIL - $1"; fail=1; }
get() { # path [curl args...]   (body or headers to stdout)
  local p=$1; shift
  if [ "$MODE" = vercel ]; then "$V" curl "$p" --deployment "${DEPLOYMENT:?set DEPLOYMENT}" --scope "$SCOPE" --yes -- -s "$@" 2>/dev/null
  else curl -s "$@" "$BASE$p"; fi
}
status() { # method path [extra curl args]
  local m=$1 p=$2; shift 2
  if [ "$MODE" = vercel ]; then "$V" curl "$p" --deployment "$DEPLOYMENT" --scope "$SCOPE" --yes -- -s -o /dev/null -w '%{http_code}' -X "$m" "$@" 2>/dev/null
  else curl -s -o /dev/null -w '%{http_code}' -X "$m" "$@" "$BASE$p"; fi
}

echo "== target: $BASE (mode $MODE)"
code=$(status GET /login); [ "$code" = 200 ] && ok "GET /login -> 200" || bad "GET /login -> $code"
H=$(get /login -I)
for h in 'strict-transport-security' 'x-frame-options: DENY' 'x-content-type-options: nosniff' 'content-security-policy'; do
  echo "$H" | tr 'A-Z' 'a-z' | grep -q "$(echo "$h" | tr 'A-Z' 'a-z')" && ok "header $h" || bad "missing header $h"
done
code=$(status POST /api/ai/improve -H 'Content-Type: application/json' -d '{}'); [ "$code" = 403 ] && ok "POST /api/ai/improve -> 403 (firewall deny)" || bad "POST /api/ai/improve -> $code (expected 403)"
code=$(status POST /api/dev/login -H 'x-clearspace-dev-login: 1'); [ "$code" = 404 ] && ok "POST /api/dev/login -> 404" || bad "POST /api/dev/login -> $code (expected 404)"

echo "== client bundle"
CHUNKS=$(get /login | grep -oE '/_next/static/[^"]+\.js' | sort -u)
[ -n "$CHUNKS" ] && ok "found $(echo "$CHUNKS" | wc -l | tr -d ' ') script chunks" || bad "no script chunks found (blocked by protection?)"
ALL=$(for c in $CHUNKS; do get "$c"; done)
has() { printf '%s' "$ALL" | grep -qF -- "$1"; }
has "$EXPECT_REF" && ok "bundle contains the NEW Supabase ref" || bad "bundle does NOT contain $EXPECT_REF"
has "$FORBID_REF" && bad "bundle still contains the retired ref $FORBID_REF" || ok "no retired Supabase ref"
for pat in 'dev-login-btn' 'api/dev/login' 'x-clearspace-dev-login' 'DEV_LOGIN' 'service_role' 'AIza' 'GEMINI_API_KEY'; do
  has "$pat" && bad "bundle contains '$pat'" || ok "no '$pat' in the bundle"
done
roles=$(printf '%s' "$ALL" | grep -oE 'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}' | sort -u | python3 -c "
import sys,base64,json
for l in sys.stdin:
    p=l.strip().split('.')[1]; p+='='*(-len(p)%4)
    try: print(json.loads(base64.urlsafe_b64decode(p)).get('role'))
    except Exception: print('undecodable')" | sort -u | tr '\n' ' ')
case "$roles" in ""|"anon ") ok "JWT roles in bundle: ${roles:-none}";; *) bad "JWT roles in bundle: $roles";; esac
[ $fail = 0 ] && echo "DEPLOYMENT CHECKS PASSED" || echo "DEPLOYMENT CHECKS FAILED"
exit $fail
