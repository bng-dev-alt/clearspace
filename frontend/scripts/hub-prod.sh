#!/usr/bin/env bash
# RUN 09: PRODUCTION operations of the Communication Hub (RUN 07/08) and the RUN 05 personal notifications. Production only -- the local
# live session (hub-live.sh app) refuses these Keychain services. Never prints a secret value: names, shapes, counts and yes/no only.
#
#   hub-prod.sh gen-server         generate the missing SERVER secrets (never provider credentials) into the production Keychain services
#   hub-prod.sh owner              OWNER, in a Terminal: paste the rotated provider credentials (hidden input) -> production Keychain
#   hub-prod.sh verify             every production item present + well-formed; Telegram getMe per bot; the DEV bot tokens are dead
#   hub-prod.sh register           production DB: hub service user (SQL, no e-mail sent) + hub_service_principal + server_trust hub/notify
#   hub-prod.sh push-env stage1|stage2   Keychain -> Vercel Production (Sensitive, stdin); stage2 adds the Cortex bot + PI switch
#   hub-prod.sh telegram-webhook relay|cortex [off]
#   hub-prod.sh scheduler hub|notify on|off
#   hub-prod.sh status             Keychain item names, Vercel variable names, DB hub state, webhooks, cron jobs (read-only)
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HS="ClearSpace V1 - Hub (production)"; NS="ClearSpace V1 - Notify (production)"
DEV_HS="ClearSpace V1 - Hub dev (live)"; DEV_NS="ClearSpace V1 - Notify dev (live)"
REF=twjlnsxjtuntujarwner; BASE=https://clearspace.luffast.com; SCOPE=bng-dev-alt-webadvisor; PROJECT=clearspace
IMG=public.ecr.aws/supabase/postgres:17.6.1.147
V=$(ls -d ~/.npm/_npx/*/node_modules/.bin/vercel 2>/dev/null | tail -1); [ -x "$V" ] || V=vercel
kc() { security find-generic-password -s "$1" -a "$2" -w 2>/dev/null; }
kc_has() { security find-generic-password -s "$1" -a "$2" >/dev/null 2>&1; }
kc_put() { printf 'add-generic-password -U -s "%s" -a "%s" -w "%s"\n' "$1" "$2" "$3" | security -i >/dev/null 2>&1; }
# robust hidden-input prompt of the RUN 08 setup (re-asks on a rejected / empty value, stdin to the Keychain, read back)
HUB_INPUT=${HUB_INPUT:-/dev/tty}; HUB_TUNNEL_ID=none
validate() { printf '%s' "$2" | TID="$HUB_TUNNEL_ID" python3 -I "$HERE/scripts/hub-credential-check.py" validate "$1"; }
eval "$(sed -n '/^prompt_store() {/,/^}/p' "$HERE/scripts/hub-live.sh")"
DB="host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
pg() { PGPASSWORD="$(kc 'ClearSpace V1 – Supabase Database' "postgres.$REF")" docker run --rm -i -e PGPASSWORD "$IMG" psql "$DB" -X -At -q -v ON_ERROR_STOP=1 "$@"; }
tg() { local tok=$1 m=$2; shift 2; printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$tok" "$m" | curl -sS -m 20 -K - "$@"; }
rnd() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }
fail=0; ok() { echo "ok   - $1"; }; bad() { echo "FAIL - $1"; fail=1; }

HUB_SERVER="hub_server_secret hub_routing_key hub_token_encryption_key hub_service_email hub_service_password telegram_hub_webhook_secret telegram_pi_webhook_secret pilot_user_ids"
NOTIFY_SERVER="notify_server_secret notify_token_encryption_key"
HUB_PROVIDER="slack_hub_client_id slack_hub_client_secret slack_hub_signing_secret telegram_hub_bot_token telegram_hub_bot_username telegram_pi_bot_token telegram_pi_bot_username"
NOTIFY_PROVIDER="slack_client_id slack_client_secret telegram_bot_token telegram_bot_username"

VDIR=""; vlink() { [ -n "$VDIR" ] && return; VDIR=$(mktemp -d); trap 'rm -rf "$VDIR"' EXIT; (cd "$VDIR" && "$V" link --yes --project "$PROJECT" --scope "$SCOPE" >/dev/null 2>&1) || { echo "vercel link failed"; exit 1; }; }
venv() { vlink; (cd "$VDIR" && "$V" env add "$@" production --force --scope "$SCOPE" >/dev/null 2>&1); }
push() {  # NAME VALUE -> Vercel Production, Sensitive (value only through stdin)
  printf '%s' "$2" | venv "$1" --sensitive && ok "Vercel Production: $1" || bad "Vercel: $1 not stored"
}
plain() { printf '%s' "$2" | venv "$1" --no-sensitive && ok "Vercel Production: $1=$2" || bad "Vercel: $1 not stored"; }

case "${1:-}" in
  gen-server)
    g() { kc_has "$1" "$2" && { echo "keep - $2 (exists)"; return; }; kc_put "$1" "$2" "$3" && kc_has "$1" "$2" && ok "generated $2" || bad "$2 not stored"; }
    g "$HS" hub_server_secret "$(rnd 48)"; g "$HS" hub_routing_key "$(rnd 48)"; g "$HS" hub_token_encryption_key "$(openssl rand -base64 32 | tr -d '\n')"
    g "$HS" hub_service_email "hub-service@clearspace.invalid"; g "$HS" hub_service_password "$(rnd 36)"
    g "$HS" telegram_hub_webhook_secret "$(rnd 48)"; g "$HS" telegram_pi_webhook_secret "$(rnd 48)"
    g "$NS" notify_server_secret "$(rnd 48)"; g "$NS" notify_token_encryption_key "$(openssl rand -base64 32 | tr -d '\n')"
    [ -n "${PILOT_USER_IDS:-}" ] && { kc_put "$HS" pilot_user_ids "$PILOT_USER_IDS"; ok "pilot_user_ids stored"; };;
  owner)
    echo "== ClearSpace PRODUCTION credentials -- each value goes straight into the macOS Keychain (hidden input, nothing is shown)"
    echo "-- 1/5 Slack app 'ClearSpace Projekty' (api.slack.com/apps -> Basic Information -> App Credentials, AFTER both Regenerate)"
    prompt_store "$HS" slack_hub_client_id 'Projekty: Client ID' slack_id 0 0 || exit 1
    prompt_store "$HS" slack_hub_client_secret 'Projekty: Client Secret (new)' slack_secret 1 0 || exit 1
    prompt_store "$HS" slack_hub_signing_secret 'Projekty: Signing Secret (new)' slack_secret 1 0 || exit 1
    echo "-- 2/5 Slack app for PERSONAL notifications (after Regenerate of the Client Secret)"
    prompt_store "$NS" slack_client_id 'Oznámení: Client ID' slack_id 0 0 || exit 1
    prompt_store "$NS" slack_client_secret 'Oznámení: Client Secret (new)' slack_secret 1 0 || exit 1
    echo "-- 3/5 Telegram RELAY (project bot) -- new token after /revoke"
    prompt_store "$HS" telegram_hub_bot_token 'Relay: new token' tg_token 1 0 || exit 1
    prompt_store "$HS" telegram_hub_bot_username 'Relay: username' tg_user 0 0 || exit 1
    echo "-- 4/5 Telegram HQ (personal notification bot) -- new token after /revoke"
    prompt_store "$NS" telegram_bot_token 'HQ: new token' tg_token 1 0 || exit 1
    prompt_store "$NS" telegram_bot_username 'HQ: username' tg_user 0 0 || exit 1
    echo "-- 5/5 Telegram CORTEX (PI bot, used only in stage 2) -- new token after /revoke"
    prompt_store "$HS" telegram_pi_bot_token 'Cortex: new token' tg_token 1 0 || exit 1
    prompt_store "$HS" telegram_pi_bot_username 'Cortex: username' tg_user 0 0 || exit 1
    echo "== done -- write 'blok hotový' in the chat"; exec "$0" verify;;
  verify)
    for i in $HUB_SERVER $HUB_PROVIDER; do kc_has "$HS" "$i" && ok "Keychain hub/$i" || bad "Keychain hub/$i MISSING"; done
    for i in $NOTIFY_SERVER $NOTIFY_PROVIDER; do kc_has "$NS" "$i" && ok "Keychain notify/$i" || bad "Keychain notify/$i MISSING"; done
    [ "$(kc "$HS" slack_hub_client_id)" != "$(kc "$NS" slack_client_id)" ] && ok "project and personal Slack apps differ" || bad "same Slack app for project and personal"
    for p in "$HS:slack_hub_client_secret:$DEV_HS:slack_hub_client_secret" "$HS:slack_hub_signing_secret:$DEV_HS:slack_hub_signing_secret" "$NS:slack_client_secret:$DEV_NS:slack_client_secret"; do
      IFS=: read -r a b c d <<<"$p"; [ "$(kc "$a" "$b")" != "$(kc "$c" "$d")" ] && ok "$b rotated (differs from the dev value)" || bad "$b NOT rotated (equals the dev value)"; done
    for p in "Relay:$HS:telegram_hub_bot:$DEV_HS:telegram_hub_bot" "HQ:$NS:telegram_bot:$DEV_NS:telegram_bot" "Cortex:$HS:telegram_pi_bot:$DEV_HS:telegram_pi_bot"; do
      IFS=: read -r n a b c d <<<"$p"
      r=$(tg "$(kc "$a" ${b}_token)" getMe | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("ok"),(d.get("result") or {}).get("username",""),(d.get("result") or {}).get("can_read_all_group_messages"))' 2>/dev/null)
      [ "${r%% *}" = True ] && [ "$(echo "$r" | cut -d' ' -f2)" = "$(kc "$a" ${b}_username)" ] && ok "$n: new token valid, username matches (read all group messages: ${r##* })" || bad "$n: new token not accepted by Telegram"
      if kc_has "$c" ${d}_token; then
        o=$(tg "$(kc "$c" ${d}_token)" getMe | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ok"))' 2>/dev/null)
        [ "$o" = False ] && ok "$n: old DEV token is dead (revoked)" || bad "$n: old DEV token STILL VALID -- /revoke in BotFather"
      fi
    done
    [ $fail = 0 ] && echo "VERIFY PASS" || { echo "VERIFY FAILED"; exit 1; };;
  register)
    EMAIL=$(kc "$HS" hub_service_email); PW=$(kc "$HS" hub_service_password); [ -n "$EMAIL" ] && [ -n "$PW" ] || { echo "run gen-server first"; exit 2; }
    # plain Auth user, created in SQL (no confirmation e-mail, no admin key on this machine); bcrypt via pgcrypto like GoTrue
    uid=$(printf '%s\n' "\\set em '$EMAIL'" "\\set pw '$PW'" "$(cat <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = :'em') THEN
    WITH u AS (
      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', :'em', extensions.crypt(:'pw', extensions.gen_salt('bf', 10)), now(),
              '{"provider":"email","providers":["email"]}', '{"full_name":"ClearSpace Hub (service)"}', now(), now(), '', '', '', '')
      RETURNING id)
    INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    SELECT gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', :'em', 'email_verified', true), 'email', now(), now(), now() FROM u;
  END IF;
END $$;
SQL
)" "select id from auth.users where email = :'em';" | sed "s/:'em'/'$EMAIL'/g; s/:'pw'/'$PW'/g" | grep -v '^\\set' | pg -f - | tail -1)
    unset PW
    [[ "$uid" =~ ^[0-9a-f-]{36}$ ]] && ok "service user present" || { bad "service user not created"; exit 1; }
    printf '%s\n' "\\set uid '$uid'" "\\set secret_sha256 '$(printf '%s' "$(kc "$HS" hub_server_secret)" | shasum -a 256 | cut -d' ' -f1)'" "$(cat "$HERE/supabase/ops/hub_service_principal.sql")" | pg -f - | tail -1
    printf "INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('notify', '%s') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();\n" \
      "$(printf '%s' "$(kc "$NS" notify_server_secret)" | shasum -a 256 | cut -d' ' -f1)" | pg -f - >/dev/null && ok "server_trust('notify') registered"
    echo "select 'principal='||(select count(*) from public.hub_service_principal)||' trust='||(select string_agg(purpose,',' order by purpose) from public.server_trust)||' owns_projects='||(select count(*) from public.projects where user_id='$uid');" | pg -f -;;
  push-env)
    stage=${2:?stage1|stage2}; vlink
    for a in "HUB_SERVER_SECRET:hub_server_secret" "HUB_ROUTING_KEY:hub_routing_key" "HUB_TOKEN_ENCRYPTION_KEY:hub_token_encryption_key" "HUB_SERVICE_EMAIL:hub_service_email" \
             "HUB_SERVICE_PASSWORD:hub_service_password" "SLACK_HUB_CLIENT_ID:slack_hub_client_id" "SLACK_HUB_CLIENT_SECRET:slack_hub_client_secret" \
             "SLACK_HUB_SIGNING_SECRET:slack_hub_signing_secret" "TELEGRAM_HUB_BOT_TOKEN:telegram_hub_bot_token" "TELEGRAM_HUB_BOT_USERNAME:telegram_hub_bot_username" \
             "TELEGRAM_HUB_WEBHOOK_SECRET:telegram_hub_webhook_secret" "HUB_PILOT_USER_IDS:pilot_user_ids"; do
      v=$(kc "$HS" "${a#*:}"); [ -n "$v" ] || { bad "${a#*:} missing in the Keychain"; continue; }; push "${a%%:*}" "$v"; done
    for a in "NOTIFY_SERVER_SECRET:notify_server_secret" "NOTIFY_TOKEN_ENCRYPTION_KEY:notify_token_encryption_key" "SLACK_CLIENT_ID:slack_client_id" \
             "SLACK_CLIENT_SECRET:slack_client_secret" "TELEGRAM_BOT_TOKEN:telegram_bot_token" "TELEGRAM_BOT_USERNAME:telegram_bot_username"; do
      v=$(kc "$NS" "${a#*:}"); [ -n "$v" ] || { bad "${a#*:} missing in the Keychain"; continue; }; push "${a%%:*}" "$v"; done
    push NOTIFY_PILOT_USER_IDS "$(kc "$HS" pilot_user_ids)"
    for s in HUB_SLACK_ENABLED HUB_TELEGRAM_ENABLED SLACK_INTEGRATION_ENABLED TELEGRAM_INTEGRATION_ENABLED; do plain $s 1; done
    if [ "$stage" = stage2 ]; then
      push TELEGRAM_HUB_PI_BOT_TOKEN "$(kc "$HS" telegram_pi_bot_token)"; push TELEGRAM_HUB_PI_BOT_USERNAME "$(kc "$HS" telegram_pi_bot_username)"
      push TELEGRAM_HUB_PI_WEBHOOK_SECRET "$(kc "$HS" telegram_pi_webhook_secret)"; plain HUB_INTELLIGENCE_ENABLED 1
    fi
    echo "(variables apply to the NEXT deployment only)"; [ $fail = 0 ] || exit 1;;
  telegram-webhook)
    case "${2:-}" in relay) t=$(kc "$HS" telegram_hub_bot_token) s=$(kc "$HS" telegram_hub_webhook_secret) p=/api/hub/telegram/webhook au='["message","edited_message","my_chat_member"]';;
                     cortex) t=$(kc "$HS" telegram_pi_bot_token) s=$(kc "$HS" telegram_pi_webhook_secret) p=/api/hub/telegram/pi-webhook au='["message","edited_message"]';;
                     *) echo "usage: telegram-webhook relay|cortex [off]"; exit 2;; esac
    if [ "${3:-}" = off ]; then tg "$t" deleteWebhook --data-urlencode drop_pending_updates=true | python3 -c 'import json,sys;print("deleteWebhook ok =",json.load(sys.stdin).get("ok"))'
    # token AND webhook secret only through curl's stdin config (never argv); RUN 09 fix: a second '@-' data source got nothing -> no secret_token
    else printf 'url = "https://api.telegram.org/bot%s/setWebhook"\ndata-urlencode = "secret_token=%s"\n' "$t" "$s" | curl -sS -m 20 -K - --data-urlencode "url=$BASE$p" --data-urlencode "allowed_updates=$au" --data-urlencode drop_pending_updates=true \
           | python3 -c 'import json,sys;print("setWebhook ok =",json.load(sys.stdin).get("ok"))'; fi
    tg "$t" getWebhookInfo | python3 -c 'import json,sys;r=json.load(sys.stdin)["result"];print("webhook url:",r.get("url") or "(none)","| pending:",r.get("pending_update_count"),"| last error:",r.get("last_error_message") or "-","| updates:",r.get("allowed_updates"))';;
  scheduler)
    w=${2:?hub|notify}; case "${3:-}" in
      on)  if [ "$w" = hub ]; then printf '%s\n' "\\set url '$BASE/api/hub/dispatch'" "\\set secret '$(kc "$HS" hub_server_secret)'" "$(cat "$HERE/supabase/ops/hub_scheduler_enable.sql")" | pg -f -
           else printf '%s\n' "\\set url '$BASE/api/notify/dispatch'" "\\set secret '$(kc "$NS" notify_server_secret)'" "$(cat "$HERE/supabase/ops/notify_scheduler_enable.sql")" | pg -f -; fi;;
      off) pg -f - < "$HERE/supabase/ops/${w}_scheduler_disable.sql";;
      *) echo "usage: scheduler hub|notify on|off"; exit 2;; esac;;
  status)
    echo "== Keychain (names only)"; for i in $HUB_SERVER $HUB_PROVIDER; do kc_has "$HS" "$i" && echo "  hub/$i" || echo "  hub/$i  (missing)"; done
    for i in $NOTIFY_SERVER $NOTIFY_PROVIDER; do kc_has "$NS" "$i" && echo "  notify/$i" || echo "  notify/$i  (missing)"; done
    echo "== Vercel Production (names)"; "$V" api "/v10/projects/$PROJECT/env" --raw --scope "$SCOPE" 2>/dev/null | python3 -c '
import json,sys
print("  "+" ".join(sorted(e["key"] for e in json.load(sys.stdin)["envs"] if "production" in (e.get("target") or []) and e["key"].startswith(("HUB_","SLACK_","TELEGRAM_","NOTIFY_")))))'
    echo "== production DB"; echo "set session characteristics as transaction read only; select 'markers_hub='||(select count(*) from public.clearspace_migrations where version like '202611300016%' or version like '202612010017%')||' principal='||(select count(*) from public.hub_service_principal)||' trust='||(select string_agg(purpose,',' order by purpose) from public.server_trust)||' installs='||(select count(*) from public.hub_slack_installations where status='active')||' destinations='||(select count(*) from public.hub_destinations where status='active')||' identities='||(select count(*) from public.hub_identities)||' notify_channels='||(select count(*) from public.notification_channels where status='active')||' outbox_pending='||(select count(*) from public.hub_outbox where status='pending')||' cron='||coalesce((select string_agg(jobname,',') from cron.job where jobname like 'clearspace-%'),'none');" | pg -f - 2>/dev/null | grep -v '^SET' || echo "  (cron schema absent: scheduler never enabled)"
    echo "== Telegram webhooks"; for b in "Relay:$HS:telegram_hub_bot_token" "HQ:$NS:telegram_bot_token" "Cortex:$HS:telegram_pi_bot_token"; do IFS=: read -r n a i <<<"$b"
      kc_has "$a" "$i" && echo "  $n: $(tg "$(kc "$a" "$i")" getWebhookInfo | python3 -c 'import json,sys;r=json.load(sys.stdin).get("result") or {};print(r.get("url") or "(no webhook)","pending",r.get("pending_update_count"))')"; done;;
  *) sed -n '2,13p' "$0"; exit 2;;
esac
