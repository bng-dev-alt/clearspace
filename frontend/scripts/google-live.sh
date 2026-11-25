#!/usr/bin/env bash
# RUN 02B: run the LOCAL app (http://127.0.0.1:3441, isolated stack cs-drive-sb) against REAL Google.
# Credentials live ONLY in the macOS Keychain (service below); they are typed at hidden prompts and handed to
# `security -i` through stdin, so they never appear on a command line, in shell history, in a file, or in the output.
# GOOGLE_SERVER_SECRET / GOOGLE_TOKEN_ENCRYPTION_KEY are the local ones already generated for the stack
# ($DIR/collab-accounts.env, mode 600, outside the repository). No Vercel, no production, no RUN 01 stack.
#
#   frontend/scripts/google-live.sh setup     # hidden prompts: client id, client secret, Picker API key (project number is
#                                             #   derived from the client id and cross-checked)
#   frontend/scripts/google-live.sh status    # which items exist (never values)
#   frontend/scripts/google-live.sh verify    # proves the client id/secret/redirect URI are accepted BY GOOGLE (no login, no consent)
#   frontend/scripts/google-live.sh app       # next dev on 127.0.0.1:3441, real Google, GOOGLE_API_MOCK_BASE unset
#   frontend/scripts/google-live.sh revoke-check  # disconnects the owner for real and proves the grant is dead AT GOOGLE (reconnect after)
#   frontend/scripts/google-live.sh doc-check     # read-only live check of the native Doc preview / refresh / open-original (after the manual steps)
#   frontend/scripts/google-live.sh forget    # delete the Keychain items
# Mock mode stays available: frontend/scripts/drive-stack.sh mock + app (the two never run at the same time).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC=${GOOGLE_LIVE_KEYCHAIN_SERVICE:-ClearSpace V1 - Google dev (live)}
ACCOUNTS=(client_id client_secret picker_key)
DIR=${DRIVE_STACK_DIR:-${TMPDIR:-/tmp}/cs-drive-sb}
PORT=3441
BASE="http://127.0.0.1:$PORT"
REDIRECT="$BASE/api/google/oauth/callback"

