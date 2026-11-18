-- ============================================================
-- 20261118000700 -- Meeting audio (R5): consent, private Storage bucket, Soniox transcription state machine
--
-- ADDITIVE and idempotent. Apply after 20261118000600_intelligence_quality.
--
-- Design (docs/intelligence/ARCHITECTURE.md §5, docs/intelligence/SONIOX_API_VERIFICATION.md):
--  * Audio goes browser -> private bucket `meeting-audio` (path <project>/<meeting>/<uuid>.<ext>) under the caller's own RLS.
--    The Storage INSERT policy requires the meeting to carry a recorded CONSENT, so nothing can be uploaded without it.
--  * No queue, no worker: the whole job lives in columns of `meetings` and advances only through SECURITY DEFINER RPCs that
--    check membership explicitly and take a row lock, so every step is idempotent and a suspended serverless process cannot
--    lose or duplicate work. The server (never the browser) talks to Soniox; the key never reaches the client.
--  * State machine (meetings.stt_state): none -> submitting -> transcribing -> completed | failed (failed may be retried,
--    at most `stt_attempts_per_meeting`). The provider error TYPE is stored; a provider message never is.
--  * A transcript with source 'soniox' can only be created by stt_complete (a session flag checked by a trigger), so a
--    member cannot forge machine-transcribed provenance.
--  * Usage is booked in the existing ledger (ai_requests: provider, audio_ms, cost_usd) with daily audio-minute budgets.
--  * Retention: audio_delete_after is set at completion (default 7 days, max 30); mark_audio_deleted refuses while the
--    object still exists, so the row never claims a deletion that did not happen.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000600_intelligence_quality') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261118000600_intelligence_quality first. Nothing was changed.';
    END IF;
    IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL
       OR to_regprocedure('storage.foldername(text)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed -- the Storage schema is not initialised. Nothing was changed.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Ledger columns (usage and cost of audio)
-- ------------------------------------------------------------
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS audio_ms INTEGER;
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 4);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_requests_audio_ms_check') THEN
        ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_audio_ms_check CHECK (audio_ms IS NULL OR audio_ms >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_requests_cost_usd_check') THEN
        ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_cost_usd_check CHECK (cost_usd IS NULL OR cost_usd >= 0);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 2. meetings: consent, audio object, STT job state
-- ------------------------------------------------------------
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS consent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS consent_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_path TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_bytes BIGINT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_mime TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_client_ms INTEGER;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_uploaded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_delete_after TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS audio_deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_provider TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_model TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_job_id TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_error_type TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_submitted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_audio_ms INTEGER;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_cost_usd NUMERIC(10, 4);
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_request_id UUID REFERENCES public.ai_requests(id) ON DELETE SET NULL;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS stt_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_stt_state_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_stt_state_check
            CHECK (stt_state IN ('none', 'submitting', 'transcribing', 'completed', 'failed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_stt_misc_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_stt_misc_check CHECK (
            stt_attempts BETWEEN 0 AND 10
            AND (stt_error_type IS NULL OR stt_error_type ~ '^[a-z0-9_]{1,64}$')
            AND (stt_job_id IS NULL OR char_length(stt_job_id) BETWEEN 1 AND 100)
            AND (audio_bytes IS NULL OR audio_bytes BETWEEN 1 AND 52428800)
            AND (audio_client_ms IS NULL OR audio_client_ms BETWEEN 0 AND 18000000));
    END IF;
END $$;
-- No new client privileges: consent, audio and STT columns are written only by the RPCs below.

-- Limits in one place (extends the function from migration 0600; same keys kept).
CREATE OR REPLACE FUNCTION public.intelligence_limits()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'max_meetings_per_project', 500,
        'max_meetings_per_user_per_day', 40,
        'max_revisions_per_meeting', 25,
        'stt_attempts_per_meeting', 3,
        'audio_retention_days_default', 7,
        'audio_retention_days_max', 30,
        'max_audio_bytes', 52428800,
        'max_audio_ms', 18000000,
        'stt_stuck_minutes', 10
    );
$$;

-- ------------------------------------------------------------
-- 3. Private bucket + policies (insert requires recorded consent)
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'meeting-audio', 'meeting-audio', false, 52428800,
    ARRAY['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/webm',
          'audio/ogg', 'audio/aac', 'audio/flac', 'audio/x-flac']
)
ON CONFLICT (id) DO UPDATE
   SET public = false,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- SECURITY INVOKER: evaluated under the caller's own RLS (a non-member cannot even see the meeting).
