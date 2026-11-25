#!/usr/bin/env bash
# RUN 02C: move ClearSpace V1 production to its own domain https://clearspace.luffast.com (Vercel project `clearspace`).
# Every write step needs CONFIRM_CUTOVER=clearspace.luffast.com AND the owner's written approval (docs/run02/PRODUCTION_ROLLOUT.md §10).
# Values are never printed except public ones (domain names, URLs). Nothing here deploys; env changes take effect with the next deployment.
#
#   frontend/scripts/domain-cutover.sh plan           read-only: current domains, DNS, Vercel domain config, Supabase Auth URLs, APP_BASE_URL (name only)
#   frontend/scripts/domain-cutover.sh add-domain     1. attach clearspace.luffast.com to the project (production); prints the exact DNS record
#                                                     2. (DNS) CNAME clearspace -> <value printed>, Cloudflare "DNS only" -- done in Cloudflare, not here
#   frontend/scripts/domain-cutover.sh verify         read-only: TLS + HTTP 200 on the new domain, Vercel reports it configured
#   frontend/scripts/domain-cutover.sh switch-env     3. APP_BASE_URL=https://clearspace.luffast.com (Production) + Supabase Auth: allow-list BOTH
#                                                        accept-invite URLs (old links keep working); Site URL stays until `switch-canonical`
#   frontend/scripts/domain-cutover.sh switch-canonical  4. AFTER promote: Supabase Site URL -> new domain; clearspace-ai.vercel.app -> 308 to the new domain
#   frontend/scripts/domain-cutover.sh rollback       undo 4 and 3 (old Site URL, no redirect, APP_BASE_URL back); the domain stays attached (harmless)
set -euo pipefail
NEW=clearspace.luffast.com; OLD=clearspace-ai.vercel.app; PROJECT=clearspace; REF=twjlnsxjtuntujarwner
V=$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1); [ -x "$V" ] || V=vercel
need_confirm() { [ "${CONFIRM_CUTOVER:-}" = "$NEW" ] || { echo "refusing: set CONFIRM_CUTOVER=$NEW (only after the written approval)"; exit 2; }; }
sb_token() { local t; t=$(security find-generic-password -s 'Supabase CLI' -a supabase -w 2>/dev/null); case "$t" in go-keyring-base64:*) t=$(printf '%s' "${t#go-keyring-base64:}" | base64 -d);; esac; printf '%s' "$t"; }
sb_auth_get() { curl -sf -H "Authorization: Bearer $(sb_token)" "https://api.supabase.com/v1/projects/$REF/config/auth"; }
sb_auth_patch() { curl -sf -X PATCH -H "Authorization: Bearer $(sb_token)" -H 'Content-Type: application/json' --data-binary @- "https://api.supabase.com/v1/projects/$REF/config/auth" >/dev/null; }
env_id() { "$V" api "/v10/projects/$PROJECT/env" --raw 2>/dev/null | python3 -c 'import json,sys;print(next((e["id"] for e in json.load(sys.stdin)["envs"] if e["key"]==sys.argv[1] and "production" in (e.get("target") or [])), ""))' "$1"; }
set_app_base_url() {  # $1 = URL (public value); updates the existing Production variable in place
  local id; id=$(env_id APP_BASE_URL); [ -n "$id" ] || { echo "refusing: APP_BASE_URL (Production) not found"; exit 2; }
  python3 -c 'import json,sys;print(json.dumps({"value":sys.argv[1]}))' "$1" | "$V" api "/v9/projects/$PROJECT/env/$id" -X PATCH --input - --silent >/dev/null
  echo "ok - APP_BASE_URL (Production) = $1 (effective with the next deployment)"
}
show_auth() { sb_auth_get | python3 -c 'import json,sys;d=json.load(sys.stdin);print("Supabase Auth: site_url =", d["site_url"], "| uri_allow_list =", d["uri_allow_list"])'; }

case "${1:-}" in
  plan)
    echo "== Vercel project domains"; "$V" api "/v9/projects/$PROJECT/domains" --raw 2>/dev/null | python3 -c '
import json,sys
for x in json.load(sys.stdin).get("domains",[]): print("  ", x["name"], "verified" if x.get("verified") else "UNVERIFIED", "-> redirect "+x["redirect"] if x.get("redirect") else "")'
    echo "== DNS ($NEW, public resolvers)"; for t in CNAME A AAAA; do r=$(dig +short $t $NEW @1.1.1.1 | tr '\n' ' '); [ -n "$r" ] && echo "   $t $r"; done; true
    echo "== Vercel domain config for $NEW"; "$V" api "/v6/domains/$NEW/config?projectIdOrName=$PROJECT" --raw 2>/dev/null | python3 -c '
