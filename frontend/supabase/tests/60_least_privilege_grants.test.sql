-- authenticated may only SELECT/INSERT/UPDATE/DELETE (always under RLS); anon holds nothing.
-- TRUNCATE bypasses RLS, so it must not be granted.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(grantee || ':' || privilege_type || ':' || table_name, ' ') INTO bad
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
    AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES');
  PERFORM test.ok(coalesce(bad, '') = '', 'no TRUNCATE/TRIGGER/REFERENCES for anon/authenticated (offenders: ' || coalesce(bad, 'none') || ')');
  PERFORM test.ok((SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee = 'anon') = 0, 'anon still holds no table privilege');
  PERFORM test.ok(has_table_privilege('authenticated', 'public.projects', 'SELECT'), 'authenticated keeps SELECT on projects');
  PERFORM test.ok(has_table_privilege('authenticated', 'public.cards', 'UPDATE'), 'authenticated keeps UPDATE on cards');
END $$;