kc_get() { security find-generic-password -s "$SVC" -a "$1" -w 2>/dev/null; }
kc_has() { security find-generic-password -s "$SVC" -a "$1" >/dev/null 2>&1; }
kc_put() {  # $1 account; value in $2 -- through stdin of `security -i` (not argv); the value was regex-validated (no quotes)
  printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SVC" "$1" "$2" | security -i >/dev/null 2>&1
}
ask() {  # $1 label, $2 regex, $3 hidden(1/0), $4 expected prefix -> value on stdout
  local v
  if [ "$3" = 1 ]; then read -rsp "$1 (hidden): " v </dev/tty; echo >&2; else read -rp "$1: " v </dev/tty; fi
  v=${v//[[:space:]]/}                                   # a pasted value often carries a newline / spaces
  if ! [[ "$v" =~ $2 ]]; then
    # diagnostics WITHOUT revealing the value: its length and whether it starts with the documented prefix
    echo "  rejected: ${#v} characters, expected prefix '$4' $([[ "$v" == "$4"* ]] && echo present || echo ABSENT) -- nothing stored for this item" >&2
    return 1
  fi
  printf '%s' "$v"
}
load_env() {
  for a in "${ACCOUNTS[@]}"; do kc_has "$a" || { echo "missing Keychain item '$a' -- run: frontend/scripts/google-live.sh setup" >&2; exit 2; }; done
  [ -f "$DIR/collab-accounts.env" ] || { echo "no stack accounts file in $DIR -- run scripts/drive-stack.sh up" >&2; exit 2; }
  # Read only the stack-local server secrets. NEVER source the whole accounts file: it also holds the MOCK client secret.
  acc() { sed -n "s/^$1=//p" "$DIR/collab-accounts.env" | head -1; }
  GOOGLE_SERVER_SECRET=$(acc GOOGLE_SERVER_SECRET); GOOGLE_TOKEN_ENCRYPTION_KEY=$(acc GOOGLE_TOKEN_ENCRYPTION_KEY)
  [ -n "$GOOGLE_SERVER_SECRET" ] && [ -n "$GOOGLE_TOKEN_ENCRYPTION_KEY" ] || { echo "stack Google secrets missing -- run scripts/drive-stack.sh up" >&2; exit 2; }
  GOOGLE_OAUTH_CLIENT_ID=$(kc_get client_id); export GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET=$(kc_get client_secret); export GOOGLE_OAUTH_CLIENT_SECRET
  GOOGLE_PICKER_API_KEY=$(kc_get picker_key); export GOOGLE_PICKER_API_KEY
  GOOGLE_CLOUD_PROJECT_NUMBER=${GOOGLE_OAUTH_CLIENT_ID%%-*}; export GOOGLE_CLOUD_PROJECT_NUMBER
  export GOOGLE_SERVER_SECRET GOOGLE_TOKEN_ENCRYPTION_KEY
  unset GOOGLE_API_MOCK_BASE GOOGLE_MOCK_PORT MOCK_REDIRECT_URIS    # real Google: the mock seam must not exist
  export APP_BASE_URL=$BASE
}
case "${1:-}" in
  setup)
    echo "Stores 3 items in the macOS Keychain ('$SVC'). Each item is stored as soon as it is valid; existing items are kept"
    echo "(use 'forget' first to replace one). Nothing is written to a file or echoed."
    kc_has client_id || { cid=$(ask 'OAuth Client ID (…apps.googleusercontent.com)' '^[0-9]{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$' 0 '') && kc_put client_id "$cid" && echo "  stored client_id (project number …$(kc_get client_id | cut -d- -f1 | tail -c 5))"; }
    kc_has client_secret || { sec=$(ask 'OAuth Client Secret (the NEW one, GOCSPX-…)' '^GOCSPX-[A-Za-z0-9_-]{20,}$' 1 'GOCSPX-') && kc_put client_secret "$sec" && echo "  stored client_secret"; unset sec; }
    kc_has picker_key || { key=$(ask 'Picker API key (AIza…)' '^AIza[0-9A-Za-z_-]{30,}$' 1 'AIza') && kc_put picker_key "$key" && echo "  stored picker_key"; unset key; }
    "$0" status
    ;;
  status)
    for a in "${ACCOUNTS[@]}"; do kc_has "$a" && echo "keychain $a: present" || echo "keychain $a: MISSING"; done
    [ -f "$DIR/collab-accounts.env" ] && echo "stack accounts file: present, mode $(stat -f %Lp "$DIR/collab-accounts.env")" || echo "stack accounts file: MISSING"
    ;;
  verify)
    load_env
    node --input-type=module -e '
      const { GOOGLE_OAUTH_CLIENT_ID: id, GOOGLE_OAUTH_CLIENT_SECRET: secret } = process.env;
      const redirect = process.argv[1];
      const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "invalid-code-for-config-check", code_verifier: "x".repeat(43), client_id: id, client_secret: secret, redirect_uri: redirect }) });
      const tj = await t.json().catch(() => ({}));
      // invalid_grant = Google accepted the client id + secret and only rejected our fake code; invalid_client = wrong id/secret
      console.log("token endpoint  ->", t.status, tj.error ?? "?", tj.error === "invalid_grant" ? "(client id + secret ACCEPTED by Google)" : tj.error === "invalid_client" ? "(client id or secret REFUSED)" : "");
      const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: "code", state: "s".repeat(43), code_challenge: "c".repeat(43), code_challenge_method: "S256",
        scope: "openid email https://www.googleapis.com/auth/drive.file" });
      const a = await fetch("https://accounts.google.com/o/oauth2/v2/auth?" + q, { redirect: "manual" });
      const body = a.status >= 400 ? await a.text() : "";
      const bad = /redirect_uri_mismatch|invalid_client|invalid_request|deleted_client/.exec(body)?.[0];
      console.log("auth endpoint   ->", a.status, bad ?? "no error page", a.status >= 300 && a.status < 400 && /accounts\.google\.com/.test(a.headers.get("location") ?? "") ? "(redirect URI + client ACCEPTED; sign-in page is the next step, not performed)" : "");
      const num = id.split("-")[0];
      console.log("project number  -> …" + num.slice(-4), "(derived from the client id)");
    ' "$REDIRECT"
    ;;
  app)
    load_env
    export PORT COLLAB_STACK_DIR=$DIR COLLAB_STACK_NAME=cs-drive-sb COLLAB_STACK_SOCK=/tmp/cs-drive-docker.sock COLLAB_SMTP_PORT=55545 COLLAB_MAIL_UI=55544
    [[ "$GOOGLE_OAUTH_CLIENT_SECRET" == GOCSPX-* ]] || { echo "refusing: the client secret does not have Google's GOCSPX- format (mock value?)" >&2; exit 2; }
    echo "real Google; client secret format: GOCSPX; APP_BASE_URL=$APP_BASE_URL; GOOGLE_API_MOCK_BASE=${GOOGLE_API_MOCK_BASE:-<unset>}; redirect URI=$REDIRECT"
    exec "$HERE/scripts/collab-stack.sh" app
    ;;
  revoke-check)  # RUN 02B: disconnect for real, then replay the OLD refresh token -> Google must say invalid_grant (reconnect afterwards)
    load_env
    export COLLAB_STACK_DIR=$DIR COLLAB_STACK_NAME=cs-drive-sb COLLAB_STACK_SOCK=/tmp/cs-drive-docker.sock COLLAB_SMTP_PORT=55545 COLLAB_MAIL_UI=55544
    eval "$("$HERE/scripts/collab-stack.sh" env)"
    export E2E_BASE_URL=$BASE E2E_PASSWORD=$(acc COLLAB_PASSWORD)
    exec node "$HERE/supabase/tests/google_live_revoke.mjs"
    ;;
  doc-check)  # RUN 02B: after the manual steps (native Doc attached at project level via the real Picker, then renamed in Drive)
    load_env
    export COLLAB_STACK_DIR=$DIR COLLAB_STACK_NAME=cs-drive-sb COLLAB_STACK_SOCK=/tmp/cs-drive-docker.sock COLLAB_SMTP_PORT=55545 COLLAB_MAIL_UI=55544
    eval "$("$HERE/scripts/collab-stack.sh" env)"
    cd "$HERE" && E2E_LIVE_DOC=1 E2E_PASSWORD=$(acc COLLAB_PASSWORD) DEV_AUTO_LOGIN=0 PLAYWRIGHT_TEST_BASE_URL=$BASE \
      PW_CHROMIUM_PATH=${PW_CHROMIUM_PATH:-$(find "$HOME/Library/Caches/ms-playwright" -path '*chromium_headless_shell*' -name chrome-headless-shell -type f 2>/dev/null | head -1)} \
      exec npx playwright test e2e/google-drive-live-doc.spec.ts --reporter=line
    ;;
  forget)
    for a in "${ACCOUNTS[@]}"; do security delete-generic-password -s "$SVC" -a "$a" >/dev/null 2>&1 && echo "deleted $a" || echo "$a: nothing to delete"; done
    ;;
  *) echo "usage: $0 setup|status|verify|app|revoke-check|doc-check|forget"; exit 2;;
esac
