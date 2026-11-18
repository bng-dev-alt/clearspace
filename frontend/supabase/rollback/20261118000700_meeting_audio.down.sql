-- ROLLBACK of 20261118000700_meeting_audio (NOT a migration: lives outside supabase/migrations on purpose).
-- Use only if the audio feature must be removed. It refuses while any audio data exists, because dropping the columns would
-- destroy consent records and the link to Storage objects. To override on purpose:  SET clearspace.force_rollback = 'on';
-- Storage OBJECTS and the bucket are removed through the Storage API (real Storage blocks SQL deletes); the script only checks.
DO $$
BEGIN
    IF coalesce(current_setting('clearspace.force_rollback', true), '') <> 'on' THEN
        IF EXISTS (SELECT 1 FROM public.meetings WHERE consent_at IS NOT NULL OR audio_path IS NOT NULL OR stt_state <> 'none') THEN
            RAISE EXCEPTION 'Rollback refused: meetings with consent/audio/STT data exist. Delete the audio (Storage API) and export what you need first, or SET clearspace.force_rollback = ''on''.';
        END IF;
        IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'meeting-audio') THEN
            RAISE EXCEPTION 'Rollback refused: the meeting-audio bucket still holds objects. Delete them through the Storage API first.';
        END IF;
    END IF;
END $$;

DROP POLICY IF EXISTS "meeting_audio_select" ON storage.objects;
DROP POLICY IF EXISTS "meeting_audio_insert" ON storage.objects;
DROP POLICY IF EXISTS "meeting_audio_delete" ON storage.objects;
DROP FUNCTION IF EXISTS public.can_access_meeting_audio(TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.stt_reserve(UUID, INTEGER, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS public.stt_attach_job(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.stt_fail(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.stt_complete(UUID, TEXT, TEXT, INTEGER, JSONB, INTEGER);
DROP FUNCTION IF EXISTS public.stt_mark_cleaned(UUID);
DROP FUNCTION IF EXISTS public.mark_audio_deleted(UUID);
DROP FUNCTION IF EXISTS public.attach_meeting_audio(UUID, TEXT, BIGINT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.record_audio_consent(UUID);
DROP FUNCTION IF EXISTS public.lock_meeting_for_member(UUID);

-- the lineage trigger function returns to the migration-0600 version (no 'soniox' provenance guard)
CREATE OR REPLACE FUNCTION public.validate_transcript_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_max INTEGER := (public.intelligence_limits() ->> 'max_revisions_per_meeting')::integer;
BEGIN
    IF NEW.source = 'edit' AND NEW.parent_revision IS NULL THEN
        RAISE EXCEPTION 'Úprava přepisu musí odkazovat na původní revizi.' USING ERRCODE = '22023';
    END IF;
    IF NEW.parent_revision IS NOT NULL AND NEW.parent_revision = NEW.revision THEN
        RAISE EXCEPTION 'Revize nemůže být svým vlastním předchůdcem.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.meeting_transcripts WHERE meeting_id = NEW.meeting_id) >= v_max THEN
        RAISE EXCEPTION 'Porada má maximální počet revizí přepisu (%).', v_max USING ERRCODE = 'PT429';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_transcript_lineage() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.intelligence_limits()
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('max_meetings_per_project', 500, 'max_meetings_per_user_per_day', 40, 'max_revisions_per_meeting', 25); $$;

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_stt_state_check, DROP CONSTRAINT IF EXISTS meetings_stt_misc_check;
ALTER TABLE public.meetings
    DROP COLUMN IF EXISTS consent_at, DROP COLUMN IF EXISTS consent_by, DROP COLUMN IF EXISTS audio_path, DROP COLUMN IF EXISTS audio_bytes,
    DROP COLUMN IF EXISTS audio_mime, DROP COLUMN IF EXISTS audio_client_ms, DROP COLUMN IF EXISTS audio_uploaded_at,
    DROP COLUMN IF EXISTS audio_delete_after, DROP COLUMN IF EXISTS audio_deleted_at, DROP COLUMN IF EXISTS stt_provider,
    DROP COLUMN IF EXISTS stt_model, DROP COLUMN IF EXISTS stt_job_id, DROP COLUMN IF EXISTS stt_state, DROP COLUMN IF EXISTS stt_attempts,
    DROP COLUMN IF EXISTS stt_error_type, DROP COLUMN IF EXISTS stt_submitted_at, DROP COLUMN IF EXISTS stt_audio_ms,
    DROP COLUMN IF EXISTS stt_cost_usd, DROP COLUMN IF EXISTS stt_request_id, DROP COLUMN IF EXISTS stt_cleanup_pending;
ALTER TABLE public.ai_requests DROP CONSTRAINT IF EXISTS ai_requests_audio_ms_check, DROP CONSTRAINT IF EXISTS ai_requests_cost_usd_check;
DELETE FROM public.ai_requests WHERE feature = 'meeting-transcribe';
ALTER TABLE public.ai_requests DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS audio_ms, DROP COLUMN IF EXISTS cost_usd;

-- The empty bucket is removed through the Storage API (DELETE /storage/v1/bucket/meeting-audio); on the plain-Postgres harness SQL is enough.
DO $$
BEGIN
    IF to_regprocedure('storage.protect_delete()') IS NULL THEN
        DELETE FROM storage.buckets WHERE id = 'meeting-audio';
    END IF;
END $$;
DELETE FROM public.clearspace_migrations WHERE version = '20261118000700_meeting_audio';
