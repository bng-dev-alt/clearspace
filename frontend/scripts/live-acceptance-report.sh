#!/usr/bin/env bash
# Read-only report for the LIVE invitation acceptance test: what the database recorded for the given invitee address(es).
# No tokens, no password hashes, provider ids shortened. Changes nothing.
#   frontend/scripts/live-acceptance-report.sh a@example.cz [b@example.cz ...]
set -uo pipefail
[ $# -ge 1 ] || { echo "usage: live-acceptance-report.sh <e-mail> [<e-mail> ...]"; exit 2; }
REF=twjlnsxjtuntujarwner; IMG=public.ecr.aws/supabase/postgres:17.6.1.147
PGPASSWORD=$(security find-generic-password -s 'ClearSpace V1 – Supabase Database' -a "postgres.$REF" -w 2>/dev/null); export PGPASSWORD
[ -n "$PGPASSWORD" ] || { echo "database password not found in the Keychain"; exit 2; }
for e in "$@"; do
  [[ "$e" =~ ^[^@[:space:]\'\"\;\\]+@[^@[:space:]\'\"\;\\]+$ ]] || { echo "not a plain e-mail address: $e"; exit 2; }
  echo "================ $e"
  { echo "SET default_transaction_read_only = on;"; echo "\\set e '$(printf '%s' "$e" | tr 'A-Z' 'a-z')'"; cat <<'SQL'
\pset border 1
\echo -- account
select to_char(created_at at time zone 'Europe/Prague','YYYY-MM-DD HH24:MI') as created, (email_confirmed_at is not null) as confirmed, to_char(last_sign_in_at at time zone 'Europe/Prague','YYYY-MM-DD HH24:MI') as last_sign_in
  from auth.users where lower(email) = :'e';
\echo -- invitations (token is never shown)
select i.id, coalesce(p.name, '(workspace)') as project, i.project_role as role, i.status, to_char(i.created_at at time zone 'Europe/Prague','HH24:MI:SS') as created, to_char(i.expires_at at time zone 'Europe/Prague','MM-DD HH24:MI') as expires, to_char(i.accepted_at at time zone 'Europe/Prague','HH24:MI:SS') as accepted
  from public.invitations i left join public.projects p on p.id = i.project_id where lower(i.email) = :'e' order by i.created_at;
\echo -- delivery attempts
select d.attempt_no as n, d.kind, d.status, d.transport, d.error_code, left(coalesce(d.provider_message_id,''), 14) as provider_id, to_char(d.created_at at time zone 'Europe/Prague','HH24:MI:SS') as at
  from public.invitation_deliveries d where lower(d.recipient) = :'e' order by d.created_at, d.attempt_no;
\echo -- project access of this account
select p.name as project, pm.project_role as role from auth.users u join public.workspace_members wm on wm.profile_id = u.id
  join public.project_members pm on pm.member_id = wm.id join public.projects p on p.id = pm.project_id where lower(u.email) = :'e' order by 1;
SQL
  } | docker run --rm -i -e PGPASSWORD $IMG psql "host=aws-0-eu-west-1.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require" -X -q -v ON_ERROR_STOP=1 -f - 2>&1 | grep -v '^SET$'
done
unset PGPASSWORD
