#!/usr/bin/env bash
# Enter the two Resend API keys ONCE, at hidden prompts (never on the command line, never echoed, never written to disk).
#   1. clearspace-production    -> Vercel project `clearspace`, Production, SMTP_PASSWORD (Sensitive)
#   2. clearspace-supabase-auth -> Supabase Auth custom SMTP of twjlnsxjtuntujarwner (smtp.resend.com:465, user resend,
#                                  sender "ClearSpace <ucty@notify.luffast.com>", e-mail rate limit 30/h)
# Each key is first checked by an SMTP login to smtp.resend.com WITHOUT sending anything (nodemailer verify()).
# Uses the existing Vercel CLI login and the Supabase CLI token from the Keychain. Sends no e-mail, deploys nothing.
#   frontend/scripts/set-resend-keys.sh            (from the repository root, after `npm ci` in frontend/)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."                       # frontend/
REF=twjlnsxjtuntujarwner
V=$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1); [ -x "$V" ] || V=vercel
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT; umask 077

smtp_login() {  # $1 = key; exit 0 when Resend accepts the login
  RESEND_KEY="$1" node -e '
    const t = require("nodemailer").createTransport({ host: "smtp.resend.com", port: 465, secure: true,
      auth: { user: "resend", pass: process.env.RESEND_KEY }, connectionTimeout: 10000, tls: { minVersion: "TLSv1.2" } });
    t.verify().then(() => process.exit(0), (e) => { console.error("  SMTP login refused:", e.code || "", e.responseCode || ""); process.exit(1); });'
}
ask() {  # $1 = label -> key on stdout
  local k; read -rsp "$1: " k </dev/tty; echo >&2
  [[ "$k" =~ ^re_[A-Za-z0-9_]{20,}$ ]] || { echo "  this does not look like a Resend API key (re_…)" >&2; return 1; }
  printf '%s' "$k"
}

echo "== 1/2 Vercel SMTP_PASSWORD (key clearspace-production)"
if "$V" api /v10/projects/clearspace/env --raw 2>/dev/null | python3 -c 'import json,sys;sys.exit(0 if any(e["key"]=="SMTP_PASSWORD" for e in json.load(sys.stdin)["envs"]) else 1)'; then
  echo "  SMTP_PASSWORD already exists in Vercel -- left unchanged (delete it in Vercel first to replace it)"
else
  K=$(ask "Resend key clearspace-production"); smtp_login "$K"; echo "  SMTP login ok"
  KEY="$K" python3 -c 'import json,os;print(json.dumps({"key":"SMTP_PASSWORD","value":os.environ["KEY"],"type":"sensitive","target":["production"]}))' > "$TMP/b.json"; unset K
  "$V" api /v10/projects/clearspace/env -X POST --input "$TMP/b.json" --silent >/dev/null; rm -P "$TMP/b.json"
  echo "  ok - SMTP_PASSWORD set (Sensitive, Production)"
fi

echo "== 2/2 Supabase Auth custom SMTP (key clearspace-supabase-auth)"
T=$(security find-generic-password -s 'Supabase CLI' -a supabase -w); case "$T" in go-keyring-base64:*) T=$(printf '%s' "${T#go-keyring-base64:}" | base64 -d);; esac
U=https://api.supabase.com/v1/projects/$REF/config/auth
K=$(ask "Resend key clearspace-supabase-auth"); smtp_login "$K"; echo "  SMTP login ok"
KEY="$K" python3 -c 'import json,os;print(json.dumps({"smtp_host":"smtp.resend.com","smtp_port":"465","smtp_user":"resend","smtp_pass":os.environ["KEY"],
  "smtp_admin_email":"ucty@notify.luffast.com","smtp_sender_name":"ClearSpace","rate_limit_email_sent":30}))' > "$TMP/a.json"; unset K
code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $T" -H 'Content-Type: application/json' --data @"$TMP/a.json" "$U"); rm -P "$TMP/a.json"
[ "$code" = 200 ] || { echo "  Supabase refused the change (HTTP $code) -- nothing else to undo"; exit 1; }
curl -s -H "Authorization: Bearer $T" "$U" | python3 -c 'import json,sys;d=json.load(sys.stdin)
print("  ok - smtp", d["smtp_host"], d["smtp_port"], d["smtp_user"], "sender", d["smtp_sender_name"], "<"+d["smtp_admin_email"]+">", "rate/h", d["rate_limit_email_sent"], "site", d["site_url"], "redirects", d["uri_allow_list"])'
unset T
echo "DONE. No e-mail was sent and nothing was deployed."
