#!/usr/bin/env bash
# Isolated LOCAL stack for the Gmail integration (RUN 03): own Supabase CLI stack (cs-gmail-sb, ports 55550-55559 + mail 55564/55565, loopback
# only) + the deterministic Google MOCK (scripts/google-mock.mjs incl. Gmail, 127.0.0.1:55591). Never hosted, never real Google,
# never the RUN 01 (cs-collab-sb) / RUN 02 (cs-drive-sb) stacks or ClearSpace V2. Template: drive-stack.sh.
#   frontend/scripts/gmail-stack.sh up       # stack + baseline + migrations + server_trust('email','google')
#   frontend/scripts/gmail-stack.sh seed     # synthetic accounts alice/bob/vera@collab.test + shared project
#   frontend/scripts/gmail-stack.sh mock     # Google + Gmail mock in the foreground (SIMULACE)
#   frontend/scripts/gmail-stack.sh app      # next dev on http://127.0.0.1:3451 against stack + mock, DEV login (one link)
#   eval "$(frontend/scripts/gmail-stack.sh env)"
#   frontend/scripts/gmail-stack.sh down
# One-time: copy the cs-drive-sb supabase/config.toml to $TMPDIR/cs-gmail-sb/supabase/ with ports 5554x -> 5555x,
# project_id cs-gmail-sb, site_url/redirects 127.0.0.1:3451. Generated secrets live in $DIR/collab-accounts.env (0600).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
export DRIVE_STACK_DIR=${GMAIL_STACK_DIR:-${TMPDIR:-/tmp}/cs-gmail-sb}
export PORT=${PORT:-3451} GOOGLE_MOCK_PORT=${GOOGLE_MOCK_PORT:-55591}
# drive-stack.sh derives everything else from these; only the stack identity differs
export COLLAB_STACK_NAME_OVERRIDE=cs-gmail-sb COLLAB_STACK_SOCK_OVERRIDE=/tmp/cs-gmail-docker.sock COLLAB_SMTP_PORT_OVERRIDE=55565 COLLAB_MAIL_UI_OVERRIDE=55564
# Gmail feature switch (independent of Drive): on for this local stack only.
export GMAIL_INTEGRATION_ENABLED=${GMAIL_INTEGRATION_ENABLED:-1}
# Monograph style selectable like in production (Classic stays the default; MONOGRAPH=0 to build without it).
[ "${MONOGRAPH:-1}" = 1 ] && export NEXT_PUBLIC_ENABLE_MONOGRAPH=1
exec "$HERE/scripts/drive-stack.sh" "$@"
