-- ROLLBACK of 20261118000900_meeting_creator_erasure (NOT a migration: lives outside supabase/migrations on purpose).
-- Restores the guard exactly as defined by 0500 / 0700 (SECURITY INVOKER, any change of created_by refused). WARNING: that is the DEFECTIVE
-- definition: afterwards deleting a user who created a meeting fails again (HTTP 500). Roll back only to get back to the 0700 catalog.
-- No data is changed; rows whose created_by was already set to NULL by an erasure stay NULL.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000900_meeting_creator_erasure') THEN
        RAISE EXCEPTION 'Rollback refused -- 20261118000900_meeting_creator_erasure is not applied.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_meeting_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN
        RAISE EXCEPTION 'Projekt, autora ani typ zdroje porady nelze měnit.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_meeting_identity() FROM PUBLIC, anon, authenticated;
DELETE FROM public.clearspace_migrations WHERE version = '20261118000900_meeting_creator_erasure';
