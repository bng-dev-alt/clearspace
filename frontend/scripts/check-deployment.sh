#!/usr/bin/env bash
# Black-box checks of a DEPLOYED ClearSpace V1 build (EXPECT_DRIVE=1 adds the RUN 02C Google Drive checks; EXPECT_GMAIL_OFF=1 the RUN 03C Gmail containment checks) (staged URL or the production domain). Read-only: only GETs and
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
V=${VERCEL_BIN:-$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1)}
SCOPE=${VERCEL_SCOPE:-bng-dev-alt-webadvisor}
fail=0
ok() { echo "ok   - $1"; }; bad() { echo "FAIL - $1"; fail=1; }
get() { # path [curl args...]   (body or headers to stdout)
  local p=$1; shift
  if [ "$MODE" = vercel ]; then "$V" curl "${DEPLOYMENT:?set DEPLOYMENT}$p" --scope "$SCOPE" --yes -- -s "$@" 2>/dev/null
  else curl -s "$@" "$BASE$p"; fi
}
status() { # method path [extra curl args]
  local m=$1 p=$2; shift 2
  if [ "$MODE" = vercel ]; then "$V" curl "$DEPLOYMENT$p" --scope "$SCOPE" --yes -- -s -o /dev/null -w '%{http_code}' -X "$m" "$@" 2>/dev/null
  else curl -s -o /dev/null -w '%{http_code}' -X "$m" "$@" "$BASE$p"; fi
}

echo "== target: $BASE (mode $MODE)"
code=$(status GET /login); [ "$code" = 200 ] && ok "GET /login -> 200" || bad "GET /login -> $code"
H=$(get /login -I)
for h in 'strict-transport-security' 'x-frame-options: DENY' 'x-content-type-options: nosniff' 'content-security-policy'; do
  echo "$H" | tr 'A-Z' 'a-z' | grep -q "$(echo "$h" | tr 'A-Z' 'a-z')" && ok "header $h" || bad "missing header $h"
done
# EVERY AI and transcription route (the firewall rule denies the whole /api/ai prefix): refused on GET and POST, never reaches the app
for r in analyze-resource capacity-planning chat daily-brief generate-backlog generate-project generate-sprint improve project-brief project-manager risk-analysis voice-action \
         meetings/analyze meetings/purge meetings/sweep meetings/sync meetings/transcribe; do
  for m in GET POST; do
    code=$(status $m /api/ai/$r -H 'Content-Type: application/json' -d '{}')
    [ "$code" = 403 ] && ok "$m /api/ai/$r -> 403 (firewall deny)" || bad "$m /api/ai/$r -> $code (expected 403)"
  done
done
# The owner routes live OUTSIDE /api/ai (so the firewall does not hide them): reachable, but an anonymous caller must get 401 and a wrong method 405;
# the owner allowlist (AI_OWNER_USER_IDS) is enforced inside the app after the login is verified (covered by the e2e owner-access spec).
for r in meetings/analyze meetings/purge meetings/sweep meetings/sync meetings/transcribe project-brief chat access; do
  code=$(status POST /api/intelligence/$r -H 'Content-Type: application/json' -d '{}'); [ "$code" = 401 ] && ok "anonymous POST /api/intelligence/$r -> 401" || bad "anonymous POST /api/intelligence/$r -> $code (expected 401)"
  code=$(status GET /api/intelligence/$r); [ "$code" = 405 ] && ok "GET /api/intelligence/$r -> 405" || bad "GET /api/intelligence/$r -> $code (expected 405)"
done
code=$(status POST /api/dev/login -H 'x-clearspace-dev-login: 1'); [ "$code" = 404 ] && ok "POST /api/dev/login -> 404" || bad "POST /api/dev/login -> $code (expected 404)"
# RUN 02C (EXPECT_DRIVE=1, a build that contains the Google Drive release): every dev-login method is a 404, the public pages are
# readable without login, the Google routes refuse anonymous callers and the mock seam is absent.
if [ "${EXPECT_DRIVE:-0}" = 1 ]; then
  for m in GET PUT PATCH DELETE; do code=$(status $m /api/dev/login); [ "$code" = 404 ] && ok "$m /api/dev/login -> 404" || bad "$m /api/dev/login -> $code (expected 404)"; done
  P=$(get /privacy); echo "$P" | grep -q 'drive.file' && echo "$P" | grep -q 'Limited Use' && ok "GET /privacy: Google data disclosure readable without login" || bad "/privacy missing or not server-rendered"
  echo "$P" | grep -q 'privacy-contact-missing' && bad "/privacy: controller contact NOT configured (PRIVACY_CONTROLLER / PRIVACY_CONTACT_EMAIL)" || ok "/privacy: controller contact present"
  get /about | grep -q 'href="/privacy"' && ok "GET /about: homepage links to the privacy policy" || bad "/about missing or without privacy link"
  for r in connection picker-token oauth/start; do
    code=$(status GET /api/google/$r); case "$code" in 401|405) ok "anonymous GET /api/google/$r -> $code";; *) bad "anonymous GET /api/google/$r -> $code (expected 401/405)";; esac
  done
  code=$(status POST /api/google/oauth/complete -H 'Content-Type: application/json' -d '{}'); [ "$code" = 401 ] && ok "anonymous POST /api/google/oauth/complete -> 401" || bad "anonymous POST /api/google/oauth/complete -> $code (expected 401)"
  code=$(status GET /api/google/oauth/callback); case "$code" in 302|303|307|308) ok "GET /api/google/oauth/callback without state -> $code (redirect, no error page)";; *) bad "GET /api/google/oauth/callback -> $code";; esac
  code=$(status GET /__control/state); [ "$code" = 404 ] && ok "no Google mock control route" || bad "/__control/state -> $code"
