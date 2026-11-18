#!/usr/bin/env bash
# Synthetic CZECH test recording for the bounded real Soniox test: macOS `say -v Zuzana` (two "speakers": the second one pitch-shifted),
# a few English words, NO real meeting and NO personal data. Output: <outdir>/synthetic-cs.mp3 (<= 60 s) + <outdir>/reference.json (the spoken text).
#   frontend/scripts/make-synthetic-czech-audio.sh [outdir]
set -euo pipefail
OUT=${1:-${TMPDIR:-/tmp}/cs-synth-audio}; mkdir -p "$OUT"; cd "$OUT"
say -v '?' | grep -q '^Zuzana' || { echo "the Czech voice Zuzana is not installed (System Settings > Accessibility > Spoken Content)"; exit 1; }
LINES=(
"1|Dobrý den, začneme plánovací poradou. Rozhodli jsme, že release posuneme na pátek."
"2|Honza připraví migraci databáze do pětadvacátého listopadu, to slibuji."
"1|Riziko je, že dodavatel může zpozdit certifikát. This is the only blocker for the release."
"2|Kdo zajistí školení týmu? Zatím to nevíme."
)
rm -f part-*.wav; : > list.txt
i=0
for l in "${LINES[@]}"; do
  sp=${l%%|*}; txt=${l#*|}; i=$((i+1))
  say -v Zuzana -r 165 -o "raw-$i.aiff" "$txt"
  if [ "$sp" = 2 ]; then F="asetrate=44100*1.22,aresample=44100,atempo=1/1.22"; else F="anull"; fi
  ffmpeg -loglevel error -y -i "raw-$i.aiff" -af "$F" -ar 16000 -ac 1 "part-$i.wav"
  echo "file 'part-$i.wav'" >> list.txt
  ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.8 "gap-$i.wav"; echo "file 'gap-$i.wav'" >> list.txt
done
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -ar 16000 -ac 1 -b:a 48k synthetic-cs.mp3
python3 - <<PY
import json,subprocess
lines = [l.split('|',1) for l in """$(printf '%s\n' "${LINES[@]}")""".strip().split('\n')]
dur = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0','synthetic-cs.mp3']).decode().strip())
json.dump({'turns':[{'speaker':s,'text':t} for s,t in lines],'durationSec':round(dur,1)}, open('reference.json','w'), ensure_ascii=False, indent=1)
print(f"synthetic-cs.mp3: {dur:.1f} s, {len(lines)} turns, 2 voices")
assert dur <= 60, 'recording must be <= 60 s'
PY
rm -f raw-*.aiff part-*.wav gap-*.wav list.txt
ls -l "$OUT"/synthetic-cs.mp3 "$OUT"/reference.json
