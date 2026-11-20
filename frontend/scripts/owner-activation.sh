#!/usr/bin/env bash
# PREPARED, NOT RUN: owner-only activation of Meeting Intelligence (Soniox + Gemini) on the Vercel project `clearspace` and the hosted Supabase.
# It changes NOTHING in production by itself in the way that matters: Vercel env changes apply only to NEW deployments (the live deployment is immutable),
# so a separate, approved deployment step (docs/intelligence/OWNER_ACTIVATION.md) is what makes it live. It does NOT touch the Vercel firewall, Cloudflare,
# Git, other Vercel variables or other projects.
#   scripts/owner-activation.sh                                   # DRY RUN: prints exactly what it would do, reads no secret, writes nothing
#   CONFIRM_OWNER_ACTIVATION=1 scripts/owner-activation.sh        # the real thing (separate owner approval), in YOUR terminal
#   CONFIRM_OWNER_ACTIVATION=1 scripts/owner-activation.sh remove # removes the activation variables again (rollback of the configuration)
# Secrets: the Soniox key is typed at a HIDDEN prompt; the STT server secret is generated here (openssl) and never shown. Both go to Vercel through stdin
# as Sensitive variables; Soniox only ever sees the key through curl's stdin config. Nothing secret is printed, logged, written to a file or put in argv.
set -uo pipefail
REF=twjlnsxjtuntujarwner; SCOPE=bng-dev-alt-webadvisor; PROJECT=clearspace; PID=prj_yFGiOmACsu4iILF6nb6Q0aDgG8gg
V=${VERCEL_BIN:-/Users/beng/.npm/_npx/67eb4586ca667318/node_modules/.bin/vercel}
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"; IMG=public.ecr.aws/supabase/postgres:17.6.1.147
# small FIRST budgets (changeable later): audio minutes per day per user / in total, how long the uploaded audio is kept, daily Gemini token budget per user
AUDIO_USER=${AUDIO_MIN_PER_USER:-30}; AUDIO_GLOBAL=${AUDIO_MIN_GLOBAL:-30}; RETENTION=${RETENTION_DAYS:-3}
PLAIN="STT_ENABLED=1 NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1 SONIOX_REGION=us SONIOX_MODEL=stt-async-v6 STT_DAILY_AUDIO_MIN_PER_USER=$AUDIO_USER STT_DAILY_AUDIO_MIN_GLOBAL=$AUDIO_GLOBAL STT_RETENTION_DAYS=$RETENTION"
SECRETS="AI_OWNER_USER_IDS SONIOX_API_KEY STT_SERVER_SECRET"   # all Sensitive (the owner id too: it is nobody else's business)
setvar() { # name  (value on stdin)  sensitive|plain ; returns non-zero on any CLI failure (the old pipe swallowed the exit status)
  local flag=--no-sensitive out rc; [ "$2" = sensitive ] && flag=--sensitive
  out=$("$V" env add "$1" --environment production $flag --force --yes -p "$PROJECT" --scope "$SCOPE" 2>&1); rc=$?
  printf '%s\n' "$out" | grep -E -i "added|updated|overrid|error|reason" | sed -E 's/(Bearer |key[= ])[A-Za-z0-9_-]{16,}/<redacted>/g' | sed "s/^/  $1: /"
  return $rc
}
verify() { # every activation variable exists with target production only and the expected type; metadata only
  "$V" api "/v10/projects/$PID/env?decrypt=false" --scope "$SCOPE" 2>/dev/null | SECRETS="$SECRETS" PLAIN="$PLAIN" python3 -W ignore -c "
import sys,json,os
t=sys.stdin.read(); d=json.loads(t[t.index('{'):]); m={e['key']:e for e in d['envs']}
bad=0
for k in os.environ['SECRETS'].split():
    e=m.get(k); ok=bool(e) and e['type']=='sensitive' and e['target']==['production']
    if not ok: bad+=1; print('  MISSING/WRONG', k, (e['type'], e['target']) if e else None)
for kv in os.environ['PLAIN'].split():
    k=kv.split('=')[0]; e=m.get(k); ok=bool(e) and e['type']!='sensitive' and e['target']==['production']
    if not ok: bad+=1; print('  MISSING/WRONG', k, (e['type'], e['target']) if e else None)
print('  verify:', 'OK all 10 present, production only' if not bad else f'{bad} problem(s)'); sys.exit(1 if bad else 0)"
}
readback() { "$V" api "/v10/projects/$PID/env?decrypt=false" --scope "$SCOPE" 2>/dev/null | python3 -W ignore -c "
import sys,json
t=sys.stdin.read(); d=json.loads(t[t.index('{'):])
for e in sorted(d['envs'],key=lambda e:e['key']): print(f\"  {e['key']:34} targets={','.join(e['target'])} type={e['type']}\")"; }

if [ "${CONFIRM_OWNER_ACTIVATION:-}" != 1 ]; then
  cat <<PLAN
DRY RUN (nothing is read, written or contacted). With CONFIRM_OWNER_ACTIVATION=1 this would, in order:
  1. ask for the OWNER's account e-mail (visible, not secret) and look up that account's id on hosted Supabase $REF (read-only); it must match exactly ONE confirmed account
  2. ask for the Soniox API key at a HIDDEN prompt and check it with the free read-only call GET https://api.soniox.com/v1/files?limit=1 (must be HTTP 200; region us)
  0. (before any prompt) preflight: the Vercel CLI must be logged in and the project env readable, otherwise it refuses without changing anything
  3. generate STT_SERVER_SECRET (openssl rand -hex 32) in memory and set these Production variables on Vercel project $PROJECT (scope $SCOPE) from stdin:
       Sensitive: $SECRETS
       Plain:     $PLAIN
     (the existing GEMINI_*, AI_RATE_*, AI_DAILY_TOKEN_BUDGET_PER_USER and the Supabase pair are NOT touched)
  4. read the variable names/types back (metadata only, never values) and verify all 10 are there, production-only, with the right type; any failure stops here
  5. only then register ONLY the SHA-256 of that secret in public.server_trust (purpose 'stt') on the hosted database: ONE row, upsert
  and STOP: nothing is live until a new deployment is built and promoted (separate approval)
Rollback of the configuration: CONFIRM_OWNER_ACTIVATION=1 scripts/owner-activation.sh remove   (removes: $SECRETS $(echo $PLAIN | sed -E 's/=[^ ]*//g'))
PLAN
  exit 0
fi

if [ "${1:-}" = remove ]; then
  echo "== removing the activation variables from Production (names only)"
  for n in $SECRETS $(echo $PLAIN | sed -E 's/=[^ ]*//g'); do "$V" env rm "$n" production --yes -p "$PROJECT" --scope "$SCOPE" 2>&1 | grep -E -i "removed|error|not found" | sed "s/^/  $n: /"; done
  echo "== now:"; readback; echo "(the server_trust hash stays: it is harmless without the secret. Env changes affect only NEW deployments.)"; exit 0
fi

command -v docker >/dev/null || { echo "docker is required (psql runs in a container)"; exit 2; }
# PREFLIGHT (before any prompt or write): a logged-out CLI must fail here, not halfway through (that left an orphan server_trust hash once)
"$V" whoami --scope "$SCOPE" >/dev/null 2>&1 || { echo "refusing: the Vercel CLI ($V) is not logged in (run: npx vercel login). Nothing was changed."; exit 2; }
"$V" api "/v10/projects/$PID/env?decrypt=false" --scope "$SCOPE" >/dev/null 2>&1 || { echo "refusing: cannot read project $PROJECT env metadata. Nothing was changed."; exit 2; }
PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
[ -n "$PGPASSWORD" ] || { echo "refusing: database password not found in the Keychain"; exit 2; }
pg() { docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X -v ON_ERROR_STOP=1 "$@"; }
trap 'unset PGPASSWORD KEY SECRET' EXIT

if [ -n "${OWNER_EMAIL:-}" ]; then EMAIL=$OWNER_EMAIL; else printf 'E-mail vlastnickeho uctu ClearSpace (zadejte presne): '; IFS= read -r EMAIL; fi
case "$EMAIL" in *"'"*|*";"*|"") echo "refusing that e-mail"; exit 2;; esac
OWNER_ID=$(pg -At -c "select string_agg(id::text, ',') from auth.users where lower(email)=lower('$EMAIL') and email_confirmed_at is not null")
echo "$OWNER_ID" | grep -qE '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' || { echo "refusing: the e-mail must match exactly ONE confirmed account (got: '${OWNER_ID:-none}')"; exit 2; }
echo "owner account id: $OWNER_ID"

