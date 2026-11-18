-- ROLLBACK of 20261118000500_intelligence_core (NOT a migration). Roll back 0600 and 0700 FIRST.
-- Refuses while ANY meeting, transcript, run or item exists (all of it would be deleted). Override on purpose with
--   SET clearspace.force_rollback = 'on';
DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.clearspace_migrations WHERE version IN ('20261118000600_intelligence_quality', '20261118000700_meeting_audio', '20261118000800_stt_stabilization_repair')) THEN
        RAISE EXCEPTION 'Rollback refused: roll back 20261118000700 and 20261118000600 first.';
    END IF;
    IF coalesce(current_setting('clearspace.force_rollback', true), '') <> 'on' THEN
        IF EXISTS (SELECT 1 FROM public.meetings) OR EXISTS (SELECT 1 FROM public.intelligence_runs) OR EXISTS (SELECT 1 FROM public.intelligence_items) THEN
            RAISE EXCEPTION 'Rollback refused: meetings / intelligence runs / items exist and would be deleted. Export them first or SET clearspace.force_rollback = ''on''.';
        END IF;
    END IF;
END $$;

DROP TABLE IF EXISTS public.intelligence_items;
DROP TABLE IF EXISTS public.intelligence_runs;
DROP TABLE IF EXISTS public.meeting_transcripts;
DROP TABLE IF EXISTS public.meetings;
DROP FUNCTION IF EXISTS public.persist_meeting_run(UUID, JSONB, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.persist_project_brief(TEXT, JSONB);
DROP FUNCTION IF EXISTS public.review_intelligence_item(UUID, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.apply_intelligence_item(UUID, JSONB);
DROP FUNCTION IF EXISTS public.undo_intelligence_item(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.validate_meeting_transcript();
DROP FUNCTION IF EXISTS public.on_meeting_transcript_insert();
DROP FUNCTION IF EXISTS public.guard_meeting_identity();
DROP FUNCTION IF EXISTS public.validate_intelligence_item();
DROP FUNCTION IF EXISTS public.guard_intelligence_item_update();
DROP FUNCTION IF EXISTS public.quote_in_text(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.fold_text(TEXT);
DROP FUNCTION IF EXISTS public.iso_date_or_null(TEXT);
DROP FUNCTION IF EXISTS public.touch_updated_at();
DELETE FROM public.clearspace_migrations WHERE version = '20261118000500_intelligence_core';
