#!/usr/bin/env bash
# RUN 03 live acceptance: the Gmail worktree's app (http://127.0.0.1:3451, isolated stack cs-gmail-sb, Gmail switch ON)
# against REAL Google, with the SAME Keychain credentials as RUN 02B (google-live.sh does everything; this only points it
# at the Gmail stack). Needs the redirect URI http://127.0.0.1:3451/api/google/oauth/callback on the dev OAuth client and the
# Gmail API enabled + gmail.readonly on the consent screen of the DEV project (docs/run03/LIVE_ACCEPTANCE.md).
#   frontend/scripts/gmail-live.sh verify | app | status | revoke-check   (revoke-check: real disconnect + replay of the old refresh token)
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${GMAIL_STACK_DIR:-${TMPDIR:-/tmp}/cs-gmail-sb} GOOGLE_LIVE_PORT=3451
export COLLAB_STACK_NAME_OVERRIDE=cs-gmail-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-gmail-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55565 COLLAB_MAIL_UI_OVERRIDE=55564
export GMAIL_INTEGRATION_ENABLED=1 NEXT_PUBLIC_ENABLE_MONOGRAPH=1
case "${1:-}" in verify|app|status|revoke-check) exec "$HERE/scripts/google-live.sh" "$1";; *) echo "usage: $0 verify|app|status|revoke-check"; exit 2;; esac
