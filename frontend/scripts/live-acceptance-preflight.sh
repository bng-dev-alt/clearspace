#!/usr/bin/env bash
# Read-only pre-flight for the LIVE invitation acceptance test (docs/collaboration/LIVE_ACCEPTANCE_TEST.md).
# Sends nothing, creates nothing, changes nothing. Prints PASS/FAIL per item, never a secret. Exit 1 if anything FAILs.
#   frontend/scripts/live-acceptance-preflight.sh
set -uo pipefail
REF=twjlnsxjtuntujarwner; APP=https://clearspace-ai.vercel.app; SCOPE=bng-dev-alt-webadvisor
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
V=${VERCEL_BIN:-$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1)}; [ -x "${V:-}" ] || V=vercel
fail=0; ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; fail=1; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got: $2)"; fi; }
doh() { curl -s -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$1&type=$2" | python3 -c 'import json,sys;print(" ".join(a["data"] for a in json.load(sys.stdin).get("Answer",[])))'; }

echo "== 1. production deployment"
dep=$("$V" api /v13/deployments/clearspace-ai.vercel.app --raw 2>/dev/null | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["readyState"],d["id"][:12],d.get("meta",{}).get("releaseCommit"))' 2>/dev/null)
echo "      serves: $dep"; case "$dep" in READY*) ok "READY";; *) bad "deployment state: $dep";; esac
chk "GET /login = 200" "$(curl -s -o /dev/null -w '%{http_code}' $APP/login)" 200
chk "GET /api/ai/chat = 403 (firewall deny)" "$(curl -s -o /dev/null -w '%{http_code}' $APP/api/ai/chat)" 403
chk "POST /api/collab/invitations anonymous = 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' $APP/api/collab/invitations)" 401

echo "== 2. Vercel Production variables (names/types only)"
r=$("$V" api /v10/projects/clearspace/env --raw 2>/dev/null | python3 -c '
import json,sys
e=json.load(sys.stdin)["envs"]; k={x["key"]:x for x in e}
need={"EMAIL_TRANSPORT":"encrypted","SMTP_HOST":"encrypted","SMTP_PORT":"encrypted","SMTP_SECURITY":"encrypted","SMTP_USER":"encrypted","EMAIL_FROM":"encrypted","APP_BASE_URL":"encrypted","SMTP_PASSWORD":"sensitive","EMAIL_SERVER_SECRET":"sensitive"}
for n,t in need.items():
    x=k.get(n); good=bool(x) and x["type"]==t and "production" in x["target"]
    print(("PASS  " if good else "FAIL  ")+f"{n} ({t}, production)")
bad=[x["key"] for x in e if x["key"]=="EMAIL_ALLOW_RESERVED_DOMAINS" or (x["key"].startswith("NEXT_PUBLIC_") and ("SMTP" in x["key"] or "EMAIL" in x["key"]))]
print(("PASS  " if not bad else "FAIL  ")+"no EMAIL_ALLOW_RESERVED_DOMAINS and no NEXT_PUBLIC_ e-mail variable"+(f" ({bad})" if bad else ""))
print(("PASS  " if not any("BYPASS" in x["key"] for x in e) else "FAIL  ")+"no bypass variable")')
echo "$r"; echo "$r" | grep -q '^FAIL' && fail=1

echo "== 3. DNS (notify.luffast.com)"
case "$(doh resend._domainkey.notify.luffast.com TXT)" in *p=MIG*) ok "DKIM public key published";; *) bad "DKIM TXT missing";; esac
case "$(doh send.notify.luffast.com CNAME)" in *forge.rmta.net*) ok "send.notify (SPF/return path) CNAME to Resend";; *) bad "send.notify CNAME missing";; esac
case "$(doh _dmarc.notify.luffast.com TXT)" in *v=DMARC1*) ok "DMARC published";; *) bad "DMARC missing";; esac

echo "== 4. Supabase Auth + Realtime"
T=$(security find-generic-password -s 'Supabase CLI' -a supabase -w 2>/dev/null); case "$T" in go-keyring-base64:*) T=$(printf '%s' "${T#go-keyring-base64:}" | base64 -d);; esac
r=$(curl -s -H "Authorization: Bearer $T" https://api.supabase.com/v1/projects/$REF/config/auth | python3 -c '
import json,sys
d=json.load(sys.stdin)
def c(n,g): print(("PASS  " if g else "FAIL  ")+n)
c("custom SMTP smtp.resend.com:465 user resend, password set", d["smtp_host"]=="smtp.resend.com" and d["smtp_port"]=="465" and d["smtp_user"]=="resend" and bool(d.get("smtp_pass")))
c("sender ucty@notify.luffast.com / ClearSpace", d["smtp_admin_email"]=="ucty@notify.luffast.com" and d["smtp_sender_name"]=="ClearSpace")
c("confirm e-mail ON, sign-ups enabled", not d["mailer_autoconfirm"] and not d["disable_signup"])
c("e-mail rate limit 30/h", d["rate_limit_email_sent"]==30)
c("Site URL + narrow redirect list", d["site_url"]=="https://clearspace-ai.vercel.app" and d["uri_allow_list"]=="https://clearspace-ai.vercel.app/accept-invite?token=*")
c("Czech confirm-signup subject", d["mailer_subjects_confirmation"].startswith("Potvr"))')
echo "$r"; echo "$r" | grep -q '^FAIL' && fail=1
chk "Realtime private_only = true" "$(curl -s -H "Authorization: Bearer $T" https://api.supabase.com/v1/projects/$REF/config/realtime | python3 -c 'import json,sys;print(json.load(sys.stdin)["private_only"])')" True
unset T

echo "== 5. database (read-only)"
PGPASSWORD=$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null); export PGPASSWORD
out=$({ echo "SET default_transaction_read_only = on;"; cat <<'SQL'
select 'markers=' || (select count(*) from public.clearspace_migrations where version in ('20261124001000_collaboration','20261125001100_collab_hardening'))
 || ' trust_email=' || (select count(*) from public.server_trust where purpose='email')
 || ' rt_policies=' || (select count(*) from pg_policies where schemaname='realtime')
 || ' publication=' || (select count(*) from pg_publication_tables where pubname='supabase_realtime')
 || ' no_key=' || (select count(*) from public.projects where realtime_key is null);
select 'baseline projects=' || (select count(*) from public.projects) || ' cards=' || (select count(*) from public.cards) || ' invitations=' || (select count(*) from public.invitations)
 || ' deliveries=' || (select count(*) from public.invitation_deliveries) || ' auth.users=' || (select count(*) from auth.users) || ' notifications=' || (select count(*) from public.notifications);
SQL
} | docker run --rm -i -e PGPASSWORD $IMG psql "host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" -X -At -q -v ON_ERROR_STOP=1 -f - 2>&1 | grep -v '^SET')
unset PGPASSWORD
echo "      $(echo "$out" | sed -n 2p)"
chk "migrations 1000+1100, e-mail trust row, 2 realtime policies, empty publication, every project has a key" "$(echo "$out" | sed -n 1p)" "markers=2 trust_email=1 rt_policies=2 publication=0 no_key=0"

echo; [ $fail = 0 ] && echo "PREFLIGHT OK - ready for the live acceptance test." || echo "PREFLIGHT FAILED - do not start the live test."; exit $fail
