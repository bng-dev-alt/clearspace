#!/usr/bin/env bash
# RUN 02: put the Google integration configuration into Vercel (project `clearspace`, Production) -- run by the OWNER,
# after the Google Cloud setup (docs/run02/PRODUCTION_ROLLOUT.md, section 2). Secrets are typed at hidden prompts or
# generated here; they are never on the command line, never echoed, never written to disk (the request body goes to the
# Vercel CLI through stdin). RUN 02C: refuses the DEV project's client id / secret / Picker key (Keychain items of google-live.sh).
#   GOOGLE_OAUTH_CLIENT_SECRET   hidden prompt (from the Google Cloud console)                    -> Sensitive
#   GOOGLE_SERVER_SECRET         generated (64 hex), exists only in Vercel (rotate = new value + new hash)    -> Sensitive
#   GOOGLE_TOKEN_ENCRYPTION_KEY  generated (32 random bytes, base64), exists only in Vercel                   -> Sensitive
#                                (losing it only forces every user to reconnect; never reuse it elsewhere)
#   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_PICKER_API_KEY, GOOGLE_CLOUD_PROJECT_NUMBER: public identifiers, prompted visibly.
# Prints ONLY the SHA-256 of GOOGLE_SERVER_SECRET (for scripts/apply-drive-hosted.sh GOOGLE_SERVER_SECRET_SHA256=...).
# Existing variables are left unchanged (delete them in Vercel first to replace). Deploys nothing.
#   frontend/scripts/set-google-keys.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."                       # frontend/
V=$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1); [ -x "$V" ] || V=vercel
umask 077
DEVSVC='ClearSpace V1 - Google dev (live)'

exists() { "$V" api /v10/projects/clearspace/env --raw 2>/dev/null | python3 -c 'import json,sys;sys.exit(0 if any(e["key"]==sys.argv[1] for e in json.load(sys.stdin)["envs"]) else 1)' "$1"; }
put() {  # $1 key, $2 type (sensitive|encrypted); value in $VAL
  if exists "$1"; then echo "  $1 already exists in Vercel -- left unchanged"; return; fi
  KEY="$1" TYPE="$2" python3 -c 'import json,os;print(json.dumps({"key":os.environ["KEY"],"value":os.environ["VAL"],"type":os.environ["TYPE"],"target":["production"]}))' \
    | "$V" api /v10/projects/clearspace/env -X POST --input - --silent >/dev/null
  echo "  ok - $1 set ($2, Production)"
}

read -rp "GOOGLE_OAUTH_CLIENT_ID (…apps.googleusercontent.com): " CID
[[ "$CID" =~ ^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$ ]] || { echo "not a Web client id"; exit 1; }
[ "$CID" != "$(security find-generic-password -s "$DEVSVC" -a client_id -w 2>/dev/null)" ] || { echo "refusing: this is the DEV project's client id -- production needs its own project (clearspace-prod)"; exit 1; }
read -rp "GOOGLE_CLOUD_PROJECT_NUMBER (digits, not the project id): " PNUM
[[ "$PNUM" =~ ^[0-9]{4,20}$ ]] || { echo "not a project number"; exit 1; }
read -rp "GOOGLE_PICKER_API_KEY (browser key restricted to the Picker API + app origins): " PKEY
[[ "$PKEY" =~ ^AIza[0-9A-Za-z_-]{30,}$ ]] || { echo "not a Google API key"; exit 1; }
read -rsp "GOOGLE_OAUTH_CLIENT_SECRET (hidden): " CSEC </dev/tty; echo
[[ "$CSEC" =~ ^GOCSPX-[A-Za-z0-9_-]{20,}$ ]] || { echo "not an OAuth client secret (GOCSPX-…)"; exit 1; }
[ "$CSEC" != "$(security find-generic-password -s "$DEVSVC" -a client_secret -w 2>/dev/null)" ] || { echo "refusing: this is the DEV client secret"; exit 1; }
[ "$PKEY" != "$(security find-generic-password -s "$DEVSVC" -a picker_key -w 2>/dev/null)" ] || { echo "refusing: this is the DEV Picker API key"; exit 1; }

echo "== Vercel (Production)"
VAL=$CID put GOOGLE_OAUTH_CLIENT_ID encrypted
VAL=$PNUM put GOOGLE_CLOUD_PROJECT_NUMBER encrypted
VAL=$PKEY put GOOGLE_PICKER_API_KEY encrypted
VAL=$CSEC put GOOGLE_OAUTH_CLIENT_SECRET sensitive; unset CSEC
if ! exists GOOGLE_SERVER_SECRET; then
  SS=$(openssl rand -hex 32)
  VAL=$SS put GOOGLE_SERVER_SECRET sensitive
  echo "  GOOGLE_SERVER_SECRET_SHA256=$(printf '%s' "$SS" | shasum -a 256 | cut -d' ' -f1)   (register with apply-drive-hosted.sh)"; unset SS
else echo "  GOOGLE_SERVER_SECRET already exists -- left unchanged"; fi
if ! exists GOOGLE_TOKEN_ENCRYPTION_KEY; then
  EK=$(openssl rand -base64 32)
  VAL=$EK put GOOGLE_TOKEN_ENCRYPTION_KEY sensitive; unset EK
else echo "  GOOGLE_TOKEN_ENCRYPTION_KEY already exists -- left unchanged"; fi
echo "== Privacy policy controller (shown on /privacy; never in the repository). Leave empty to skip."
read -rp "PRIVACY_CONTROLLER (name of the person/company responsible, as it should appear publicly): " PCTL
read -rp "PRIVACY_CONTACT_EMAIL (monitored address for privacy / deletion requests): " PMAIL
if [ -n "$PCTL" ] && [[ "$PMAIL" =~ ^[^[:space:]@\<\>]+@[^[:space:]@\<\>]+\.[A-Za-z]{2,}$ ]]; then
  VAL=$PCTL put PRIVACY_CONTROLLER encrypted; VAL=$PMAIL put PRIVACY_CONTACT_EMAIL encrypted
else echo "  privacy contact skipped (the /privacy page will say the contact is missing; deploy-drive-staged.sh preflight blocks)"; fi
unset VAL PCTL PMAIL
echo "DONE. Nothing was deployed. The redirect URI is built from APP_BASE_URL -- set it to https://clearspace.luffast.com first (scripts/domain-cutover.sh switch-env)."