import json,sys; d=json.load(sys.stdin); c=d.get("recommendedCNAME") or []
print("   recommended CNAME:", c[0]["value"] if c else "?", "| misconfigured:", d.get("misconfigured"), "| conflicts:", d.get("conflicts"))'
    echo "== $(show_auth)"
    echo "== APP_BASE_URL (Production): $([ -n "$(env_id APP_BASE_URL)" ] && echo present || echo MISSING) (value not printed)"
    ;;
  add-domain)
    need_confirm
    python3 -c 'import json,sys;print(json.dumps({"name":sys.argv[1]}))' "$NEW" | "$V" api "/v10/projects/$PROJECT/domains" -X POST --input - --silent >/dev/null || true
    "$V" api "/v9/projects/$PROJECT/domains/$NEW" --raw 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ok - attached:", d.get("name"), "verified:", d.get("verified"))'
    "$V" api "/v6/domains/$NEW/config?projectIdOrName=$PROJECT" --raw 2>/dev/null | python3 -c '
import json,sys; d=json.load(sys.stdin); c=d["recommendedCNAME"][0]["value"].rstrip(".")
print("DNS (Cloudflare zone luffast.com): type CNAME, name clearspace, target", c, ", proxy status DNS only (grey cloud), TTL Auto")'
    ;;
  verify)
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$NEW/login" || echo 000)
    tls=$(curl -s -o /dev/null -w '%{ssl_verify_result}' --max-time 15 "https://$NEW/" || echo 1)
    echo "https://$NEW/login -> HTTP $code, TLS verify result $tls (0 = valid certificate)"
    "$V" api "/v6/domains/$NEW/config?projectIdOrName=$PROJECT" --raw 2>/dev/null | python3 -c 'import json,sys;print("Vercel misconfigured:", json.load(sys.stdin).get("misconfigured"))'
    [ "$code" = 200 ] && [ "$tls" = 0 ] && echo "ok - $NEW serves production with a valid certificate" || { echo "NOT READY"; exit 1; }
    ;;
  switch-env)
    need_confirm
    set_app_base_url "https://$NEW"
    python3 -c 'import json,sys;print(json.dumps({"uri_allow_list": sys.argv[1]}))' "https://$OLD/accept-invite?token=*,https://$NEW/accept-invite?token=*" | sb_auth_patch
    echo "ok - $(show_auth)"
    ;;
  switch-canonical)
    need_confirm
    python3 -c 'import json,sys;print(json.dumps({"site_url": sys.argv[1]}))' "https://$NEW" | sb_auth_patch
    # Vercel refuses to redirect a domain that others redirect TO: first point those (e.g. cearspace.vercel.app) straight at $NEW
    for d in $("$V" api "/v9/projects/$PROJECT/domains" --raw 2>/dev/null | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["domains"] if x.get("redirect")==sys.argv[1]))' "$OLD"); do
      python3 -c 'import json,sys;print(json.dumps({"redirect": sys.argv[1], "redirectStatusCode": 308}))' "$NEW" | "$V" api "/v9/projects/$PROJECT/domains/$d" -X PATCH --input - --silent >/dev/null
      echo "ok - $d -> 308 https://$NEW (was -> $OLD)"
    done
    python3 -c 'import json,sys;print(json.dumps({"redirect": sys.argv[1], "redirectStatusCode": 308}))' "$NEW" | "$V" api "/v9/projects/$PROJECT/domains/$OLD" -X PATCH --input - --silent >/dev/null
    echo "ok - $(show_auth)"; echo "ok - https://$OLD -> 308 https://$NEW (paths and query strings are kept; old invitation links keep working)"
    ;;
  rollback)
    need_confirm
    python3 -c 'import json;print(json.dumps({"redirect": None}))' | "$V" api "/v9/projects/$PROJECT/domains/$OLD" -X PATCH --input - --silent >/dev/null && echo "ok - $OLD serves again (no redirect)"
    for d in $("$V" api "/v9/projects/$PROJECT/domains" --raw 2>/dev/null | python3 -c 'import json,sys;print(" ".join(x["name"] for x in json.load(sys.stdin)["domains"] if x.get("redirect")==sys.argv[1] and x["name"]!=sys.argv[2]))' "$NEW" "$OLD"); do
      python3 -c 'import json,sys;print(json.dumps({"redirect": sys.argv[1], "redirectStatusCode": 307}))' "$OLD" | "$V" api "/v9/projects/$PROJECT/domains/$d" -X PATCH --input - --silent >/dev/null && echo "ok - $d -> $OLD again"
    done
    python3 -c 'import json,sys;print(json.dumps({"site_url": sys.argv[1], "uri_allow_list": sys.argv[2]}))' "https://$OLD" "https://$OLD/accept-invite?token=*" | sb_auth_patch
    echo "ok - $(show_auth)"
    set_app_base_url "https://$OLD"
    echo "Domain $NEW stays attached (harmless). Redeploy or promote the previous deployment for the env change to apply."
    ;;
  *) echo "usage: $0 plan|add-domain|verify|switch-env|switch-canonical|rollback"; exit 2;;
esac
