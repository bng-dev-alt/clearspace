-- ============================================================
-- 20261118000900 -- Account erasure: let the foreign-key action ON DELETE SET NULL change meetings.created_by
--
-- FORWARD-ONLY corrective migration for a defect found by the B3a staged smoke test on the hosted project:
-- meetings.created_by REFERENCES profiles(id) ON DELETE SET NULL, but guard_meeting_identity() (0500, re-asserted by 0800) raised 42501
-- on ANY change of created_by. Deleting a user who ever created a meeting therefore failed (GoTrue: HTTP 500 "Database error deleting user").
--
-- Fix (smallest safe change, the guard stays):
--  * project_id and source_kind still never change.
--  * created_by still never changes EXCEPT from a value to NULL while the referenced profile no longer exists. That condition is
--    exactly the state in which the FK action runs (the profile row is already deleted when the SET NULL update fires). A user cannot
--    produce it: authenticated has no UPDATE privilege on created_by (column-level GRANT in 0500) and cannot delete profiles; the table
--    owner / service role changing created_by of a meeting whose author still exists is refused as before, and re-assigning an author
--    to ANOTHER user is refused in every case.
--  * The function becomes SECURITY DEFINER (pinned search_path, no PUBLIC/anon/authenticated EXECUTE) because the role that deletes the
--    user (GoTrue's supabase_auth_admin) has no SELECT on public.profiles, which the existence check needs.
-- Applies on top of 0700 (the hosted state) and, equally, on top of 0800. Idempotent. No data is changed.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000700_meeting_audio') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261118000700_meeting_audio first. Nothing was changed.';
    END IF;
    IF to_regclass('public.meetings') IS NULL OR to_regprocedure('public.guard_meeting_identity()') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed -- public.meetings / guard_meeting_identity() are missing. Nothing was changed.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_meeting_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.source_kind IS DISTINCT FROM OLD.source_kind THEN
        RAISE EXCEPTION 'Projekt, autora ani typ zdroje porady nelze měnit.' USING ERRCODE = '42501';
    END IF;
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        -- the only legitimate change: ON DELETE SET NULL after the author's profile has been deleted (account erasure)
        IF NOT (OLD.created_by IS NOT NULL AND NEW.created_by IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.created_by)) THEN
            RAISE EXCEPTION 'Projekt, autora ani typ zdroje porady nelze měnit.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_meeting_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meetings_guard_identity ON public.meetings;
CREATE TRIGGER meetings_guard_identity BEFORE UPDATE ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.guard_meeting_identity();

INSERT INTO public.clearspace_migrations (version) VALUES ('20261118000900_meeting_creator_erasure')
ON CONFLICT (version) DO NOTHING;