fi

# RUN 03C (EXPECT_GMAIL_OFF=1, a build with the Gmail code and GMAIL_INTEGRATION_ENABLED off): every Gmail route is closed BEFORE any
# auth or Google config (503 gmail_disabled), the privacy policy says Gmail is off. Authenticated checks: e2e/supabase-hosted.spec.ts.
if [ "${EXPECT_GMAIL_OFF:-0}" = 1 ]; then
  id=11111111-1111-4111-8111-111111111111
  for mp in "GET /api/gmail/search?kind=thread" "POST /api/gmail/links" "GET /api/gmail/links/$id/preview" "POST /api/gmail/links/$id/refresh"; do
    m=${mp%% *}; p=${mp#* }
    b=$(get "$p" -X "$m" -H 'Content-Type: application/json' -d '{}' -w ' HTTP%{http_code}')
    case "$b" in *'"error":"gmail_disabled"'*' HTTP503') ok "$m ${p%%\?*} -> 503 gmail_disabled";; *) bad "$m ${p%%\?*} -> ${b: -7} (expected 503 gmail_disabled)";; esac
  done
  code=$(status POST /api/google/oauth/start -H 'Content-Type: application/json' -d '{"service":"gmail"}'); [ "$code" = 401 ] && ok "anonymous POST /api/google/oauth/start (gmail) -> 401" || bad "anonymous oauth/start gmail -> $code"
  P=$(get /privacy); echo "$P" | grep -q 'privacy-gmail-off' && ! echo "$P" | grep -q 'data-testid="privacy-gmail"' && ok "/privacy: Gmail stated as NOT enabled" || bad "/privacy does not state that Gmail is off"
fi

echo "== client bundle"
CHUNKS=$(get /login | grep -oE '/_next/static/[^"]+\.js' | sort -u)
[ -n "$CHUNKS" ] && ok "found $(echo "$CHUNKS" | wc -l | tr -d ' ') script chunks" || bad "no script chunks found (blocked by protection?)"
BUNDLE=$(mktemp); trap 'rm -f "$BUNDLE"' EXIT
for c in $CHUNKS; do get "$c" >> "$BUNDLE"; done
# grep a FILE: `printf | grep -q` under pipefail reports "not found" when grep exits early (SIGPIPE) on a large bundle
has() { grep -qF -- "$1" "$BUNDLE"; }
has "$EXPECT_REF" && ok "bundle contains the NEW Supabase ref" || bad "bundle does NOT contain $EXPECT_REF"
has "$FORBID_REF" && bad "bundle still contains the retired ref $FORBID_REF" || ok "no retired Supabase ref"
for pat in 'dev-login-btn' 'api/dev/login' 'x-clearspace-dev-login' 'DEV_LOGIN' 'service_role' 'AIza' 'GEMINI_API_KEY' 'AI_OWNER_USER_IDS' 'GEMINI_BASE_URL' 'SONIOX_API_KEY' 'SONIOX_BASE_URL' 'STT_SERVER_SECRET' 'STT_TEST_PUBLIC_STORAGE_ORIGIN' 'p_server_secret' 'api.soniox.com' 'fake-soniox' 'fake-gemini' \
           'GOCSPX-' 'GOOGLE_OAUTH_CLIENT_SECRET' 'GOOGLE_SERVER_SECRET' 'GOOGLE_TOKEN_ENCRYPTION_KEY' 'GOOGLE_API_MOCK_BASE' 'google_credentials_get' 'refresh_token_enc' 'mock-at.' '__control/' 'PRIVACY_CONTACT_EMAIL' 'auth/gmail' 'gmail.googleapis.com' 'GMAIL_INTEGRATION_ENABLED' 'gmail_link_source'; do
  has "$pat" && bad "bundle contains '$pat'" || ok "no '$pat' in the bundle"
done
roles=$(grep -oE 'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}' "$BUNDLE" | sort -u | python3 -c "
import sys,base64,json
for l in sys.stdin:
    p=l.strip().split('.')[1]; p+='='*(-len(p)%4)
    try: print(json.loads(base64.urlsafe_b64decode(p)).get('role'))
    except Exception: print('undecodable')" | sort -u | tr '\n' ' ')
case "$roles" in ""|"anon ") ok "JWT roles in bundle: ${roles:-none}";; *) bad "JWT roles in bundle: $roles";; esac
[ $fail = 0 ] && echo "DEPLOYMENT CHECKS PASSED" || echo "DEPLOYMENT CHECKS FAILED"
exit $fail
