#!/usr/bin/env bash
# RUN 06 Google demo seeder launcher. Secrets live ONLY in the macOS Keychain ("ClearSpace V1 - Google demo seeder"), entered through
# hidden prompts; nothing is written to a file, echoed or committed. The seeder has its OWN Desktop OAuth client (dev project).
#   frontend/scripts/google-demo.sh setup        3 prompts: seeder client id, seeder client secret (hidden), demo account e-mail
#   frontend/scripts/google-demo.sh status|forget
#   frontend/scripts/google-demo.sh plan|auth|seed|status-google|cleanup|revoke [args]   -> scripts/google-demo/seed.mjs
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SVC="ClearSpace V1 - Google demo seeder"
ACCOUNTS=(client_id client_secret demo_account)
kc_has() { security find-generic-password -s "$SVC" -a "$1" >/dev/null 2>&1; }
kc_put() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$SVC" "$1" "$2" | security -i >/dev/null 2>&1; }
ask() {  # $1 label, $2 regex, $3 hidden(1/0)
  local v
  if [ "$3" = 1 ]; then read -rsp "$1 (hidden): " v </dev/tty; echo >&2; else read -rp "$1: " v </dev/tty; fi
  v=${v//[[:space:]]/}
  [[ "$v" =~ $2 ]] || { echo "  rejected (${#v} characters, wrong format) -- nothing stored for this item" >&2; return 1; }
  printf '%s' "$v"
}
case "${1:-}" in
  setup)
    echo "Stores 3 items in the Keychain ('$SVC'); existing items are kept (use 'forget' to replace)."
    kc_has client_id || { v=$(ask 'Seeder OAuth Client ID (Desktop app, …apps.googleusercontent.com)' '^[0-9]{6,20}-[a-z0-9]{20,40}\.apps\.googleusercontent\.com$' 0) && kc_put client_id "$v" && echo "  stored client_id"; }
    kc_has client_secret || { v=$(ask 'Seeder OAuth Client Secret (GOCSPX-…)' '^GOCSPX-[A-Za-z0-9_-]{20,}$' 1) && kc_put client_secret "$v" && echo "  stored client_secret"; unset v; }
    kc_has demo_account || { v=$(ask 'Demo Google account e-mail (the ONLY account the seeder may write to)' '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' 0) && kc_put demo_account "$v" && echo "  stored demo_account"; }
    "$0" status;;
  status) for a in "${ACCOUNTS[@]}" refresh_token; do kc_has "$a" && echo "keychain $a: present" || echo "keychain $a: missing"; done;;
  forget) for a in "${ACCOUNTS[@]}" refresh_token; do security delete-generic-password -s "$SVC" -a "$a" >/dev/null 2>&1 && echo "deleted $a" || echo "$a: nothing to delete"; done;;
  status-google) exec node "$HERE/scripts/google-demo/seed.mjs" status "${@:2}";;
  plan|auth|seed|cleanup|revoke) exec node "$HERE/scripts/google-demo/seed.mjs" "$@";;
  *) echo "usage: $0 setup|status|forget|plan|auth|seed|status-google|cleanup|revoke"; exit 2;;
esac
