-- RUN 10 – Meeting Intelligence: scheduled / ad-hoc meetings, attendees, Calendar resource links and LIVE transcription
-- (browser -> Soniox real-time with a server-minted single-use temporary key). Additive and idempotent; nothing existing changes
-- meaning. Design + rationale: docs/run10/ARCHITECTURE.md, DECISIONS.md.
--
-- Money model (same ledger as the async path, `ai_requests` feature 'meeting-transcribe'):
--  * a live SEGMENT (one provider stream) is booked BEFORE the key is minted (stt_live_reserve) with the reserved duration;
--    the key's max_session_duration_seconds equals that reservation, so the provider itself caps the cost of a segment;
--  * closing a segment settles it with min(reserved, reported, wall time since reserve + 15 s); a segment nobody closes keeps
--    its full reservation (fail-safe) and is reaped as 'abandoned'.
-- Data model: final tokens arrive progressively (stt_live_append) into meeting_live_chunks; stt_live_complete stores ONE
-- immutable transcript revision (source 'soniox', machine provenance) and deletes the chunks (minimisation). No audio is stored.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261201001700_hub_hardening') THEN
        RAISE EXCEPTION 'Migration 1800 needs 1700 (hub hardening) first.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. meetings: schedule + conferencing link + live state
-- ------------------------------------------------------------
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS ends_at TIMESTAMP WITH TIME ZONE;
-- A link the organizer opens to JOIN (Google Meet from the Calendar API response, or a Zoom/Teams/other https link typed by a
-- person). Shown to project members only (RLS of meetings). Never synthesized by ClearSpace.
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS conference_url TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS live_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS live_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS live_segments INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_conference_url_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_conference_url_check
            CHECK (conference_url IS NULL OR (char_length(conference_url) <= 500 AND conference_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]<>"]*)?$'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_ends_at_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_ends_at_check CHECK (ends_at IS NULL OR ends_at >= occurred_at);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_live_state_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_live_state_check
            CHECK (live_state IN ('idle', 'live', 'paused', 'stopped', 'finalized'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meetings_live_counters_check') THEN
        ALTER TABLE public.meetings ADD CONSTRAINT meetings_live_counters_check CHECK (live_ms >= 0 AND live_segments >= 0);
    END IF;
END $$;
-- live_* columns are written only by the stt_live_* RPCs (no column grant). Schedule + link are member-editable like the title.
GRANT INSERT (ends_at, conference_url) ON public.meetings TO authenticated;
GRANT UPDATE (ends_at, conference_url) ON public.meetings TO authenticated;

-- ------------------------------------------------------------
-- 2. meeting_resource_links: provider-neutral meeting <-> external_resource_links (RUN 04 compat proposal)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_resource_links (
    meeting_id UUID NOT NULL,
    link_id UUID NOT NULL REFERENCES public.external_resource_links(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, link_id),
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meeting_resource_links_link ON public.meeting_resource_links (link_id);

-- Only project-level links of the SAME project (a task link follows its card and could change project).
CREATE OR REPLACE FUNCTION public.meeting_resource_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.external_resource_links l
                   WHERE l.id = NEW.link_id AND l.project_id = NEW.project_id AND l.card_id IS NULL) THEN
        RAISE EXCEPTION 'Odkaz nepatří k projektu porady.' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.meeting_resource_links_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meeting_resource_links_guard ON public.meeting_resource_links;
CREATE TRIGGER meeting_resource_links_guard BEFORE INSERT OR UPDATE ON public.meeting_resource_links
    FOR EACH ROW EXECUTE FUNCTION public.meeting_resource_links_guard();

ALTER TABLE public.meeting_resource_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meeting_resource_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.meeting_resource_links TO authenticated;
GRANT INSERT (meeting_id, link_id, project_id) ON public.meeting_resource_links TO authenticated;
GRANT ALL ON public.meeting_resource_links TO service_role;
DROP POLICY IF EXISTS "meeting_links_select" ON public.meeting_resource_links;
CREATE POLICY "meeting_links_select" ON public.meeting_resource_links FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "meeting_links_insert" ON public.meeting_resource_links;
CREATE POLICY "meeting_links_insert" ON public.meeting_resource_links FOR INSERT TO authenticated
    WITH CHECK (public.can_edit_project(project_id) AND created_by = auth.uid());
DROP POLICY IF EXISTS "meeting_links_delete" ON public.meeting_resource_links;
CREATE POLICY "meeting_links_delete" ON public.meeting_resource_links FOR DELETE TO authenticated
    USING (public.can_edit_project(project_id));

-- ------------------------------------------------------------
-- 3. meeting_attendees: invited people (internal members or external guests; guests never get an account)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_attendees (
    meeting_id UUID NOT NULL,
    project_id TEXT NOT NULL,
    email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)
                               AND email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
    display_name TEXT CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[[:cntrl:]]')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, email),
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION public.meeting_attendees_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF (SELECT count(*) FROM public.meeting_attendees a WHERE a.meeting_id = NEW.meeting_id) >= 50 THEN
        RAISE EXCEPTION 'Porada může mít nejvýše 50 pozvaných.' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.meeting_attendees_cap() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meeting_attendees_cap ON public.meeting_attendees;
CREATE TRIGGER meeting_attendees_cap BEFORE INSERT ON public.meeting_attendees
    FOR EACH ROW EXECUTE FUNCTION public.meeting_attendees_cap();
ALTER TABLE public.meeting_attendees ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meeting_attendees FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.meeting_attendees TO authenticated;
GRANT INSERT (meeting_id, project_id, email, display_name) ON public.meeting_attendees TO authenticated;
GRANT ALL ON public.meeting_attendees TO service_role;
DROP POLICY IF EXISTS "meeting_attendees_select" ON public.meeting_attendees;
CREATE POLICY "meeting_attendees_select" ON public.meeting_attendees FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "meeting_attendees_write" ON public.meeting_attendees;
CREATE POLICY "meeting_attendees_write" ON public.meeting_attendees FOR INSERT TO authenticated
    WITH CHECK (public.can_edit_project(project_id));
DROP POLICY IF EXISTS "meeting_attendees_delete" ON public.meeting_attendees;
CREATE POLICY "meeting_attendees_delete" ON public.meeting_attendees FOR DELETE TO authenticated
    USING (public.can_edit_project(project_id));

-- ------------------------------------------------------------
-- 4. Live segments + chunks (server-only writes; members read their meeting's chunks for recovery display)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meeting_live_segments (
    meeting_id UUID NOT NULL,
    project_id TEXT NOT NULL,
    segment INTEGER NOT NULL CHECK (segment BETWEEN 1 AND 200),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    request_id UUID REFERENCES public.ai_requests(id) ON DELETE SET NULL,
    reserved_ms INTEGER NOT NULL CHECK (reserved_ms BETWEEN 1 AND 18000000),
    offset_ms BIGINT NOT NULL CHECK (offset_ms >= 0),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed', 'abandoned')),
    close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('paused', 'stopped', 'error', 'abandoned')),
    audio_ms INTEGER CHECK (audio_ms IS NULL OR audio_ms >= 0),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ended_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (meeting_id, segment),
    FOREIGN KEY (meeting_id, project_id) REFERENCES public.meetings (id, project_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_live_one_open ON public.meeting_live_segments (meeting_id) WHERE state = 'open';
CREATE TABLE IF NOT EXISTS public.meeting_live_chunks (
    meeting_id UUID NOT NULL,
    project_id TEXT NOT NULL,
    segment INTEGER NOT NULL,
    seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 100000),
    tokens JSONB NOT NULL CHECK (jsonb_typeof(tokens) = 'array' AND jsonb_array_length(tokens) BETWEEN 1 AND 2000),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (meeting_id, segment, seq),
    FOREIGN KEY (meeting_id, segment) REFERENCES public.meeting_live_segments (meeting_id, segment) ON DELETE CASCADE
);
ALTER TABLE public.meeting_live_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_live_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meeting_live_segments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.meeting_live_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT (meeting_id, project_id, segment, reserved_ms, offset_ms, state, close_reason, audio_ms, started_at, ended_at)
    ON public.meeting_live_segments TO authenticated;
GRANT SELECT ON public.meeting_live_chunks TO authenticated;
GRANT ALL ON public.meeting_live_segments TO service_role;
GRANT ALL ON public.meeting_live_chunks TO service_role;
DROP POLICY IF EXISTS "live_segments_select" ON public.meeting_live_segments;
CREATE POLICY "live_segments_select" ON public.meeting_live_segments FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "live_chunks_select" ON public.meeting_live_chunks;
CREATE POLICY "live_chunks_select" ON public.meeting_live_chunks FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));

-- ------------------------------------------------------------
-- 5. Trusted RPCs (server secret 'stt' FIRST, like every stt_* function)
-- ------------------------------------------------------------
-- Settle one segment (internal). Charged duration = min(reserved, reported, wall time + 15 s); unknown report -> reserved.
CREATE OR REPLACE FUNCTION public.meeting_live_settle(p_meeting UUID, p_segment INTEGER, p_audio_ms INTEGER, p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    s public.meeting_live_segments%ROWTYPE;
    v_ms INTEGER;
    v_cost NUMERIC(10, 4);
BEGIN
    SELECT * INTO s FROM public.meeting_live_segments WHERE meeting_id = p_meeting AND segment = p_segment FOR UPDATE;
    IF NOT FOUND OR s.state <> 'open' THEN RETURN coalesce(s.audio_ms, 0); END IF;
    v_ms := CASE WHEN p_audio_ms IS NULL THEN s.reserved_ms
                 ELSE least(s.reserved_ms, greatest(0, p_audio_ms),
                            (extract(epoch FROM (now() - s.started_at)) * 1000)::integer + 15000) END;
    v_cost := round(v_ms::numeric / 3600000.0 * 0.12, 4); -- real-time list price US$0.12 per audio hour (verified 2026-11-28)
    UPDATE public.meeting_live_segments
       SET state = CASE WHEN p_reason = 'abandoned' THEN 'abandoned' ELSE 'closed' END, close_reason = p_reason,
           audio_ms = v_ms, ended_at = now()
     WHERE meeting_id = p_meeting AND segment = p_segment;
    UPDATE public.ai_requests
       SET status = 'succeeded', audio_ms = v_ms, cost_usd = v_cost, completed_at = now(),
           billing_state = 'estimated', model = coalesce(model, 'stt-rt')
     WHERE id = s.request_id AND status = 'reserved';
    UPDATE public.meetings SET live_ms = live_ms + v_ms,
           live_state = CASE WHEN live_state = 'live' THEN (CASE WHEN p_reason = 'paused' THEN 'paused' ELSE 'stopped' END) ELSE live_state END
     WHERE id = p_meeting;
    RETURN v_ms;
END $$;
REVOKE ALL ON FUNCTION public.meeting_live_settle(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

-- An open segment past its reservation (+ 2 min grace) can no longer stream (the provider dropped it): settle at the full
-- reservation (we cannot know less) and mark abandoned. Called by the other RPCs; never needs a scheduler.
CREATE OR REPLACE FUNCTION public.meeting_live_reap(p_meeting UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r record;
BEGIN
    FOR r IN SELECT segment FROM public.meeting_live_segments
              WHERE meeting_id = p_meeting AND state = 'open'
                AND started_at + make_interval(secs => reserved_ms / 1000.0 + 120) < now() LOOP
        PERFORM public.meeting_live_settle(p_meeting, r.segment, NULL, 'abandoned');
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.meeting_live_reap(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.meeting_is_organizer(p_m public.meetings)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT p_m.created_by = auth.uid() OR public.is_project_owner(p_m.project_id) $$;
REVOKE ALL ON FUNCTION public.meeting_is_organizer(public.meetings) FROM PUBLIC, anon, authenticated;

-- Book one live segment BEFORE the provider key exists. Outcomes: started | no_consent | not_organizer | finalized |
-- already_live | limit | budget_exceeded | global_budget_exceeded.
CREATE OR REPLACE FUNCTION public.stt_live_reserve(
    p_server_secret TEXT, p_meeting UUID, p_reserve_ms INTEGER, p_user_daily_ms BIGINT, p_global_daily_ms BIGINT)
RETURNS TABLE (outcome TEXT, segment INTEGER, offset_ms BIGINT, reserved_ms INTEGER, request_id UUID, project_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_m public.meetings%ROWTYPE;
    v_lim JSONB := public.intelligence_limits();
    v_max BIGINT := (v_lim ->> 'max_audio_ms')::bigint;
    v_used_user BIGINT;
    v_used_global BIGINT;
    v_ms INTEGER;
    v_id UUID;
    v_seg INTEGER;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF p_reserve_ms IS NULL OR p_reserve_ms NOT BETWEEN 60000 AND 7200000
       OR p_user_daily_ms IS NULL OR p_user_daily_ms < 1 OR p_global_daily_ms IS NULL OR p_global_daily_ms < 1 THEN
        RAISE EXCEPTION 'Neplatné parametry rezervace přepisu.' USING ERRCODE = '22023';
    END IF;
    IF v_m.source_kind <> 'audio' THEN
        RAISE EXCEPTION 'Živý přepis lze spustit jen u porady se zvukem.' USING ERRCODE = '22023';
    END IF;
    PERFORM public.meeting_live_reap(p_meeting);
    SELECT * INTO v_m FROM public.meetings WHERE id = p_meeting;
    IF NOT public.meeting_is_organizer(v_m) THEN
        RETURN QUERY SELECT 'not_organizer'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;
    IF v_m.consent_at IS NULL THEN
        RETURN QUERY SELECT 'no_consent'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;
    IF v_m.live_state = 'finalized' OR v_m.stt_state IN ('completed', 'submitting', 'transcribing', 'unknown') OR v_m.current_revision IS NOT NULL THEN
        RETURN QUERY SELECT 'finalized'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.meeting_live_segments s WHERE s.meeting_id = p_meeting AND s.state = 'open') THEN
        RETURN QUERY SELECT 'already_live'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;
    v_ms := least(p_reserve_ms, v_max - v_m.live_ms)::integer;
    IF v_m.live_segments >= 40 OR v_ms < 60000 THEN
        RETURN QUERY SELECT 'limit'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;

    -- same locks and the same 24 h window as stt_reserve: async and live share ONE audio budget
    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:user:' || v_uid::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('stt_reserve:global', 0));
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_user FROM public.ai_requests r
     WHERE r.user_id = v_uid AND r.feature = 'meeting-transcribe' AND r.billing_state <> 'not_billed' AND r.created_at > now() - interval '24 hours';
    v_ms := least(v_ms, p_user_daily_ms - v_used_user);
    IF v_ms < 60000 THEN
        RETURN QUERY SELECT 'budget_exceeded'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;
    SELECT coalesce(sum(r.audio_ms), 0) INTO v_used_global FROM public.ai_requests r
     WHERE r.feature = 'meeting-transcribe' AND r.billing_state <> 'not_billed' AND r.created_at > now() - interval '24 hours';
    v_ms := least(v_ms, p_global_daily_ms - v_used_global);
    IF v_ms < 60000 THEN
        RETURN QUERY SELECT 'global_budget_exceeded'::TEXT, NULL::INTEGER, NULL::BIGINT, NULL::INTEGER, NULL::UUID, v_m.project_id; RETURN;
    END IF;

    INSERT INTO public.ai_requests (user_id, project_id, feature, status, reserved_tokens, provider, audio_ms, billing_state)
    VALUES (v_uid, v_m.project_id, 'meeting-transcribe', 'reserved', 0, 'soniox', v_ms, 'reserved')
    RETURNING public.ai_requests.id INTO v_id;
    v_seg := v_m.live_segments + 1;
    INSERT INTO public.meeting_live_segments (meeting_id, project_id, segment, user_id, request_id, reserved_ms, offset_ms)
    VALUES (p_meeting, v_m.project_id, v_seg, v_uid, v_id, v_ms, v_m.live_ms);
    UPDATE public.meetings SET live_segments = v_seg, live_state = 'live' WHERE id = p_meeting;
    RETURN QUERY SELECT 'started'::TEXT, v_seg, v_m.live_ms, v_ms, v_id, v_m.project_id;
END $$;

-- The key could not be minted (provider refused BEFORE any stream existed): release the booking completely.
CREATE OR REPLACE FUNCTION public.stt_live_release(p_server_secret TEXT, p_meeting UUID, p_segment INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s public.meeting_live_segments%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    PERFORM public.lock_meeting_for_member(p_meeting);
    SELECT * INTO s FROM public.meeting_live_segments WHERE meeting_id = p_meeting AND segment = p_segment AND state = 'open' FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.ai_requests SET status = 'failed', error_code = 'not_created', completed_at = now(), audio_ms = 0, cost_usd = 0,
           billing_state = 'not_billed' WHERE id = s.request_id AND status = 'reserved';
    DELETE FROM public.meeting_live_segments WHERE meeting_id = p_meeting AND segment = p_segment;
    UPDATE public.meetings SET live_segments = live_segments - 1,
           live_state = CASE WHEN live_ms > 0 THEN 'paused' ELSE 'idle' END
     WHERE id = p_meeting AND live_segments = p_segment;
END $$;

-- Final tokens of one segment, idempotent per (segment, seq). Late flushes after close are accepted until finalization.
CREATE OR REPLACE FUNCTION public.stt_live_append(p_server_secret TEXT, p_meeting UUID, p_segment INTEGER, p_seq INTEGER, p_tokens JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF v_m.live_state = 'finalized' THEN RETURN 'finalized'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.meeting_live_segments s WHERE s.meeting_id = p_meeting AND s.segment = p_segment AND s.user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Část přepisu neexistuje.' USING ERRCODE = '22023';
    END IF;
    IF p_tokens IS NULL OR jsonb_typeof(p_tokens) <> 'array' OR octet_length(p_tokens::text) > 262144 THEN
        RAISE EXCEPTION 'Neplatná část přepisu.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.meeting_live_chunks c WHERE c.meeting_id = p_meeting) >= 20000 THEN
        RAISE EXCEPTION 'Přepis porady je příliš dlouhý.' USING ERRCODE = '54000';
    END IF;
    INSERT INTO public.meeting_live_chunks (meeting_id, project_id, segment, seq, tokens)
    VALUES (p_meeting, v_m.project_id, p_segment, p_seq, p_tokens)
    ON CONFLICT (meeting_id, segment, seq) DO NOTHING;
    RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION public.stt_live_close(p_server_secret TEXT, p_meeting UUID, p_segment INTEGER, p_audio_ms INTEGER, p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    PERFORM public.lock_meeting_for_member(p_meeting);
    IF p_reason IS NULL OR p_reason NOT IN ('paused', 'stopped', 'error') THEN
        RAISE EXCEPTION 'Neplatný důvod ukončení.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.meeting_live_segments s WHERE s.meeting_id = p_meeting AND s.segment = p_segment AND s.user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Část přepisu neexistuje.' USING ERRCODE = '22023';
    END IF;
    RETURN public.meeting_live_settle(p_meeting, p_segment, p_audio_ms, p_reason);
END $$;

-- All chunks of the meeting, in order, with the segment offset (the server normalises them into one transcript).
CREATE OR REPLACE FUNCTION public.stt_live_chunks(p_server_secret TEXT, p_meeting UUID)
RETURNS TABLE (segment INTEGER, seq INTEGER, offset_ms BIGINT, tokens JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    PERFORM public.lock_meeting_for_member(p_meeting);
    RETURN QUERY SELECT c.segment, c.seq, s.offset_ms, c.tokens
      FROM public.meeting_live_chunks c JOIN public.meeting_live_segments s ON s.meeting_id = c.meeting_id AND s.segment = c.segment
     WHERE c.meeting_id = p_meeting ORDER BY c.segment, c.seq;
END $$;

-- Store the normalised live transcript as ONE immutable revision (machine provenance), close any open segment, drop chunks.
CREATE OR REPLACE FUNCTION public.stt_live_complete(p_server_secret TEXT, p_meeting UUID, p_model TEXT, p_transcript JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_m public.meetings%ROWTYPE;
    v_rev TEXT := p_transcript ->> 'revision';
    r record;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF v_m.live_state = 'finalized' THEN RETURN v_m.current_revision; END IF; -- idempotent
    IF NOT public.meeting_is_organizer(v_m) THEN
        RAISE EXCEPTION 'Přepis může dokončit jen organizátor porady.' USING ERRCODE = '42501';
    END IF;
    IF v_m.live_segments = 0 OR v_m.current_revision IS NOT NULL THEN
        RAISE EXCEPTION 'Živý přepis neběžel.' USING ERRCODE = '55000';
    END IF;
    IF v_rev IS NULL OR v_rev !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_transcript -> 'segments') IS DISTINCT FROM 'array'
       OR p_model IS NULL OR p_model !~ '^[a-z0-9._-]{1,32}$' THEN
        RAISE EXCEPTION 'Neplatný přepis.' USING ERRCODE = '22023';
    END IF;
    FOR r IN SELECT segment FROM public.meeting_live_segments WHERE meeting_id = p_meeting AND state = 'open' LOOP
        PERFORM public.meeting_live_settle(p_meeting, r.segment, NULL, 'stopped'); -- unknown duration -> full reservation
    END LOOP;
    SELECT * INTO v_m FROM public.meetings WHERE id = p_meeting;

    INSERT INTO public.machine_persist_tokens (txid) VALUES (txid_current()) ON CONFLICT (txid) DO NOTHING;
    INSERT INTO public.meeting_transcripts (meeting_id, project_id, revision, source, speakers, segments, coverage, char_count, created_by)
    VALUES (p_meeting, v_m.project_id, v_rev, 'soniox',
            coalesce(p_transcript -> 'speakers', '[]'::jsonb), p_transcript -> 'segments', coalesce(p_transcript -> 'coverage', '{}'::jsonb),
            (p_transcript ->> 'char_count')::integer, auth.uid())
    ON CONFLICT (meeting_id, revision) DO NOTHING;
    DELETE FROM public.machine_persist_tokens WHERE txid = txid_current();

    UPDATE public.meetings
       SET stt_state = 'completed', stt_model = p_model, stt_audio_ms = least(live_ms, 2147483647)::integer,
           stt_cost_usd = (SELECT coalesce(sum(a.cost_usd), 0) FROM public.ai_requests a
                            JOIN public.meeting_live_segments s ON s.request_id = a.id WHERE s.meeting_id = p_meeting),
           stt_error_type = NULL, current_revision = v_rev, status = 'transcribed', live_state = 'finalized'
     WHERE id = p_meeting;
    DELETE FROM public.meeting_live_chunks WHERE meeting_id = p_meeting;
    RETURN v_rev;
END $$;

-- Discard a live capture that produced nothing worth keeping (organizer only): chunks go, bookings stay (money is never erased).
CREATE OR REPLACE FUNCTION public.stt_live_discard(p_server_secret TEXT, p_meeting UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_m public.meetings%ROWTYPE; r record;
BEGIN
    PERFORM public.require_server_secret('stt', p_server_secret);
    v_m := public.lock_meeting_for_member(p_meeting);
    IF NOT public.meeting_is_organizer(v_m) THEN
        RAISE EXCEPTION 'Jen organizátor porady.' USING ERRCODE = '42501';
    END IF;
    FOR r IN SELECT segment FROM public.meeting_live_segments WHERE meeting_id = p_meeting AND state = 'open' LOOP
        PERFORM public.meeting_live_settle(p_meeting, r.segment, NULL, 'stopped');
    END LOOP;
    DELETE FROM public.meeting_live_chunks WHERE meeting_id = p_meeting;
    UPDATE public.meetings SET live_state = 'stopped' WHERE id = p_meeting AND live_state <> 'finalized';
END $$;

DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.stt_live_reserve(text,uuid,integer,bigint,bigint)', 'public.stt_live_release(text,uuid,integer)',
        'public.stt_live_append(text,uuid,integer,integer,jsonb)', 'public.stt_live_close(text,uuid,integer,integer,text)',
        'public.stt_live_chunks(text,uuid)', 'public.stt_live_complete(text,uuid,text,jsonb)', 'public.stt_live_discard(text,uuid)'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f); -- useless without the server secret
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5b. Google 'meetings' service (calendar.events.owned, RUN 10): the user can turn it off like Gmail / Calendar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.google_service_remove(p_server_secret TEXT, p_scope TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF p_scope NOT IN ('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.file',
                       'https://www.googleapis.com/auth/calendar.events.owned.readonly',
                       'https://www.googleapis.com/auth/calendar.events.owned') THEN
        RAISE EXCEPTION 'Neplatná služba.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.google_connections g SET scopes = array_remove(g.scopes, p_scope), updated_at = now()
    WHERE g.user_id = v_uid AND p_scope = ANY (g.scopes) AND cardinality(g.scopes) > 1;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail)
    VALUES (v_uid, 'google', 'service_removed',
            CASE WHEN p_scope LIKE '%gmail%' THEN 'gmail' WHEN p_scope LIKE '%calendar.events.owned' THEN 'meetings' WHEN p_scope LIKE '%calendar%' THEN 'calendar' ELSE 'drive' END);
    RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.google_service_audit(p_server_secret TEXT, p_event TEXT, p_service TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    IF p_event NOT IN ('service_added', 'scope_denied') OR p_service NOT IN ('gmail', 'drive', 'calendar', 'meetings') THEN
        RAISE EXCEPTION 'Neplatná událost.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail) VALUES (public.google_require_user(), 'google', p_event, p_service);
END $$;


-- ------------------------------------------------------------
-- 6. Marker
-- ------------------------------------------------------------
INSERT INTO public.clearspace_migrations (version) VALUES ('20261202001800_meeting_intelligence_live') ON CONFLICT (version) DO NOTHING;
COMMENT ON TABLE public.meeting_live_segments IS 'RUN 10 (migration 1800): one Soniox real-time stream of a live meeting; booked before the key is minted.';