printf 'Vlozte Soniox API klic (vstup je skryty) a stisknete Enter: '; IFS= read -rs KEY; echo
[ -n "$KEY" ] || { echo "empty key, nothing done"; exit 1; }
c=$(printf 'header = "Authorization: Bearer %s"\n' "$KEY" | curl -s -o /dev/null -w '%{http_code}' --max-time 20 -K - "https://api.soniox.com/v1/files?limit=1")
[ "$c" = 200 ] || { echo "Soniox (region us) answered HTTP $c to the free key check: key or region wrong; NOTHING was changed"; exit 1; }
echo "Soniox key accepted by region us (free read-only call)"

SECRET=$(openssl rand -hex 32); HASH=$(printf %s "$SECRET" | shasum -a 256 | cut -d' ' -f1)

# Order matters: Vercel FIRST (idempotent --force), the DB hash LAST. A failure in between leaves a secret in Vercel whose hash is not yet registered
# (STT simply refuses, fail closed) and a re-run repairs it; the old order left a registered hash whose secret was lost with the process.
echo "== 3. Vercel Production variables"
FAIL=0
printf '%s' "$OWNER_ID" | setvar AI_OWNER_USER_IDS sensitive || FAIL=1
printf '%s' "$KEY" | setvar SONIOX_API_KEY sensitive || FAIL=1
printf '%s' "$SECRET" | setvar STT_SERVER_SECRET sensitive || FAIL=1
for kv in $PLAIN; do printf '%s' "${kv#*=}" | setvar "${kv%%=*}" plain || FAIL=1; done
unset KEY
echo "== 4. read-back (metadata only) + verification"; readback; verify || FAIL=1
[ "$FAIL" = 0 ] || { echo "Vercel step incomplete: the server_trust hash was NOT written; fix the error above and re-run this script (it is idempotent)."; exit 1; }

echo "== 5. hosted DB: register the SHA-256 of the STT secret (one row, upsert)"
pg -At -c "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('stt', '$HASH') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256 RETURNING purpose, length(secret_sha256)" || { echo "DB write failed: re-run the script (idempotent); STT stays refused until the hash matches"; exit 1; }
echo "DONE. Nothing is live yet: build and verify a STAGED deployment, then promote (docs/intelligence/OWNER_ACTIVATION.md)."
