#!/usr/bin/env bash
# RUN 10: Meeting Intelligence pilot switches in Vercel Production (values only via stdin, never argv / chat).
#   frontend/scripts/meetings-prod.sh pilot-on [minutes]   presenter-only pilot (MEETING_PILOT_USER_IDS = Hub pilot id from the Keychain),
#                                                          live + Calendar write (pilot) + PI meetings, demo STT minutes/day (default 30)
#   frontend/scripts/meetings-prod.sh minutes <n>          set the demo STT minutes/day (0 = no paid transcription)
#   frontend/scripts/meetings-prod.sh status              variable NAMES of the RUN 10 switches in Production
# Variables apply to the NEXT deployment only (staged build + check + promote, docs/run10/OPERATIONS.md).
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
eval "$(grep -E '^(HS|NS)=|^REF=|^IMG=' "$HERE/scripts/hub-prod.sh")"
eval "$(sed -n '/^V=\$(ls -d/p;/^kc() /p;/^fail=0;/p;/^VDIR=""; vlink()/p;/^venv() /p;/^push() {/,/^}/p;/^plain() /p' "$HERE/scripts/hub-prod.sh")"
case "${1:-}" in
  pilot-on)
    id=$(kc "$HS" pilot_user_ids); [ -n "$id" ] || { echo "pilot id missing in the Keychain"; exit 2; }
    push MEETING_PILOT_USER_IDS "$id"
    plain MEETING_LIVE_ENABLED 1; plain NEXT_PUBLIC_ENABLE_MEETING_LIVE 1; plain MEETING_LIVE_SEGMENT_MIN 10
    plain CALENDAR_WRITE_ENABLED pilot; plain MEETING_PI_ENABLED 1
    plain AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER "${2:-30}"; plain AI_DEMO_STT_DAILY_AUDIO_MIN_GLOBAL "${2:-30}"
    echo "(variables apply to the NEXT deployment only)"; [ $fail = 0 ] || exit 1;;
  minutes) plain AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER "${2:?n}"; plain AI_DEMO_STT_DAILY_AUDIO_MIN_GLOBAL "$2"; [ $fail = 0 ] || exit 1;;
  status) "$V" api "/v10/projects/$PROJECT/env" --raw --scope "$SCOPE" 2>/dev/null | python3 -c '
import json,sys
print(" ".join(sorted(e["key"] for e in json.load(sys.stdin)["envs"] if "production" in (e.get("target") or []) and e["key"].startswith(("MEETING_","NEXT_PUBLIC_ENABLE_MEETING","CALENDAR_WRITE","AI_DEMO_STT")))))';;
  *) sed -n '2,8p' "$0"; exit 2;;
esac
