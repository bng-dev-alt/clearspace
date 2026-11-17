#!/usr/bin/env bash
# Sets the dedicated V1 Gemini key (and a VERIFIED model id) on the Vercel project `clearspace`.
#
# Run it in YOUR terminal: the key is read from a hidden prompt, kept only in a shell variable, sent to Google
# through `curl -K -` (config on stdin, so it never appears in a process list) and to Vercel through stdin.
# Nothing secret is printed, logged or written to disk; only model ids and variable names are shown.
#
#  1. validates the key with Google's FREE metadata endpoint (models.list) and `countTokens` (free, no generation)
#  2. picks the first model of the preference list that this key can really use for generateContent
#  3. only then updates GEMINI_API_KEY and GEMINI_MODEL (Production + Preview — both live in ONE variable entry)
#  4. reads the variable metadata back (names/targets/types/updatedAt; values of sensitive variables are unreadable)
# It never touches V2, the old key, other Vercel variables or other projects. Abort with Ctrl-C at the prompt.
set -uo pipefail
SCOPE=bng-dev-alt-webadvisor; PROJECT=clearspace; PID=prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg
V=${VERCEL_BIN:-/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel}
CANDIDATES=${MODEL_CANDIDATES:-"gemini-3.6-flash gemini-3.8-flash gemini-3.5-flash-lite gemini-3.1-flash-lite"}
LOG=${RESULT_LOG:-${TMPDIR:-/tmp}/gemini_setup_result.txt}
: > "$LOG"; say() { echo "$*" | tee -a "$LOG"; }

printf 'Vlozte Gemini API klic pro ClearSpace V1 (vstup je skryty) a stisknete Enter: '
IFS= read -rs KEY; echo
[ -n "$KEY" ] || { say "ABORT: empty input, nothing changed"; exit 1; }
case "$KEY" in AIza*) ;; *) say "note: key does not start with 'AIza' (unusual format, continuing to the API check)";; esac

gcurl() { # path [extra curl args] ; key via stdin config, never argv
  local p=$1; shift
  printf 'header = "x-goog-api-key: %s"\n' "$KEY" | curl -sS -K - "$@" "https://generativelanguage.googleapis.com/v1beta/$p"
}
say "== 1. Google: models.list (free metadata call)"
TMPJ=$(mktemp); trap 'rm -f "$TMPJ"; unset KEY' EXIT
code=$(gcurl "models?pageSize=200" -o "$TMPJ" -w '%{http_code}')
if [ "$code" != 200 ]; then
  say "ABORT: Google answered HTTP $code — key rejected or API not enabled; nothing changed. Reason: $(python3 -c "import json,sys; d=json.load(open('$TMPJ')); print(d.get('error',{}).get('status'), '-', d.get('error',{}).get('message','')[:160])" 2>/dev/null)"
  exit 1
fi
USABLE=$(python3 - "$TMPJ" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]))
print(' '.join(m['name'].split('/')[-1] for m in d.get('models',[]) if 'generateContent' in m.get('supportedGenerationMethods',[])))
EOF
)
say "models this key can call with generateContent: $(echo "$USABLE" | wc -w | tr -d ' ')"
MODEL=""
for c in $CANDIDATES; do
  if echo " $USABLE " | grep -q " $c "; then say "  candidate $c: AVAILABLE"; [ -z "$MODEL" ] && MODEL=$c; else say "  candidate $c: not listed"; fi
done
if [ -z "$MODEL" ]; then say "ABORT: none of the candidates is available. Flash-class ids offered to this key: $(echo "$USABLE" | tr ' ' '\n' | grep -i flash | head -12 | tr '\n' ' ')"; exit 1; fi
say "== 2. countTokens on $MODEL (free, no generation)"
code=$(gcurl "models/$MODEL:countTokens" -H 'Content-Type: application/json' -d '{"contents":[{"parts":[{"text":"ping"}]}]}' -o "$TMPJ" -w '%{http_code}')
[ "$code" = 200 ] && say "  OK (HTTP 200, totalTokens=$(python3 -c "import json; print(json.load(open('$TMPJ')).get('totalTokens'))"))" || { say "ABORT: countTokens HTTP $code; nothing changed"; exit 1; }
say "chosen model: $MODEL"

say "== 3. Vercel: update GEMINI_API_KEY and GEMINI_MODEL ($PROJECT, scope $SCOPE)"
printf '%s' "$KEY" | "$V" env update GEMINI_API_KEY --environment production --sensitive --yes -p "$PROJECT" --scope "$SCOPE" 2>&1 | grep -E -i "updated|error|reason|✓" | sed -E 's/AIza[A-Za-z0-9_-]+/<redacted>/g' | tee -a "$LOG"
printf '%s' "$MODEL" | "$V" env update GEMINI_MODEL --environment production --sensitive --yes -p "$PROJECT" --scope "$SCOPE" 2>&1 | grep -E -i "updated|error|reason|✓" | tee -a "$LOG"
unset KEY

say "== 4. read-back (metadata only)"
"$V" api "/v10/projects/$PID/env?decrypt=false" --scope "$SCOPE" 2>/dev/null | python3 -W ignore -c "
import sys,json,datetime
t=sys.stdin.read(); d=json.loads(t[t.index('{'):])
for e in sorted(d['envs'],key=lambda e:e['key']):
    if e['key'].startswith('GEMINI'): print(f\"  {e['key']:16} targets={','.join(e['target'])} type={e['type']} updated={datetime.datetime.fromtimestamp(e['updatedAt']/1000,datetime.UTC):%Y-%m-%d %H:%M}Z\")" | tee -a "$LOG"
say "DONE. (log without secrets: $LOG)"
