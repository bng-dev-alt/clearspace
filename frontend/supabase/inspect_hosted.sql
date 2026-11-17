-- READ-ONLY inspection pack for the hosted ClearSpace V1 database.
--
-- Returns metadata and aggregate counts ONLY: no row contents, no e-mail addresses, no tokens.
-- Run it before anything else on the target (and again after the migrations) and attach the output to
-- the release record. It is designed to be pasted into the SQL editor or run with psql in a read-only session:
--
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$DB_URL" -X -f frontend/supabase/inspect_hosted.sql
--
-- Do NOT use ON_ERROR_STOP: a missing object (for example a table that never existed) is itself a finding
-- and the remaining sections should still run.

\echo '== 1. server / role'
select version();
select current_user as running_as,
       (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
       (select string_agg(rolname, ', ' order by rolname) from pg_roles
         where pg_has_role(current_user, oid, 'MEMBER') and rolname <> current_user) as member_of;

\echo '== 2. extensions (pgcrypto must be in schema "extensions")'
select extname, extnamespace::regnamespace as schema, extversion from pg_extension order by 1;

\echo '== 3. public tables: owner, RLS, EXACT row counts (counts only)'
select c.relname as table_name,
       c.relowner::regrole as owner,
       c.relrowsecurity as rls_enabled,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as exact_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by 1;

\echo '== 4. columns of public tables (names/types only)'
select table_name, column_name, data_type, is_nullable
from information_schema.columns where table_schema = 'public'
order by table_name, ordinal_position;

\echo '== 5. constraints of public tables'
select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint where connamespace = 'public'::regnamespace
order by 1, 2;

\echo '== 6. RLS policies (public + storage)'
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

\echo '== 7. functions in public: SECURITY DEFINER?, owner, pinned search_path, ACL'
select p.oid::regprocedure as function, p.prosecdef as security_definer, p.proowner::regrole as owner,
       p.proconfig as config, p.proacl as acl
from pg_proc p where p.pronamespace = 'public'::regnamespace
order by 1;

\echo '== 8. table privileges held by anon / authenticated in public (aggregate)'
select grantee, privilege_type, count(*) as tables
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')
group by 1, 2 order by 1, 2;

\echo '== 9. default privileges'
select defaclrole::regrole as for_role, defaclnamespace::regnamespace as in_schema, defaclobjtype, defaclacl
from pg_default_acl order by 1, 2, 3;

\echo '== 10. triggers on public tables and auth.users'
select tgrelid::regclass as table_name, tgname, pg_get_triggerdef(oid) as definition
from pg_trigger where not tgisinternal and (tgrelid::regclass::text like 'public.%' or tgrelid = 'auth.users'::regclass)
order by 1, 2;

\echo '== 11. invitations: statuses and PLAINTEXT tokens still stored (counts only)'
select status, count(*) as n, count(token) as plaintext_tokens from public.invitations group by 1 order by 1;

\echo '== 12. auth: user / confirmation / provider counts (no identities)'
select count(*) as users, count(email_confirmed_at) as with_confirmed_email from auth.users;
select provider, count(*) as identities from auth.identities group by 1 order by 1;

\echo '== 13. storage: buckets (settings) and object counts per bucket'
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by 1;
select bucket_id, count(*) as objects from storage.objects group by 1 order by 1;

\echo '== 14. realtime publication membership'
select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1, 2;

\echo '== 15. applied migrations (names only)'
select to_regclass('public.clearspace_migrations') as clearspace_migrations_table;
select version from public.clearspace_migrations order by 1;
select version from supabase_migrations.schema_migrations order by 1;

\echo '== 16. database size and settings that matter'
select pg_size_pretty(pg_database_size(current_database())) as database_size;
select name, setting from pg_settings where name in ('server_version', 'max_connections', 'statement_timeout', 'default_transaction_read_only');
