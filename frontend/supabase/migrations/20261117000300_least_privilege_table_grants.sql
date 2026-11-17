-- ============================================================
-- 20261117000300 -- Least-privilege table grants
--
-- Found on a real hosted Supabase project (not by the local test shims): Supabase's default privileges
-- give `authenticated` every table privilege on new tables in `public`, including TRUNCATE, TRIGGER and
-- REFERENCES. Row-level security does NOT apply to TRUNCATE, so RLS alone leaves a "wipe this table"
-- privilege in place (the Data API cannot issue TRUNCATE, but a direct SQL connection as that role could).
-- The app only ever needs SELECT / INSERT / UPDATE / DELETE, always under RLS.
--
--  * Revokes TRUNCATE, TRIGGER, REFERENCES from `authenticated` on all existing public tables.
--  * Changes the default privileges of the migrating role so future tables do not get them, and
--    do not get any anon grants either.
-- Idempotent. Apply after 20261117000200.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261117000100_security_foundation') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261117000100_security_foundation first';
    END IF;
END $$;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Applies to objects created later by the role running this migration (postgres on hosted Supabase).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261117000300_least_privilege_table_grants')
ON CONFLICT (version) DO NOTHING;
