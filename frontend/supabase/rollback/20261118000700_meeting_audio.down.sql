-- ROLLBACK of 20261118000700_meeting_audio (NOT a migration: lives outside supabase/migrations on purpose).
-- Refuses while data would be lost: consent/audio/STT state, provider job rows (their ids are the only handle for provider-side
-- deletion), orphan-audio queue rows, a non-empty bucket, ledger history of audio usage, a registered server secret. To override on
-- purpose:  SET clearspace.force_rollback = 'on';  (the Storage objects and the bucket are removed through the Storage API on a real
-- project; real Storage blocks SQL deletes, so this script only checks them). Does NOT touch functions that migration 0600 defines.
DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000800_stt_stabilization_repair') THEN
        RAISE EXCEPTION 'Rollback refused: roll back 20261118000800 first.';
    END IF;
    IF coalesce(current_setting('clearspace.force_rollback', true), '') <> 'on' THEN
        IF EXISTS (SELECT 1 FROM public.meetings WHERE consent_at IS NOT NULL OR audio_path IS NOT NULL OR stt_state <> 'none') THEN
            RAISE EXCEPTION 'Rollback refused: meetings with consent/audio/STT data exist. Delete the audio (Storage API) and export what you need first, or SET clearspace.force_rollback = ''on''.';
        END IF;
        IF EXISTS (SELECT 1 FROM public.stt_jobs) THEN
            RAISE EXCEPTION 'Rollback refused: stt_jobs rows exist (provider job ids needed for provider-side deletion).';
        END IF;
        IF to_regclass('public.server_trust') IS NOT NULL AND EXISTS (SELECT 1 FROM public.server_trust) THEN
            RAISE EXCEPTION 'Rollback refused: a server secret hash is registered in server_trust (dropping it disables nothing else, but the owner must re-register it after a re-apply). Use force_rollback to proceed.';
        END IF;
        IF EXISTS (SELECT 1 FROM public.meeting_audio_orphans) THEN
            RAISE EXCEPTION 'Rollback refused: orphaned audio is still queued for deletion.';
        END IF;
        IF EXISTS (SELECT 1 FROM public.ai_requests WHERE feature = 'meeting-transcribe') THEN
            RAISE EXCEPTION 'Rollback refused: ledger history of audio usage exists (it would be deleted).';
        END IF;
        IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'meeting-audio') THEN
            RAISE EXCEPTION 'Rollback refused: the meeting-audio bucket still holds objects. Delete them through the Storage API first.';
        END IF;
    END IF;
END $$;

DROP POLICY IF EXISTS "meeting_audio_select" ON storage.objects;
DROP POLICY IF EXISTS "meeting_audio_insert" ON storage.objects;
DROP POLICY IF EXISTS "meeting_audio_delete" ON storage.objects;
DROP TRIGGER IF EXISTS meetings_queue_audio_orphan ON public.meetings;
DROP FUNCTION IF EXISTS public.queue_audio_orphan();
DROP FUNCTION IF EXISTS public.can_access_meeting_audio(TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.is_orphan_meeting_audio(TEXT);
DROP FUNCTION IF EXISTS public.meeting_audio_object_count(TEXT);
DROP FUNCTION IF EXISTS public.list_project_audio(TEXT, BOOLEAN, INTEGER);
DROP FUNCTION IF EXISTS public.stt_reserve(TEXT, UUID, INTEGER, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS public.stt_attach_job(TEXT, UUID, INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.stt_mark_unknown(TEXT, UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.stt_resolve_unknown(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.stt_fail(TEXT, UUID, INTEGER, TEXT, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.stt_complete(TEXT, UUID, TEXT, TEXT, INTEGER, JSONB, INTEGER);
DROP FUNCTION IF EXISTS public.stt_cleanup_result(TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.mark_audio_deleted(UUID);
DROP FUNCTION IF EXISTS public.attach_meeting_audio(UUID, TEXT, BIGINT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.record_audio_consent(UUID);
DROP FUNCTION IF EXISTS public.lock_meeting_for_member(UUID);
DROP FUNCTION IF EXISTS public.require_server_secret(TEXT, TEXT);
DROP TABLE IF EXISTS public.stt_jobs;
DROP TABLE IF EXISTS public.meeting_audio_orphans;
DROP TABLE IF EXISTS public.server_trust;

ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_stt_state_check, DROP CONSTRAINT IF EXISTS meetings_stt_misc_check;
ALTER TABLE public.meetings
    DROP COLUMN IF EXISTS consent_at, DROP COLUMN IF EXISTS consent_by, DROP COLUMN IF EXISTS audio_path, DROP COLUMN IF EXISTS audio_bytes,
    DROP COLUMN IF EXISTS audio_mime, DROP COLUMN IF EXISTS audio_client_ms, DROP COLUMN IF EXISTS audio_uploaded_at,
    DROP COLUMN IF EXISTS audio_delete_after, DROP COLUMN IF EXISTS audio_deleted_at, DROP COLUMN IF EXISTS stt_provider,
    DROP COLUMN IF EXISTS stt_model, DROP COLUMN IF EXISTS stt_job_id, DROP COLUMN IF EXISTS stt_state, DROP COLUMN IF EXISTS stt_attempts,
    DROP COLUMN IF EXISTS stt_error_type, DROP COLUMN IF EXISTS stt_submitted_at, DROP COLUMN IF EXISTS stt_audio_ms,
    DROP COLUMN IF EXISTS stt_cost_usd, DROP COLUMN IF EXISTS stt_request_id, DROP COLUMN IF EXISTS stt_cleanup_pending;
ALTER TABLE public.ai_requests DROP CONSTRAINT IF EXISTS ai_requests_audio_ms_check, DROP CONSTRAINT IF EXISTS ai_requests_cost_usd_check, DROP CONSTRAINT IF EXISTS ai_requests_billing_state_check;
DELETE FROM public.ai_requests WHERE feature = 'meeting-transcribe'; -- only reachable with force_rollback (guarded above)
ALTER TABLE public.ai_requests DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS audio_ms, DROP COLUMN IF EXISTS cost_usd, DROP COLUMN IF EXISTS billing_state;

-- The empty bucket is removed through the Storage API (DELETE /storage/v1/bucket/meeting-audio); on the plain-Postgres harness SQL is enough.
DO $$
BEGIN
    IF to_regprocedure('storage.protect_delete()') IS NULL THEN
        DELETE FROM storage.buckets WHERE id = 'meeting-audio';
    END IF;
END $$;
DELETE FROM public.clearspace_migrations WHERE version = '20261118000700_meeting_audio';
