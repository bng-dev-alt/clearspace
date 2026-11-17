#!/usr/bin/env bash
# One-time setup of the DEV LOGIN account for the consolidation worktree (see src/lib/devLogin.ts).
#
#  * creates (if absent) one dedicated, e-mail-confirmed, disposable account in the project named in
#    .env.local -- through the GoTrue admin API, using the service-role key fetched from the Supabase CLI
#    for this one call. The key is held in a shell variable only: never printed, never written to disk.
#  * writes DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD (server-only, NOT NEXT_PUBLIC) and the two enable flags into
#    the git-ignored .env.local (mode 600).
#  * refuses to run against anything but a *.supabase.co project, and never touches another project.
# Remove the account (and the flags) before any public release: see docs/RELEASE_PLAN.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENVF=.env.local
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$ENVF" | cut -d= -f2-)
REF=$(printf '%s' "$URL" | sed -E 's#^https://([a-z0-9]+)\.supabase\.co/?$#\1#')
[ "$REF" != "$URL" ] || { echo "NEXT_PUBLIC_SUPABASE_URL is not a hosted *.supabase.co URL"; exit 1; }
EMAIL=dev-login@example.test
if grep -q '^DEV_LOGIN_PASSWORD=' "$ENVF"; then echo "dev login already configured in $ENVF"; exit 0; fi
PW=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 28)
SRK=$(supabase projects api-keys --project-ref "$REF" --workdir "${TMPDIR:-/tmp}" --output-format json | python3 -c "import json,sys; print(next(k['api_key'] for k in json.load(sys.stdin)['keys'] if k['name']=='service_role'))")
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/auth/v1/admin/users" -H "apikey: $SRK" -H "Authorization: Bearer $SRK" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"Dev Login\"}}")
[ "$code" = 200 ] || { echo "admin create failed (HTTP $code) -- the account may already exist; reset its password in the dashboard and add DEV_LOGIN_PASSWORD manually"; exit 1; }
umask 077
{ echo; echo "# Dev login (lokální, jen loopback; viz src/lib/devLogin.ts)"; echo "CLEARSPACE_DEV_LOGIN=1"; echo "NEXT_PUBLIC_DEV_LOGIN=1"; echo "DEV_LOGIN_EMAIL=$EMAIL"; echo "DEV_LOGIN_PASSWORD=$PW"; } >> "$ENVF"
chmod 600 "$ENVF"
echo "dev account created and configured; restart 'next dev'"
