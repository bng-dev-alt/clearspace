-- ROLLBACK of 20261118000600_intelligence_quality (NOT a migration). Roll back 0700 FIRST.
-- Refuses while data would be lost: explicit column roles, transcript edits (source 'edit' / lineage). Override on purpose with
--   SET clearspace.force_rollback = 'on';
DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NOT NULL AND EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000700_meeting_audio') THEN
        RAISE EXCEPTION 'Rollback refused: roll back 20261118000700_meeting_audio first.';
    END IF;
    IF coalesce(current_setting('clearspace.force_rollback', true), '') <> 'on' THEN
        IF EXISTS (SELECT 1 FROM public.meeting_transcripts WHERE source = 'edit' OR parent_revision IS NOT NULL) THEN
            RAISE EXCEPTION 'Rollback refused: transcript revisions created by edits exist (lineage would be lost).';
        END IF;
        IF EXISTS (SELECT 1 FROM public.columns WHERE role IS NOT NULL) THEN
            RAISE EXCEPTION 'Rollback refused: columns carry roles (the human choices would be lost; the name-based fallback still works without them).';
        END IF;
    END IF;
END $$;

DROP TRIGGER IF EXISTS meetings_quota ON public.meetings;
DROP TRIGGER IF EXISTS meeting_transcripts_lineage ON public.meeting_transcripts;
DROP FUNCTION IF EXISTS public.enforce_meeting_quota();
DROP FUNCTION IF EXISTS public.validate_transcript_lineage();
DROP FUNCTION IF EXISTS public.project_intelligence_stamp(TEXT);
DROP FUNCTION IF EXISTS public.intelligence_limits();

ALTER TABLE public.meeting_transcripts DROP CONSTRAINT IF EXISTS meeting_transcripts_parent_fk, DROP CONSTRAINT IF EXISTS meeting_transcripts_edit_note_check;
ALTER TABLE public.meeting_transcripts DROP COLUMN IF EXISTS parent_revision, DROP COLUMN IF EXISTS edit_note;
DELETE FROM public.meeting_transcripts WHERE source = 'edit'; -- only reachable with force_rollback
ALTER TABLE public.meeting_transcripts DROP CONSTRAINT IF EXISTS meeting_transcripts_source_check;
ALTER TABLE public.meeting_transcripts ADD CONSTRAINT meeting_transcripts_source_check CHECK (source IN ('paste', 'txt', 'md', 'vtt', 'srt', 'soniox'));

ALTER TABLE public.columns DROP CONSTRAINT IF EXISTS columns_role_check;
ALTER TABLE public.columns DROP COLUMN IF EXISTS role;
DELETE FROM public.clearspace_migrations WHERE version = '20261118000600_intelligence_quality';
