-- ONE md5 over the whole public/storage catalog (functions, policies, triggers, columns, constraints, indexes, grants, buckets, RLS) plus a line count.
-- Used by tests/rollback.sh (scenarios F, H) and to compare a HOSTED project with a rehearsed state (read-only). Output: last line.
select md5(string_agg(x, E'\n' order by x)) || ' lines=' || count(*) from (
  select 'fn:' || p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind in ('f', 'p')
  union all select 'pol:' || schemaname || '.' || tablename || '.' || policyname || ':' || coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || cmd || '|' || array_to_string(roles, ',') from pg_policies where schemaname in ('public', 'storage')
  union all select 'trg:' || c.relname || '.' || t.tgname || ':' || md5(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'storage')
  union all select 'col:' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public'
  union all select 'con:' || conrelid::regclass || '.' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'idx:' || indexname || ':' || indexdef from pg_indexes where schemaname = 'public'
  union all select 'tgrant:' || table_name || ':' || grantee || ':' || privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
  union all select 'cgrant:' || table_name || '.' || column_name || ':' || grantee || ':' || privilege_type from information_schema.column_privileges where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
  union all select 'fgrant:' || routine_name || ':' || grantee from information_schema.routine_privileges where routine_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')
  union all select 'bucket:' || id || ':' || public || ':' || coalesce(file_size_limit, 0) || ':' || coalesce(array_to_string(allowed_mime_types, ','), '') from storage.buckets
  union all select 'rls:' || relname || ':' || relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r'
) s;
