-- Every SECURITY DEFINER function in public: pinned search_path, no anon/PUBLIC EXECUTE
-- (except the one deliberately anonymous RPC).
DO $$
DECLARE f record; bad text := '';
BEGIN
  FOR f IN
    SELECT p.oid, p.proname, p.proconfig, p.prosecdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    IF f.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(f.proconfig) c WHERE c LIKE 'search_path=%') THEN
      bad := bad || ' no_search_path:' || f.proname;
    END IF;
    IF f.proname <> 'invitation_preview' AND has_function_privilege('anon', f.oid, 'EXECUTE') THEN
      bad := bad || ' anon_exec:' || f.proname;
    END IF;
    IF has_function_privilege('public', f.oid, 'EXECUTE') AND f.proname <> 'invitation_preview' THEN
      bad := bad || ' public_exec:' || f.proname;
    END IF;
  END LOOP;
  PERFORM test.ok(bad = '', 'all SECURITY DEFINER functions hardened' || bad);
  PERFORM test.ok(has_function_privilege('anon', 'public.invitation_preview(text)', 'EXECUTE'), 'invitation_preview is the only anonymous RPC');
  PERFORM test.ok(NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'), 'trigger function is not an RPC');
  PERFORM test.ok(NOT has_function_privilege('authenticated', 'public.guard_workspace_member_identity()', 'EXECUTE'), 'guard trigger function is not an RPC');
  PERFORM test.ok(has_function_privilege('authenticated', 'public.is_project_member(text)', 'EXECUTE'), 'RLS helpers stay executable for authenticated');
  PERFORM test.ok((select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon') = 0, 'anon holds no table privileges in public');
  PERFORM test.ok(coalesce((select string_agg(c.relname, ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity), '') = '',
    'RLS enabled on every public table (offenders: ' || coalesce((select string_agg(c.relname, ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity), 'none') || ')');
END $$;
