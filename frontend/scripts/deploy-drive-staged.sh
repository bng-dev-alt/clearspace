#!/usr/bin/env bash
# RUN 02C: staged PRODUCTION build of the Google Drive release (no domain assigned, nothing promoted) + its gates.
# Deploys only with CONFIRM_DRIVE_DEPLOY=<full commit sha> AND the owner's written approval (docs/run02/PRODUCTION_ROLLOUT.md §10).
#
#   frontend/scripts/deploy-drive-staged.sh preflight            read-only: commit/branch/tree, Vercel env NAMES, production DB state
#   CONFIRM_DRIVE_DEPLOY=<sha> frontend/scripts/deploy-drive-staged.sh deploy    clean `git archive` export -> vercel deploy --prod --skip-domain
#   frontend/scripts/deploy-drive-staged.sh check <staged-url>   build.env vs current production + check-deployment.sh (EXPECT_DRIVE=1)
#   promote (separate approval):  vercel promote <staged-url> --scope bng-dev-alt-webadvisor --yes
# Never prints values: only variable NAMES, URLs and counts.
set -uo pipefail
FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; ROOT="$(cd "$FRONTEND/.." && pwd)"
SCOPE=bng-dev-alt-webadvisor; PROJECT=clearspace; REF=twjlnsxjtuntujarwner; BRANCH=release/run02-google-drive
V=$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1); [ -x "$V" ] || V=vercel
REQUIRED="GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_SERVER_SECRET GOOGLE_TOKEN_ENCRYPTION_KEY GOOGLE_PICKER_API_KEY GOOGLE_CLOUD_PROJECT_NUMBER APP_BASE_URL PRIVACY_CONTROLLER PRIVACY_CONTACT_EMAIL"
FORBIDDEN="GOOGLE_API_MOCK_BASE GOOGLE_MOCK_PORT MOCK_REDIRECT_URIS CLEARSPACE_DEV_LOGIN CLEARSPACE_DEV_AUTO_LOGIN NEXT_PUBLIC_DEV_LOGIN NEXT_PUBLIC_DEV_AUTO_LOGIN DEV_LOGIN_EMAIL DEV_LOGIN_PASSWORD GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS"
fail=0; ok() { echo "ok   - $1"; }; bad() { echo "FAIL - $1"; fail=1; }

preflight() {
  echo "== Git"
  [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] && ok "branch $BRANCH" || bad "not on $BRANCH"
  [ -z "$(git -C "$ROOT" status --short)" ] && ok "working tree clean" || bad "working tree not clean"
  echo "   commit $(git -C "$ROOT" rev-parse HEAD)"
  echo "== Vercel env (Production) -- names only"
  local names; names=$("$V" api "/v10/projects/$PROJECT/env" --raw 2>/dev/null | python3 -c '
import json,sys
for e in json.load(sys.stdin)["envs"]:
  for t in (e.get("target") or []): print(t+":"+e["key"])')
  for n in $REQUIRED; do echo "$names" | grep -qx "production:$n" && ok "$n present" || bad "$n MISSING in Production"; done
  for n in $FORBIDDEN; do echo "$names" | grep -qE "^(production|preview):$n$" && bad "$n must NOT exist (production/preview)" || ok "no $n"; done
  echo "$names" | grep -qx "production:GOOGLE_OAUTH_PUBLISHING" && echo "   GOOGLE_OAUTH_PUBLISHING present (set it to 'production' only once the consent screen is published)" \
    || echo "   GOOGLE_OAUTH_PUBLISHING absent -> UI shows the limited-pilot (Testing) notice"
  echo "== production database (read-only)"
  local DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" st
  PGPASSWORD="$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null)"; export PGPASSWORD
  st=$(printf "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;\nselect (select count(*) from public.clearspace_migrations where version='20261126001200_google_drive')||','||(select count(*) from public.server_trust where purpose='google');\n" \
    | docker run --rm -i -e PGPASSWORD public.ecr.aws/supabase/postgres:17.6.1.147 psql "$DB" -X -At -q 2>/dev/null | grep -v '^SET'); unset PGPASSWORD
  [ "$st" = "1,1" ] && ok "migration 1200 applied, server_trust('google') registered" || bad "production DB not ready for the Drive build (marker,trust = ${st:-?}) -- run apply-drive-hosted.sh first"
}

case "${1:-}" in
  preflight) preflight;;
  deploy)
    SHA=$(git -C "$ROOT" rev-parse HEAD)
    [ "${CONFIRM_DRIVE_DEPLOY:-}" = "$SHA" ] || { echo "refusing: set CONFIRM_DRIVE_DEPLOY=$SHA (only after the written approval)"; exit 2; }
    preflight; [ $fail = 0 ] || { echo "preflight FAILED -- nothing deployed"; exit 1; }
    D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
    git -C "$ROOT" archive "$SHA" | tar -x -C "$D"
    ( cd "$D" && "$V" link --yes --project "$PROJECT" --scope "$SCOPE" >/dev/null 2>&1 && rm -f .env.local frontend/.env.local \
      && "$V" deploy --prod --skip-domain --yes --scope "$SCOPE" --build-env NEXT_PUBLIC_ENABLE_MONOGRAPH=1 --meta "releaseCommit=$SHA" ) | tail -3
    echo "STAGED (not promoted). Next: $0 check <staged-url>"
    ;;
  check)
    URL=${2:?usage: $0 check <staged-url>}
    echo "== build.env: staged vs current production (names)"
    prod=$("$V" api "/v9/projects/$PROJECT" --raw 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["targets"]["production"]["id"])')
    keys() { "$V" api "/v13/deployments/$1" --raw 2>/dev/null | python3 -c 'import json,sys;print("\n".join(sorted(k for k in (json.load(sys.stdin).get("build") or {}).get("env") or [] if not k.startswith(("VERCEL","TURBO","NX_")))))'; }
    host=${URL#https://}; diff <(keys "$prod") <(keys "$host") | grep -E '^[<>]' | sed 's/^</   only in current production:/; s/^>/   only in staged:/'
    keys "$host" | grep -qx NEXT_PUBLIC_ENABLE_MONOGRAPH && ok "NEXT_PUBLIC_ENABLE_MONOGRAPH baked into the staged build" || bad "NEXT_PUBLIC_ENABLE_MONOGRAPH missing (Monograph would vanish)"
    echo "== black-box checks"
    MODE=vercel DEPLOYMENT="$URL" EXPECT_DRIVE=1 bash "$FRONTEND/scripts/check-deployment.sh" "$URL" || fail=1
    echo "NOTE: Google OAuth cannot be exercised on the staged URL (not an authorized redirect URI): it is accepted after promote (PRODUCTION_ACCEPTANCE.md)."
    ;;
  *) echo "usage: $0 preflight | deploy | check <staged-url>"; exit 2;;
esac
[ $fail = 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
