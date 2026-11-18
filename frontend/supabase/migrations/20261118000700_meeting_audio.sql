-- ============================================================
-- 20261118000700 -- Meeting audio (R5): consent, private Storage bucket, server-trusted Soniox transcription state machine
--
-- ADDITIVE and idempotent. Apply after 20261118000600_intelligence_quality. Safe to re-run in any order relative to 0500/0600
-- (it defines no function that another migration also defines).
--
-- Design (docs/intelligence/ARCHITECTURE.md §5, docs/intelligence/SONIOX_API_VERIFICATION.md, docs/intelligence/RELEASE_PLAN_R1_R7.md):
--  * Audio goes browser -> private bucket `meeting-audio` (path <project>/<meeting>/<uuid>.<ext>) under the caller's own RLS.
--    The Storage INSERT policy requires the meeting to carry a recorded CONSENT (an attestation by the member, not proof of
--    legal compliance) and caps the number of objects per meeting.
--  * No queue, no worker: the job lives in `meetings` + `stt_jobs` and advances only through SECURITY DEFINER RPCs that take a
--    row lock, so every LOCAL state transition is idempotent and a suspended serverless process cannot duplicate or lose it.
--    Remote provider billing is NOT exactly-once: Soniox offers no idempotency key for creating a transcription. The design
--    therefore never repeats a POST whose outcome is unknown, reconciles by `client_reference_id`, and keeps the estimate in
--    the budget until the outcome is known.
--  * TRUSTED BOOKKEEPING IS SERVER-ONLY. reserve / attach / complete / fail / unknown / cleanup RPCs require a server secret
--    (`require_server_secret`, a hash stored in `server_trust`, the plaintext only in the server environment), in addition to
--    the caller's own project membership. A project member calling them directly with their JWT is refused; budgets and
--    estimates are chosen by the server, never by a client. Until the owner registers a secret all of them refuse (fail closed).
--  * Money: a failure or cancellation never erases cost that may have been incurred (`ai_requests.billing_state`); a retry never
--    resets the per-meeting attempt counter; daily budgets sum everything that is not confirmed 'not_billed'.
--  * Provider data: every provider job is kept in `stt_jobs` (with its own retryable cleanup state) until deletion at the provider
--    is confirmed or abandoned after 8 tries; job rows outlive the meeting.
--  * Retention: `audio_delete_after` is set at UPLOAD (so abandoned/failed/cancelled audio has a deadline too). There is no cron;
--    deletion is performed by the server when a member opens the project's meetings or the meeting (sweep). Orphaned Storage
--    objects of deleted meetings are queued and members of the project may delete them.
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
-- 1. Ledger columns (usage, cost and billing certainty of audio)
-- ------------------------------------------------------------
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS audio_ms INTEGER;
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 4);
-- reserved = counted at the estimate; uncertain = provider outcome unknown (still counted); estimated = job exists, final length
-- unknown (counted); actual = provider reported the audio length; not_billed = CONFIRMED that nothing was billed (not counted)
ALTER TABLE public.ai_requests ADD COLUMN IF NOT EXISTS billing_state TEXT NOT NULL DEFAULT 'reserved';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_requests_audio_ms_check') THEN
        ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_audio_ms_check CHECK (audio_ms IS NULL OR audio_ms >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_requests_cost_usd_check') THEN
        ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_cost_usd_check CHECK (cost_usd IS NULL OR cost_usd >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_requests_billing_state_check') THEN
        ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_billing_state_check
            CHECK (billing_state IN ('reserved', 'uncertain', 'estimated', 'actual', 'not_billed'));
    END IF;
END $$;

-- ------------------------------------------------------------
-- 2. meetings: consent, audio object, STT state
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
            CHECK (stt_state IN ('none', 'submitting', 'unknown', 'transcribing', 'completed', 'failed'));
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

-- ------------------------------------------------------------
-- 3. Server trust: the secret never lives in the repository or a client
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.server_trust (
    purpose TEXT PRIMARY KEY CHECK (purpose ~ '^[a-z_]{1,32}$'),
    secret_sha256 TEXT NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
    rotated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.server_trust ENABLE ROW LEVEL SECURITY; -- no policy: invisible through the API
REVOKE ALL ON public.server_trust FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_trust TO service_role;

CREATE OR REPLACE FUNCTION public.require_server_secret(p_purpose TEXT, p_secret TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_secret IS NULL OR char_length(p_secret) < 32 OR NOT EXISTS (
        SELECT 1 FROM public.server_trust t
         WHERE t.purpose = p_purpose AND t.secret_sha256 = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')) THEN
        RAISE EXCEPTION 'Tato operace je vyhrazena serveru.' USING ERRCODE = '42501';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.require_server_secret(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. stt_jobs: every provider job, with its own retryable cleanup lifecycle (survives meeting/project deletion)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stt_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id UUID REFERENCES public.meetings(id) ON DELETE SET NULL,
    project_id TEXT NOT NULL,
    user_id UUID,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    -- sent to the provider as client_reference_id: lets an unknown outcome be reconciled by listing the provider's jobs
    client_reference TEXT NOT NULL CHECK (char_length(client_reference) <= 120),
    provider_job_id TEXT CHECK (provider_job_id IS NULL OR char_length(provider_job_id) BETWEEN 1 AND 100),
    request_id UUID REFERENCES public.ai_requests(id) ON DELETE SET NULL,
    est_audio_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN ('submitting', 'unknown_outcome', 'active', 'succeeded', 'failed', 'cancelled')),
    cleanup_state TEXT NOT NULL DEFAULT 'not_needed' CHECK (cleanup_state IN ('not_needed', 'pending', 'done', 'abandoned')),
    cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
    cleanup_due_at TIMESTAMP WITH TIME ZONE,
    cleanup_last_error TEXT CHECK (cleanup_last_error IS NULL OR cleanup_last_error ~ '^[a-z0-9_]{1,64}$'),
    cleaned_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (client_reference)
);
CREATE INDEX IF NOT EXISTS idx_stt_jobs_meeting ON public.stt_jobs (meeting_id);
CREATE INDEX IF NOT EXISTS idx_stt_jobs_cleanup ON public.stt_jobs (project_id, cleanup_state, cleanup_due_at);
ALTER TABLE public.stt_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read stt jobs" ON public.stt_jobs;
CREATE POLICY "Members read stt jobs" ON public.stt_jobs FOR SELECT TO authenticated USING (public.is_project_member(project_id));
REVOKE ALL ON public.stt_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stt_jobs TO authenticated;
GRANT ALL ON public.stt_jobs TO service_role;

-- ------------------------------------------------------------
-- 5. Private bucket + policies (insert requires consent and a per-meeting object cap)
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

-- Audio of a meeting that no longer exists (deleted directly or by cascade): kept so that members can still clean it up.
CREATE TABLE IF NOT EXISTS public.meeting_audio_orphans (
    path TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    queued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.meeting_audio_orphans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read orphan audio" ON public.meeting_audio_orphans;
CREATE POLICY "Members read orphan audio" ON public.meeting_audio_orphans FOR SELECT TO authenticated USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "Members clear orphan audio" ON public.meeting_audio_orphans;
CREATE POLICY "Members clear orphan audio" ON public.meeting_audio_orphans FOR DELETE TO authenticated USING (public.is_project_member(project_id));
REVOKE ALL ON public.meeting_audio_orphans FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.meeting_audio_orphans TO authenticated;
GRANT ALL ON public.meeting_audio_orphans TO service_role;

CREATE OR REPLACE FUNCTION public.queue_audio_orphan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.audio_path IS NOT NULL AND OLD.audio_deleted_at IS NULL THEN
        INSERT INTO public.meeting_audio_orphans (path, project_id) VALUES (OLD.audio_path, OLD.project_id) ON CONFLICT (path) DO NOTHING;
    END IF;
    RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.queue_audio_orphan() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meetings_queue_audio_orphan ON public.meetings;
CREATE TRIGGER meetings_queue_audio_orphan BEFORE DELETE ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.queue_audio_orphan();

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

-- An object whose meeting row is gone may be cleaned up by any member of the project named in its path.
CREATE OR REPLACE FUNCTION public.is_orphan_meeting_audio(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_length(storage.foldername(p_name), 1) = 2, false)
       AND public.is_project_member((storage.foldername(p_name))[1])
       AND NOT EXISTS (SELECT 1 FROM public.meetings m WHERE m.id::text = (storage.foldername(p_name))[2]);
$$;
REVOKE ALL ON FUNCTION public.is_orphan_meeting_audio(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_orphan_meeting_audio(TEXT) TO authenticated;

-- How many objects already sit in this meeting's folder (counted through the caller's own storage RLS).
CREATE OR REPLACE FUNCTION public.meeting_audio_object_count(p_name TEXT)
RETURNS INTEGER
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT count(*)::integer FROM storage.objects o
     WHERE o.bucket_id = 'meeting-audio'
       AND o.name LIKE (array_to_string(storage.foldername(p_name), '/') || '/%');
$$;
REVOKE ALL ON FUNCTION public.meeting_audio_object_count(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.meeting_audio_object_count(TEXT) TO authenticated;

DROP POLICY IF EXISTS "meeting_audio_select" ON storage.objects;
CREATE POLICY "meeting_audio_select" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'meeting-audio' AND (public.can_access_meeting_audio(name) OR public.is_orphan_meeting_audio(name)));
DROP POLICY IF EXISTS "meeting_audio_insert" ON storage.objects;
CREATE POLICY "meeting_audio_insert" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'meeting-audio' AND public.can_access_meeting_audio(name, TRUE)
                AND public.meeting_audio_object_count(name) < (public.intelligence_limits() ->> 'stt_max_objects_per_meeting')::integer);
DROP POLICY IF EXISTS "meeting_audio_delete" ON storage.objects;
CREATE POLICY "meeting_audio_delete" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'meeting-audio' AND (public.can_access_meeting_audio(name) OR public.is_orphan_meeting_audio(name)));

-- ------------------------------------------------------------
-- 6. Member-level RPCs (the caller's own JWT and project membership; no server secret)
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

-- Consent is an ATTESTATION by the member that participants were informed. It is stored (who, when) and gates the upload;
-- it does not by itself establish legal compliance (see docs/intelligence/RELEASE_PLAN_R1_R7.md, external release gates).
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

-- Registers an uploaded object and starts its retention clock. Returns the PREVIOUS object path (if any) for deletion.
-- Does NOT reset the attempt counter or forget any provider job: replacing the file can never buy new attempts.
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
    IF v_m.stt_state IN ('submitting', 'unknown', 'transcribing', 'completed') THEN
        RAISE EXCEPTION 'Zvuk teď nelze nahradit (přepis běží nebo je hotový).' USING ERRCODE = '55000';
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
           audio_uploaded_at = now(), audio_deleted_at = NULL,
           audio_delete_after = now() + make_interval(days => (v_lim ->> 'audio_retention_days_default')::integer),
           stt_state = 'none', stt_error_type = NULL,
           status = CASE WHEN status IN ('draft', 'uploaded', 'failed') THEN 'uploaded' ELSE status END
     WHERE id = p_meeting;
    RETURN v_old;
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
    IF v_m.stt_state IN ('submitting', 'unknown', 'transcribing') THEN
        RAISE EXCEPTION 'Zvuk nelze smazat, dokud přepis běží.' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'meeting-audio' AND o.name = v_m.audio_path) THEN
        RAISE EXCEPTION 'Soubor ve úložišti ještě existuje; nejprve ho smažte.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.meetings SET audio_path = NULL, audio_deleted_at = now(), audio_delete_after = NULL WHERE id = p_meeting;
END;
$$;

-- ------------------------------------------------------------
-- 7. SERVER-TRUSTED RPCs (secret required in addition to membership)
-- ------------------------------------------------------------
-- Starts a job (or reports why not). Estimate and budgets come from the SERVER. An unknown provider outcome is never repeated.
CREATE OR REPLACE FUNCTION public.stt_reserve(
    p_server_secret TEXT,
    p_meeting UUID,
    p_est_audio_ms INTEGER,
    p_user_daily_ms BIGINT,
    p_global_daily_ms BIGINT
)
RETURNS TABLE (outcome TEXT, request_id UUID, attempt INTEGER, audio_path TEXT, audio_mime TEXT, project_id TEXT, client_reference TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_m public.meetings%ROWTYPE;
    v_lim JSONB := public.intelligence_limits();
    v_used_user BIGINT;
    v_used_global BIGINT;
    v_id UUID;
    v_ref TEXT;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF p_est_audio_ms IS NULL OR p_est_audio_ms NOT BETWEEN 1 AND (v_lim ->> 'max_audio_ms')::integer
       OR p_user_daily_ms IS NULL OR p_user_daily_ms < 1 OR p_global_daily_ms IS NULL OR p_global_daily_ms < 1 THEN
        RAISE EXCEPTION 'Neplatné parametry rezervace přepisu.' USING ERRCODE = '22023';
    END IF;
    IF v_m.source_kind <> 'audio' THEN
        RAISE EXCEPTION 'Přepis lze spustit jen u porady se zvukem.' USING ERRCODE = '22023';
    END IF;

    IF v_m.consent_at IS NULL THEN
        RETURN QUERY SELECT 'no_consent'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    IF v_m.stt_state = 'completed' THEN
        RETURN QUERY SELECT 'already_done'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    IF v_m.audio_path IS NULL OR v_m.audio_deleted_at IS NOT NULL THEN
        RETURN QUERY SELECT 'no_audio'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    -- A submission that has been 'submitting' for too long means the server died around the provider POST: the outcome is
    -- UNKNOWN (the job may exist and be billed). It is never silently redone; it moves to 'unknown' and is reconciled.
    IF v_m.stt_state = 'submitting' AND v_m.stt_submitted_at <= now() - make_interval(mins => (v_lim ->> 'stt_stuck_minutes')::integer) THEN
        UPDATE public.meetings SET stt_state = 'unknown', stt_error_type = 'outcome_unknown' WHERE id = p_meeting;
        UPDATE public.stt_jobs SET state = 'unknown_outcome', updated_at = now() WHERE meeting_id = p_meeting AND stt_jobs.attempt = v_m.stt_attempts AND stt_jobs.provider_job_id IS NULL;
        UPDATE public.ai_requests SET billing_state = 'uncertain' WHERE id = v_m.stt_request_id AND status = 'reserved';
        RETURN QUERY SELECT 'unknown_outcome'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    IF v_m.stt_state = 'unknown' THEN
        RETURN QUERY SELECT 'unknown_outcome'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    IF v_m.stt_state IN ('transcribing', 'submitting') THEN
        RETURN QUERY SELECT 'in_progress'::TEXT, v_m.stt_request_id, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    -- cumulative per meeting: replacing the file or retrying never resets it
    IF v_m.stt_attempts >= (v_lim ->> 'stt_attempts_per_meeting')::integer THEN
        RETURN QUERY SELECT 'attempts_exhausted'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:user:' || v_uid::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:global', 0));
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_user FROM public.ai_requests r
     WHERE r.user_id = v_uid AND r.feature = 'meeting-transcribe' AND r.billing_state <> 'not_billed' AND r.created_at > now() - interval '24 hours';
    IF v_used_user + p_est_audio_ms > p_user_daily_ms THEN
        RETURN QUERY SELECT 'budget_exceeded'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_global FROM public.ai_requests r
     WHERE r.feature = 'meeting-transcribe' AND r.billing_state <> 'not_billed' AND r.created_at > now() - interval '24 hours';
    IF v_used_global + p_est_audio_ms > p_global_daily_ms THEN
        RETURN QUERY SELECT 'global_budget_exceeded'::TEXT, NULL::UUID, v_m.stt_attempts, NULL::TEXT, NULL::TEXT, v_m.project_id, NULL::TEXT; RETURN;
    END IF;

    INSERT INTO public.ai_requests (user_id, project_id, feature, status, reserved_tokens, provider, audio_ms, billing_state)
    VALUES (v_uid, v_m.project_id, 'meeting-transcribe', 'reserved', 0, 'soniox', p_est_audio_ms, 'reserved')
    RETURNING public.ai_requests.id INTO v_id;
    v_ref := p_meeting::text || ':' || (v_m.stt_attempts + 1)::text;
    INSERT INTO public.stt_jobs (meeting_id, project_id, user_id, attempt, client_reference, request_id, est_audio_ms, state)
    VALUES (p_meeting, v_m.project_id, v_uid, v_m.stt_attempts + 1, v_ref, v_id, p_est_audio_ms, 'submitting');
    UPDATE public.meetings
       SET stt_state = 'submitting', stt_attempts = stt_attempts + 1, stt_submitted_at = now(), stt_request_id = v_id,
           stt_error_type = NULL, status = 'transcribing'
     WHERE id = p_meeting;
    RETURN QUERY SELECT 'started'::TEXT, v_id, v_m.stt_attempts + 1, v_m.audio_path, v_m.audio_mime, v_m.project_id, v_ref;
END;
$$;

-- Records the provider's job id for the current attempt. If the meeting was cancelled/failed meanwhile, the job id is STILL kept
-- (cleanup pending) so the provider data can be deleted: returns 'orphaned' instead of failing.
CREATE OR REPLACE FUNCTION public.stt_attach_job(p_server_secret TEXT, p_meeting UUID, p_job_id TEXT, p_model TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
    v_job public.stt_jobs%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF p_job_id IS NULL OR char_length(p_job_id) NOT BETWEEN 1 AND 100 OR p_model IS NULL OR char_length(p_model) NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION 'Neplatná data úlohy přepisu.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.stt_jobs WHERE meeting_id = p_meeting AND attempt = v_m.stt_attempts FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Úloha přepisu neexistuje.' USING ERRCODE = '55000';
    END IF;
    IF v_job.provider_job_id = p_job_id THEN
        RETURN 'attached'; -- idempotent
    END IF;
    IF v_job.provider_job_id IS NOT NULL THEN
        RAISE EXCEPTION 'Tato pokus už má jinou úlohu u poskytovatele.' USING ERRCODE = '55000';
    END IF;
    IF v_m.stt_state IN ('submitting', 'unknown') THEN
        UPDATE public.stt_jobs SET provider_job_id = p_job_id, state = 'active', updated_at = now() WHERE id = v_job.id;
        UPDATE public.meetings SET stt_job_id = p_job_id, stt_model = p_model, stt_provider = 'soniox', stt_state = 'transcribing', stt_error_type = NULL WHERE id = p_meeting;
        UPDATE public.ai_requests SET model = p_model, billing_state = 'reserved' WHERE id = v_m.stt_request_id AND status = 'reserved';
        RETURN 'attached';
    END IF;
    -- cancelled / failed while the POST was in flight: keep the id so cleanup can delete the job at the provider
    UPDATE public.stt_jobs SET provider_job_id = p_job_id, cleanup_state = 'pending', cleanup_due_at = now(), updated_at = now() WHERE id = v_job.id;
    UPDATE public.meetings SET stt_cleanup_pending = TRUE WHERE id = p_meeting;
    RETURN 'orphaned';
END;
$$;

-- The provider POST ended in a way that does not tell whether the job was created (timeout, network, 5xx). NEVER repeated
-- automatically: the estimate stays in the budget and the outcome is reconciled by client_reference_id.
CREATE OR REPLACE FUNCTION public.stt_mark_unknown(p_server_secret TEXT, p_meeting UUID, p_error_type TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
    v_type TEXT := CASE WHEN p_error_type ~ '^[a-z0-9_]{1,64}$' THEN p_error_type ELSE 'unknown' END;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF v_m.stt_state = 'unknown' THEN RETURN; END IF; -- idempotent
    IF v_m.stt_state <> 'submitting' THEN
        RAISE EXCEPTION 'Odeslání nebylo rozpracováno.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.meetings SET stt_state = 'unknown', stt_error_type = v_type WHERE id = p_meeting;
    UPDATE public.stt_jobs SET state = 'unknown_outcome', updated_at = now() WHERE meeting_id = p_meeting AND attempt = v_m.stt_attempts AND provider_job_id IS NULL;
    UPDATE public.ai_requests SET billing_state = 'uncertain' WHERE id = v_m.stt_request_id AND status = 'reserved';
END;
$$;

-- Ends an unknown outcome. 'absent' = the provider's job list proved that no job exists (nothing billed, retry is safe).
-- 'abandon' = the user gave up waiting: the estimate STAYS in the budget (the job may still exist).
CREATE OR REPLACE FUNCTION public.stt_resolve_unknown(p_server_secret TEXT, p_meeting UUID, p_resolution TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF p_resolution NOT IN ('absent', 'abandon') THEN
        RAISE EXCEPTION 'Neplatné vyřešení nejistého stavu.' USING ERRCODE = '22023';
    END IF;
    IF v_m.stt_state <> 'unknown' THEN
        RETURN; -- idempotent: nothing to resolve
    END IF;
    UPDATE public.meetings
       SET stt_state = 'failed', status = 'failed', stt_error_type = CASE WHEN p_resolution = 'absent' THEN 'not_created' ELSE 'outcome_unknown' END
     WHERE id = p_meeting;
    UPDATE public.stt_jobs
       SET state = 'failed', cleanup_state = CASE WHEN p_resolution = 'absent' THEN 'not_needed' ELSE 'abandoned' END, updated_at = now()
     WHERE meeting_id = p_meeting AND attempt = v_m.stt_attempts AND provider_job_id IS NULL;
    IF p_resolution = 'absent' THEN
        UPDATE public.ai_requests SET status = 'failed', error_code = 'not_created', completed_at = now(), audio_ms = 0, cost_usd = 0, billing_state = 'not_billed'
         WHERE id = v_m.stt_request_id AND status = 'reserved';
    ELSE
        UPDATE public.ai_requests SET status = 'failed', error_code = 'outcome_unknown', completed_at = now()
         WHERE id = v_m.stt_request_id AND status = 'reserved'; -- billing_state stays 'uncertain', the estimate keeps counting
    END IF;
END;
$$;

-- Records a failure. p_billing says what we KNOW about cost: 'none' (confirmed nothing billed), 'uncertain', 'estimated'
-- (a job exists and may have run: the reserved estimate stays), 'actual' (provider reported p_audio_ms). A failure or a
-- cancellation therefore never erases cost that may have been incurred.
CREATE OR REPLACE FUNCTION public.stt_fail(p_server_secret TEXT, p_meeting UUID, p_job_id TEXT, p_error_type TEXT, p_billing TEXT, p_audio_ms INTEGER DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
    v_type TEXT := CASE WHEN p_error_type ~ '^[a-z0-9_]{1,64}$' THEN p_error_type ELSE 'unknown' END;
    v_job public.stt_jobs%ROWTYPE;
    v_pid TEXT;
    v_ms INTEGER;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF p_billing NOT IN ('none', 'uncertain', 'estimated', 'actual') THEN
        RAISE EXCEPTION 'Neplatný stav účtování.' USING ERRCODE = '22023';
    END IF;
    IF v_m.stt_state = 'failed' THEN
        RETURN; -- idempotent
    END IF;
    IF v_m.stt_state NOT IN ('submitting', 'transcribing') THEN
        RAISE EXCEPTION 'Přepis neběží, není co označit jako selhaný.' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO v_job FROM public.stt_jobs WHERE meeting_id = p_meeting AND attempt = v_m.stt_attempts FOR UPDATE;
    v_pid := coalesce(v_job.provider_job_id, p_job_id); -- NOT v_m.stt_job_id: that is the PREVIOUS attempt's id
    IF p_job_id IS NOT NULL AND v_job.provider_job_id IS NOT NULL AND v_job.provider_job_id <> p_job_id THEN
        RAISE EXCEPTION 'Úloha přepisu nesouhlasí.' USING ERRCODE = '55000';
    END IF;
    UPDATE public.stt_jobs
       SET provider_job_id = v_pid, state = CASE WHEN v_type = 'cancelled' THEN 'cancelled' ELSE 'failed' END,
           cleanup_state = CASE WHEN v_pid IS NULL THEN 'not_needed' ELSE 'pending' END,
           cleanup_due_at = CASE WHEN v_pid IS NULL THEN NULL ELSE now() END, updated_at = now()
     WHERE id = v_job.id;
    UPDATE public.meetings
       SET stt_state = 'failed', stt_error_type = v_type, status = 'failed', stt_job_id = coalesce(v_pid, stt_job_id),
           stt_cleanup_pending = (v_pid IS NOT NULL) OR stt_cleanup_pending
     WHERE id = p_meeting;
    IF p_billing = 'none' THEN
        UPDATE public.ai_requests SET status = 'failed', error_code = v_type, completed_at = now(), audio_ms = 0, cost_usd = 0, billing_state = 'not_billed'
         WHERE id = v_m.stt_request_id AND status = 'reserved';
    ELSE
        v_ms := CASE WHEN p_billing = 'actual' THEN least(greatest(coalesce(p_audio_ms, 0), 0), (public.intelligence_limits() ->> 'max_audio_ms')::integer) ELSE NULL END;
        UPDATE public.ai_requests
           SET status = 'failed', error_code = v_type, completed_at = now(), billing_state = p_billing,
               audio_ms = coalesce(v_ms, audio_ms), cost_usd = round(coalesce(v_ms, audio_ms)::numeric / 3600000.0 * 0.10, 4)
         WHERE id = v_m.stt_request_id AND status = 'reserved';
    END IF;
END;
$$;

-- Stores the normalised transcript as a revision (source 'soniox') and books the real audio duration and cost.
CREATE OR REPLACE FUNCTION public.stt_complete(
    p_server_secret TEXT,
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
    v_m public.meetings%ROWTYPE;
    v_lim JSONB := public.intelligence_limits();
    v_rev TEXT := p_transcript ->> 'revision';
    v_cost NUMERIC(10, 4);
    v_days INTEGER := least(greatest(coalesce(p_retention_days, 7), 1), (v_lim ->> 'audio_retention_days_max')::integer);
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF v_m.stt_state = 'completed' AND v_m.stt_job_id = p_job_id THEN
        RETURN v_m.current_revision; -- idempotent: the same job is stored once
    END IF;
    IF v_m.stt_state <> 'transcribing' OR v_m.stt_job_id IS DISTINCT FROM p_job_id THEN
        RAISE EXCEPTION 'Úloha přepisu nesouhlasí nebo neběží.' USING ERRCODE = '55000';
    END IF;
    IF p_audio_ms IS NULL OR p_audio_ms NOT BETWEEN 0 AND (v_lim ->> 'max_audio_ms')::integer
       OR v_rev IS NULL OR v_rev !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_transcript -> 'segments') IS DISTINCT FROM 'array' THEN
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
           -- the deadline set at upload is never extended
           audio_delete_after = least(coalesce(audio_delete_after, now() + make_interval(days => v_days)), now() + make_interval(days => v_days)),
           current_revision = v_rev, status = 'transcribed'
     WHERE id = p_meeting;
    UPDATE public.stt_jobs SET state = 'succeeded', cleanup_state = 'pending', cleanup_due_at = now(), updated_at = now()
     WHERE meeting_id = p_meeting AND provider_job_id = p_job_id;
    UPDATE public.ai_requests
       SET status = 'succeeded', model = p_model, audio_ms = p_audio_ms, cost_usd = v_cost, completed_at = now(), billing_state = 'actual'
     WHERE id = v_m.stt_request_id;
    RETURN v_rev;
END;
$$;

-- Result of a provider-side deletion attempt. 'retry' backs off (2^n minutes, max 24 h) and gives up after 8 tries
-- (the provider deletes everything after 30 days anyway). The job row, and with it the provider job id, outlives the meeting.
CREATE OR REPLACE FUNCTION public.stt_cleanup_result(p_server_secret TEXT, p_job UUID, p_result TEXT, p_error_type TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.stt_jobs%ROWTYPE;
    v_err TEXT := CASE WHEN p_error_type ~ '^[a-z0-9_]{1,64}$' THEN p_error_type ELSE NULL END;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_result NOT IN ('done', 'retry', 'abandon') THEN
        RAISE EXCEPTION 'Neplatný výsledek úklidu.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.stt_jobs WHERE id = p_job FOR UPDATE;
    IF NOT FOUND OR NOT public.is_project_member(v_job.project_id) THEN
        RAISE EXCEPTION 'Úloha neexistuje nebo k ní nemáte přístup.' USING ERRCODE = '42501';
    END IF;
    IF v_job.cleanup_state IN ('done', 'abandoned') THEN
        RETURN; -- idempotent
    END IF;
    IF p_result = 'done' THEN
        UPDATE public.stt_jobs SET cleanup_state = 'done', cleaned_at = now(), cleanup_last_error = NULL, updated_at = now() WHERE id = p_job;
    ELSIF p_result = 'abandon' OR v_job.cleanup_attempts + 1 >= 8 THEN
        UPDATE public.stt_jobs SET cleanup_state = 'abandoned', cleanup_attempts = cleanup_attempts + 1, cleanup_last_error = v_err, updated_at = now() WHERE id = p_job;
    ELSE
        UPDATE public.stt_jobs
           SET cleanup_attempts = cleanup_attempts + 1, cleanup_last_error = v_err,
               cleanup_due_at = now() + make_interval(mins => least(power(2, cleanup_attempts + 1)::integer, 1440)), updated_at = now()
         WHERE id = p_job;
    END IF;
    IF v_job.meeting_id IS NOT NULL THEN
        UPDATE public.meetings SET stt_cleanup_pending = EXISTS (
            SELECT 1 FROM public.stt_jobs j WHERE j.meeting_id = v_job.meeting_id AND j.cleanup_state = 'pending')
         WHERE id = v_job.meeting_id;
    END IF;
END;
$$;

DO $$
DECLARE
    f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'record_audio_consent(uuid)', 'attach_meeting_audio(uuid,text,bigint,text,integer)', 'mark_audio_deleted(uuid)',
        'stt_reserve(text,uuid,integer,bigint,bigint)', 'stt_attach_job(text,uuid,text,text)', 'stt_mark_unknown(text,uuid,text)',
        'stt_resolve_unknown(text,uuid,text)', 'stt_fail(text,uuid,text,text,text,integer)',
        'stt_complete(text,uuid,text,text,integer,jsonb,integer)', 'stt_cleanup_result(text,uuid,text,text)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261118000700_meeting_audio')
ON CONFLICT (version) DO NOTHING;
