-- Rollback of RUN 10 migration 1800. Refuses while live data exists (a live transcript already stored as a revision stays: it is an
-- ordinary 'soniox' revision and is valid without this migration). Usage-ledger rows in ai_requests are never touched.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.meeting_live_segments WHERE state = 'open')
       OR EXISTS (SELECT 1 FROM public.meeting_live_chunks) THEN
        RAISE EXCEPTION 'Rollback 1800 refused: an unfinished live capture exists (finalize or discard it first).';
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.stt_live_discard(text, uuid);
DROP FUNCTION IF EXISTS public.stt_live_complete(text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.stt_live_chunks(text, uuid);
DROP FUNCTION IF EXISTS public.stt_live_close(text, uuid, integer, integer, text);
DROP FUNCTION IF EXISTS public.stt_live_append(text, uuid, integer, integer, jsonb);
DROP FUNCTION IF EXISTS public.stt_live_release(text, uuid, integer);
DROP FUNCTION IF EXISTS public.stt_live_reserve(text, uuid, integer, bigint, bigint);
DROP FUNCTION IF EXISTS public.meeting_is_organizer(public.meetings);
DROP FUNCTION IF EXISTS public.meeting_live_reap(uuid);
DROP FUNCTION IF EXISTS public.meeting_live_settle(uuid, integer, integer, text);
DROP TABLE IF EXISTS public.meeting_live_chunks;
DROP TABLE IF EXISTS public.meeting_live_segments;
DROP TABLE IF EXISTS public.meeting_attendees;
DROP FUNCTION IF EXISTS public.meeting_attendees_cap();
DROP TABLE IF EXISTS public.meeting_resource_links;
DROP FUNCTION IF EXISTS public.meeting_resource_links_guard();
REVOKE INSERT (ends_at, conference_url), UPDATE (ends_at, conference_url) ON public.meetings FROM authenticated;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_live_counters_check;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_live_state_check;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_ends_at_check;
ALTER TABLE public.meetings DROP CONSTRAINT IF EXISTS meetings_conference_url_check;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS live_segments;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS live_ms;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS live_state;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS conference_url;
ALTER TABLE public.meetings DROP COLUMN IF EXISTS ends_at;
DELETE FROM public.clearspace_migrations WHERE version = '20261202001800_meeting_intelligence_live';
