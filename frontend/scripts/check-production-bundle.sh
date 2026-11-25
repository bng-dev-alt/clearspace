#!/usr/bin/env bash
# Run after `npm run build`: the PUBLIC client bundle (.next/static) must not contain the dev-login helper, a
# privileged Supabase key, a Google API key, Google OAuth secrets/tokens/server RPC names (RUN 02), a speech-to-text provider key/host/test seam, or the retired Supabase project. Also decodes every JWT in the bundle:
# only the `anon` role may appear. Exit 1 on any finding.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -d .next/static ] || { echo "no .next/static -- run npm run build first"; exit 2; }
bad=0
for pat in 'dev-login-btn' 'api/dev/login' 'clearspace-dev-autologin' 'DEV_AUTO_LOGIN' 'x-clearspace-dev-login' 'DEV_LOGIN' 'service_role' 'AIza' 'bjycwqfessddbfocrggt' 'GEMINI_API_KEY' 'AI_OWNER_USER_IDS' 'AI_DEMO_USER_IDS' 'AI_OWNER_DAILY_TOKEN_BUDGET' 'GEMINI_BASE_URL' 'SONIOX_API_KEY' 'STT_SERVER_SECRET' 'STT_TEST_PUBLIC_STORAGE_ORIGIN' 'p_server_secret' 'SONIOX_BASE_URL' 'api.soniox.com' 'api.eu.soniox.com' 'stt-async-v' 'fake-soniox' 'fake-gemini' 'EMAIL_SERVER_SECRET' 'SMTP_PASSWORD' 'SMTP_USER' 'SMTP_HOST' 'email_delivery_start' 'email_delivery_finish' 'AUTH PLAIN' 'STARTTLS' \
  'GOOGLE_OAUTH_CLIENT_SECRET' 'GOOGLE_SERVER_SECRET' 'GOOGLE_TOKEN_ENCRYPTION_KEY' 'GOOGLE_PICKER_API_KEY' 'GOOGLE_API_MOCK_BASE' 'GOCSPX-' 'ya29.' \
  'oauth2.googleapis.com/token' 'google_credentials_get' 'google_oauth_complete' 'google_refresh_store' 'drive_link_add' 'refresh_token_enc' 'mock-at.' '__control/'; do
  n=$(grep -rlF -- "$pat" .next/static 2>/dev/null | wc -l | tr -d ' ')
  if [ "$n" != 0 ]; then echo "FAIL: '$pat' found in $n client file(s)"; bad=1; else echo "ok - no '$pat' in the client bundle"; fi
done
roles=$(grep -rhoE 'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}' .next/static | sort -u | python3 -c "
import sys,base64,json
for l in sys.stdin:
    p=l.strip().split('.')[1]; p+='='*(-len(p)%4)
    try: print(json.loads(base64.urlsafe_b64decode(p)).get('role'))
    except Exception: print('undecodable')" | sort -u | tr '\n' ' ')
case "$roles" in ""|"anon ") echo "ok - JWT roles in bundle: ${roles:-none}";; *) echo "FAIL: JWT roles in bundle: $roles"; bad=1;; esac
exit $bad