CREATE OR REPLACE FUNCTION public.can_access_meeting_audio(p_name TEXT, p_require_consent BOOLEAN DEFAULT FALSE)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_length(storage.foldername(p_name), 1) = 2, false)
       AND EXISTS (
            SELECT 1 FROM public.meetings m
             WHERE m.id::text = (storage.foldername(p_name))[2]
               AND m.project_id = (storage.foldername(p_name))[1]
               AND m.source_kind = 'audio'
               AND public.is_project_member(m.project_id)
               AND (NOT p_require_consent OR m.consent_at IS NOT NULL)
       );
$$;
REVOKE ALL ON FUNCTION public.can_access_meeting_audio(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_meeting_audio(TEXT, BOOLEAN) TO authenticated;

DROP POLICY IF EXISTS "meeting_audio_select" ON storage.objects;
CREATE POLICY "meeting_audio_select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'meeting-audio' AND public.can_access_meeting_audio(name));
DROP POLICY IF EXISTS "meeting_audio_insert" ON storage.objects;
CREATE POLICY "meeting_audio_insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'meeting-audio' AND public.can_access_meeting_audio(name, TRUE));
DROP POLICY IF EXISTS "meeting_audio_delete" ON storage.objects;
CREATE POLICY "meeting_audio_delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'meeting-audio' AND public.can_access_meeting_audio(name));

-- ------------------------------------------------------------
-- 4. A transcript with source 'soniox' can only be created by stt_complete
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_transcript_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_max INTEGER := (public.intelligence_limits() ->> 'max_revisions_per_meeting')::integer;
BEGIN
    IF NEW.source = 'soniox' AND coalesce(current_setting('app.stt_persist', true), '') <> 'on' THEN
        RAISE EXCEPTION 'Přepis ze strojového přepisu lze vytvořit jen přes stt_complete.' USING ERRCODE = '42501';
    END IF;
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

-- ------------------------------------------------------------
-- 5. RPCs
-- ------------------------------------------------------------
-- Locks the meeting row and proves membership. Every state-changing RPC starts here.
CREATE OR REPLACE FUNCTION public.lock_meeting_for_member(p_meeting UUID)
RETURNS public.meetings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    SELECT * INTO v_m FROM public.meetings WHERE id = p_meeting FOR UPDATE;
    IF NOT FOUND OR NOT public.is_project_member(v_m.project_id) THEN
        RAISE EXCEPTION 'Porada neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;
    RETURN v_m;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_meeting_for_member(UUID) FROM PUBLIC, anon, authenticated;

-- Consent: "all participants were informed and agree to the recording being processed by Soniox and Google".
CREATE OR REPLACE FUNCTION public.record_audio_consent(p_meeting UUID)
RETURNS TIMESTAMP WITH TIME ZONE
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
BEGIN
    IF v_m.source_kind <> 'audio' THEN
        RAISE EXCEPTION 'Souhlas se zaznamenává jen u porady se zvukem.' USING ERRCODE = '22023';
    END IF;
    IF v_m.consent_at IS NOT NULL THEN
        RETURN v_m.consent_at; -- idempotent: the first consent stands
    END IF;
    UPDATE public.meetings SET consent_at = now(), consent_by = auth.uid() WHERE id = p_meeting RETURNING consent_at INTO v_m.consent_at;
    RETURN v_m.consent_at;
END;
$$;

-- Registers an uploaded object. Returns the PREVIOUS object path (if any) so the caller can delete it.
CREATE OR REPLACE FUNCTION public.attach_meeting_audio(p_meeting UUID, p_path TEXT, p_bytes BIGINT, p_mime TEXT, p_client_ms INTEGER DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
    v_lim JSONB := public.intelligence_limits();
    v_obj_size BIGINT;
    v_old TEXT;
BEGIN
    IF v_m.source_kind <> 'audio' THEN
        RAISE EXCEPTION 'Zvuk lze připojit jen k poradě se zvukem.' USING ERRCODE = '22023';
    END IF;
    IF v_m.consent_at IS NULL THEN
        RAISE EXCEPTION 'Bez zaznamenaného souhlasu účastníků nelze zvuk připojit.' USING ERRCODE = '55000';
    END IF;
    IF v_m.stt_state IN ('submitting', 'transcribing') THEN
        RAISE EXCEPTION 'Přepis právě probíhá; zvuk teď nelze nahradit.' USING ERRCODE = '55000';
    END IF;
    IF p_path IS NULL OR NOT starts_with(p_path, v_m.project_id || '/' || v_m.id::text || '/')
       OR substr(p_path, length(v_m.project_id || '/' || v_m.id::text || '/') + 1) !~ '^[0-9a-f-]{36}\.(mp3|m4a|mp4|wav|webm|ogg|aac|flac)$' THEN
        RAISE EXCEPTION 'Neplatná cesta souboru.' USING ERRCODE = '22023';
    END IF;
    IF p_mime IS NULL OR p_mime NOT IN (SELECT unnest(allowed_mime_types) FROM storage.buckets WHERE id = 'meeting-audio') THEN
        RAISE EXCEPTION 'Nepodporovaný typ zvuku.' USING ERRCODE = '22023';
    END IF;
    IF p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND (v_lim ->> 'max_audio_bytes')::bigint THEN
        RAISE EXCEPTION 'Neplatná velikost zvuku.' USING ERRCODE = '22023';
    END IF;
    IF p_client_ms IS NOT NULL AND p_client_ms NOT BETWEEN 0 AND (v_lim ->> 'max_audio_ms')::integer THEN
        RAISE EXCEPTION 'Zvuk je delší než povolený limit (300 minut).' USING ERRCODE = '22023';
    END IF;
    -- the object must really exist in the bucket (uploaded under the caller's RLS) and its size must match
    SELECT coalesce(nullif(o.metadata ->> 'size', '')::bigint, p_bytes) INTO v_obj_size
      FROM storage.objects o WHERE o.bucket_id = 'meeting-audio' AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Soubor ve úložišti nebyl nalezen.' USING ERRCODE = '22023';
    END IF;
    IF v_obj_size <> p_bytes THEN
        RAISE EXCEPTION 'Velikost souboru nesouhlasí s úložištěm.' USING ERRCODE = '22023';
    END IF;

    v_old := CASE WHEN v_m.audio_deleted_at IS NULL AND v_m.audio_path IS DISTINCT FROM p_path THEN v_m.audio_path ELSE NULL END;
    UPDATE public.meetings
       SET audio_path = p_path, audio_bytes = p_bytes, audio_mime = p_mime, audio_client_ms = p_client_ms,
           audio_uploaded_at = now(), audio_deleted_at = NULL, audio_delete_after = NULL,
           stt_state = 'none', stt_error_type = NULL, stt_job_id = NULL, stt_attempts = 0,
           status = CASE WHEN status IN ('draft', 'uploaded', 'failed') THEN 'uploaded' ELSE status END
     WHERE id = p_meeting;
    RETURN v_old;
END;
$$;

-- Starts (or reports) a transcription job. Budgets are in audio milliseconds per user and globally per 24 h.
CREATE OR REPLACE FUNCTION public.stt_reserve(
    p_meeting UUID,
    p_est_audio_ms INTEGER,
    p_user_daily_ms BIGINT,
    p_global_daily_ms BIGINT
)
RETURNS TABLE (outcome TEXT, request_id UUID, attempt INTEGER, audio_path TEXT, audio_mime TEXT, project_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
    v_lim JSONB := public.intelligence_limits();
    v_used_user BIGINT;
    v_used_global BIGINT;
    v_id UUID;
BEGIN
    IF p_est_audio_ms IS NULL OR p_est_audio_ms NOT BETWEEN 1 AND (v_lim ->> 'max_audio_ms')::integer
       OR p_user_daily_ms IS NULL OR p_user_daily_ms < 1 OR p_global_daily_ms IS NULL OR p_global_daily_ms < 1 THEN
        RAISE EXCEPTION 'Neplatné parametry rezervace přepisu.' USING ERRCODE = '22023';
    END IF;
    IF v_m.source_kind <> 'audio' THEN
        RAISE EXCEPTION 'Přepis lze spustit jen u porady se zvukem.' USING ERRCODE = '22023';
    END IF;

    IF v_m.consent_at IS NULL THEN
        RETURN QUERY SELECT 'no_consent'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;
    IF v_m.stt_state = 'completed' THEN
        RETURN QUERY SELECT 'already_done'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;
    IF v_m.audio_path IS NULL OR v_m.audio_deleted_at IS NOT NULL THEN
        RETURN QUERY SELECT 'no_audio'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;
    -- an in-flight job is NOT submitted twice (idempotent); a submission that never got a job id for N minutes is stuck and may be redone
    IF v_m.stt_state = 'transcribing'
       OR (v_m.stt_state = 'submitting' AND v_m.stt_submitted_at > now() - make_interval(mins => (v_lim ->> 'stt_stuck_minutes')::integer)) THEN
        RETURN QUERY SELECT 'in_progress'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;
    IF v_m.stt_attempts >= (v_lim ->> 'stt_attempts_per_meeting')::integer THEN
        RETURN QUERY SELECT 'attempts_exhausted'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:user:' || v_uid::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:global', 0));
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_user FROM public.ai_requests r
     WHERE r.user_id = v_uid AND r.feature = 'meeting-transcribe' AND r.status <> 'failed' AND r.created_at > now() - interval '24 hours';
    IF v_used_user + p_est_audio_ms > p_user_daily_ms THEN
        RETURN QUERY SELECT 'budget_exceeded'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_global FROM public.ai_requests r
     WHERE r.feature = 'meeting-transcribe' AND r.status <> 'failed' AND r.created_at > now() - interval '24 hours';
    IF v_used_global + p_est_audio_ms > p_global_daily_ms THEN
        RETURN QUERY SELECT 'global_budget_exceeded'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id; RETURN;
    END IF;

    -- a stuck earlier submission is closed in the ledger before a new one is booked
    IF v_m.stt_request_id IS NOT NULL AND v_m.stt_state = 'submitting' THEN
        UPDATE public.ai_requests SET status = 'failed', error_code = 'stuck', completed_at = now()
         WHERE id = v_m.stt_request_id AND status = 'reserved';
    END IF;
    INSERT INTO public.ai_requests (user_id, project_id, feature, status, reserved_tokens, provider, audio_ms)
    VALUES (v_uid, v_m.project_id, 'meeting-transcribe', 'reserved', 0, 'soniox', p_est_audio_ms)
    RETURNING public.ai_requests.id INTO v_id;

    UPDATE public.meetings
       SET stt_state = 'submitting', stt_attempts = stt_attempts + 1, stt_submitted_at = now(), stt_request_id = v_id,
           stt_error_type = NULL, stt_job_id = NULL, status = 'transcribing'
     WHERE id = p_meeting;
    RETURN QUERY SELECT 'started'::TEXT, v_id, v_m.stt_attempts + 1, v_m.audio_path, v_m.audio_mime, v_m.project_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.stt_attach_job(p_meeting UUID, p_job_id TEXT, p_model TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
BEGIN
    IF p_job_id IS NULL OR char_length(p_job_id) NOT BETWEEN 1 AND 100 OR p_model IS NULL OR char_length(p_model) NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION 'Neplatná data úlohy přepisu.' USING ERRCODE = '22023';
    END IF;
    IF v_m.stt_state = 'transcribing' AND v_m.stt_job_id = p_job_id THEN
        RETURN; -- idempotent
    END IF;
    IF v_m.stt_state <> 'submitting' THEN
        RAISE EXCEPTION 'Přepis není ve stavu odesílání.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.meetings SET stt_job_id = p_job_id, stt_model = p_model, stt_provider = 'soniox', stt_state = 'transcribing' WHERE id = p_meeting;
    UPDATE public.ai_requests SET model = p_model WHERE id = v_m.stt_request_id;
END;
$$;

-- Records a failure. Only the classified error TYPE is stored. If a provider job exists its data still has to be cleaned up.
CREATE OR REPLACE FUNCTION public.stt_fail(p_meeting UUID, p_job_id TEXT, p_error_type TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
    v_type TEXT := CASE WHEN p_error_type ~ '^[a-z0-9_]{1,64}$' THEN p_error_type ELSE 'unknown' END;
BEGIN
    IF v_m.stt_state = 'failed' THEN
        RETURN; -- idempotent
    END IF;
    IF v_m.stt_state NOT IN ('submitting', 'transcribing') THEN
        RAISE EXCEPTION 'Přepis neběží, není co označit jako selhaný.' USING ERRCODE = '55000';
    END IF;
    IF p_job_id IS NOT NULL AND v_m.stt_job_id IS NOT NULL AND v_m.stt_job_id <> p_job_id THEN
        RAISE EXCEPTION 'Úloha přepisu nesouhlasí.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.meetings
       SET stt_state = 'failed', stt_error_type = v_type, status = 'failed',
           stt_cleanup_pending = (coalesce(p_job_id, v_m.stt_job_id) IS NOT NULL),
           stt_job_id = coalesce(v_m.stt_job_id, p_job_id)
     WHERE id = p_meeting;
    UPDATE public.ai_requests SET status = 'failed', error_code = v_type, completed_at = now(), audio_ms = 0, cost_usd = 0
     WHERE id = v_m.stt_request_id AND status = 'reserved';
END;
$$;

-- Stores the normalised transcript as revision 1 (source 'soniox') and books the real audio duration and cost.
CREATE OR REPLACE FUNCTION public.stt_complete(
    p_meeting UUID,
    p_job_id TEXT,
    p_model TEXT,
    p_audio_ms INTEGER,
    p_transcript JSONB,
    p_retention_days INTEGER DEFAULT 7
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
    v_lim JSONB := public.intelligence_limits();
    v_rev TEXT := p_transcript ->> 'revision';
    v_cost NUMERIC(10, 4);
    v_days INTEGER := least(greatest(coalesce(p_retention_days, 7), 1), (v_lim ->> 'audio_retention_days_max')::integer);
BEGIN
    IF v_m.stt_state = 'completed' AND v_m.stt_job_id = p_job_id THEN
        RETURN v_m.current_revision; -- idempotent: the same job is stored once
    END IF;
    IF v_m.stt_state <> 'transcribing' OR v_m.stt_job_id IS DISTINCT FROM p_job_id THEN
        RAISE EXCEPTION 'Úloha přepisu nesouhlasí nebo neběží.' USING ERRCODE = '55000';
    END IF;
    IF p_audio_ms IS NULL OR p_audio_ms NOT BETWEEN 0 AND (v_lim ->> 'max_audio_ms')::integer
       OR v_rev IS NULL OR v_rev !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_transcript -> 'segments') <> 'array' THEN
        RAISE EXCEPTION 'Neplatný přepis.' USING ERRCODE = '22023';
    END IF;

    PERFORM set_config('app.stt_persist', 'on', true); -- transaction-local; checked by validate_transcript_lineage
    INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, coverage, char_count, created_by)
    VALUES (p_meeting, v_m.project_id, v_rev, 'soniox',
            coalesce(p_transcript -> 'speakers', '[]'::jsonb), p_transcript -> 'segments', coalesce(p_transcript -> 'coverage', '{}'::jsonb),
            (p_transcript ->> 'char_count')::integer, auth.uid())
    ON CONFLICT (meeting_id, revision) DO NOTHING;
    PERFORM set_config('app.stt_persist', 'off', true);

    v_cost := round(p_audio_ms::numeric / 3600000.0 * 0.10, 4); -- estimate: US$0.10 per audio hour (verified 2026-11-18)
    UPDATE public.meetings
       SET stt_state = 'completed', stt_audio_ms = p_audio_ms, stt_cost_usd = v_cost, stt_error_type = NULL, stt_model = p_model,
           stt_cleanup_pending = TRUE,
           audio_delete_after = now() + make_interval(days => v_days),
           current_revision = v_rev, status = 'transcribed'
     WHERE id = p_meeting;
    UPDATE public.ai_requests
       SET status = 'succeeded', model = p_model, audio_ms = p_audio_ms, cost_usd = v_cost, completed_at = now()
     WHERE id = v_m.stt_request_id;
    RETURN v_rev;
END;
$$;

CREATE OR REPLACE FUNCTION public.stt_mark_cleaned(p_meeting UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
BEGIN
    UPDATE public.meetings SET stt_cleanup_pending = FALSE WHERE id = p_meeting;
END;
$$;

-- Marks the audio as deleted ONLY if the Storage object is really gone (the caller deletes it through the Storage API first).
CREATE OR REPLACE FUNCTION public.mark_audio_deleted(p_meeting UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE := public.lock_meeting_for_member(p_meeting);
BEGIN
    IF v_m.audio_path IS NULL THEN
        RETURN; -- nothing attached or already deleted (idempotent)
    END IF;
    IF v_m.stt_state IN ('submitting', 'transcribing') THEN
        RAISE EXCEPTION 'Zvuk nelze smazat, dokud přepis běží.' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'meeting-audio' AND o.name = v_m.audio_path) THEN
        RAISE EXCEPTION 'Soubor ve úložišti ještě existuje; nejprve ho smažte.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.meetings SET audio_path = NULL, audio_deleted_at = now(), audio_delete_after = NULL WHERE id = p_meeting;
END;
$$;

DO $$
DECLARE
    f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'record_audio_consent(uuid)', 'attach_meeting_audio(uuid,text,bigint,text,integer)',
        'stt_reserve(uuid,integer,bigint,bigint)', 'stt_attach_job(uuid,text,text)', 'stt_fail(uuid,text,text)',
        'stt_complete(uuid,text,text,integer,jsonb,integer)', 'stt_mark_cleaned(uuid)', 'mark_audio_deleted(uuid)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261118000700_meeting_audio')
ON CONFLICT (version) DO NOTHING;
