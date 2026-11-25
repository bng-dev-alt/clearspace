-- ============================================================
-- 20261128001400 -- Google Calendar events on projects and tasks (RUN 04)
--
-- Apply AFTER 20261127001300, in a transaction. Idempotent (re-running is a no-op).
-- Rollback: supabase/rollback/20261128001400_google_calendar.down.sql (refuses while it would lose data).
--
-- Privacy model (docs/run04/PRIVACY_AND_SECURITY.md):
--   * SHARED with project members (external_resource_links, RLS is_project_member): event title, start, end, all-day flag,
--     the event's time zone, recurring yes/no, attendee COUNT, organizer display name (or only the domain), state, who
--     linked it and when. Never description, location, attendee addresses, conference / Meet data, attachments, the
--     Google event link (htmlLink) nor any Google event or calendar id.
--   * PRIVATE to the person who linked it (calendar_link_sources, no client access at all): the event id, the recurring
--     series id and the Google account (sub). Only that person's server requests use it, with THEIR OWN token, while the
--     same Google account is connected with the Calendar permission.
--   * external_id of a Calendar link is an opaque server HMAC (dedupe per Google account + event); it reveals no id.
--   * Activity events of Calendar links carry no event title (ids only).
--   * Private / confidential events are refused by the server before this layer (never stored).
--
--   1. external_resource_links: provider 'google_calendar_event', event columns (CHECK: only on Calendar rows, required there).
--   2. calendar_link_sources (private) + server-secret RPCs: calendar_link_add / _source / _refresh, calendar_links_purge_mine;
--      google_service_remove / google_service_audit accept 'calendar' (every earlier value keeps working: RUN 03C code).
--   3. external_links_events: Calendar branch (event_linked / event_unlinked, without the title).
--
-- Data impact: additive only. Existing Drive and Gmail rows are unchanged and satisfy every new constraint.
-- Future Meeting Intelligence (not implemented): meetings refer to links by external_resource_links.id (provider neutral),
-- never by a Google id (docs/run04/MEETING_INTELLIGENCE_COMPAT.md).
-- ============================================================

DO $$
DECLARE
    v_missing TEXT := '';
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261127001300_gmail') THEN
        v_missing := v_missing || ' migration:20261127001300_gmail(apply it first)';
    END IF;
    IF to_regclass('public.gmail_link_sources') IS NULL THEN v_missing := v_missing || ' table:gmail_link_sources'; END IF;
    IF to_regprocedure('public.google_service_audit(text,text,text)') IS NULL THEN v_missing := v_missing || ' fn:google_service_audit'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- Google Calendar integration cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Shared link rows: Calendar provider + event columns
-- ------------------------------------------------------------
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_check
    CHECK (provider IN ('google_drive', 'gmail_message', 'gmail_thread', 'google_calendar_event'));
ALTER TABLE public.external_resource_links
    ADD COLUMN IF NOT EXISTS event_start TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS event_end TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS event_all_day BOOLEAN,
    ADD COLUMN IF NOT EXISTS event_time_zone TEXT CHECK (event_time_zone IS NULL OR (char_length(event_time_zone) BETWEEN 1 AND 64
        AND event_time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$')),
    ADD COLUMN IF NOT EXISTS event_recurring BOOLEAN,
    ADD COLUMN IF NOT EXISTS event_attendees INTEGER CHECK (event_attendees IS NULL OR event_attendees BETWEEN 0 AND 100000),
    ADD COLUMN IF NOT EXISTS event_organizer TEXT CHECK (event_organizer IS NULL OR (char_length(event_organizer) BETWEEN 1 AND 200 AND event_organizer !~ '[[:cntrl:]]'));
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_event_fields;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_event_fields CHECK (
    (provider = 'google_calendar_event' AND event_start IS NOT NULL AND event_end IS NOT NULL AND event_end >= event_start
        AND event_all_day IS NOT NULL AND event_recurring IS NOT NULL AND event_attendees IS NOT NULL
        AND provider_state IN ('ok', 'deleted'))
    OR (provider <> 'google_calendar_event' AND event_start IS NULL AND event_end IS NULL AND event_all_day IS NULL
        AND event_time_zone IS NULL AND event_recurring IS NULL AND event_attendees IS NULL AND event_organizer IS NULL));
-- (web_url stays NULL for every non-Drive provider: the 1300 CHECK already says so)

-- ------------------------------------------------------------
-- 2. Private source of a Calendar link (server only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calendar_link_sources (
    link_id UUID PRIMARY KEY REFERENCES public.external_resource_links(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    google_sub TEXT NOT NULL CHECK (google_sub ~ '^[A-Za-z0-9_-]{1,64}$'),
    -- MVP: only the owner's primary calendar (other calendars need calendar.calendarlist.readonly -- LATER)
    calendar_id TEXT NOT NULL DEFAULT 'primary' CHECK (calendar_id = 'primary'),
    -- Google event ids: base32hex, an instance adds _<date>[T<time>Z]; 5..1024 chars (Postgres regex repetition is capped at 255)
    event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 5 AND 1024 AND event_id ~ '^[A-Za-z0-9_]+$'),
    recurring_event_id TEXT CHECK (recurring_event_id IS NULL OR (char_length(recurring_event_id) BETWEEN 5 AND 1024 AND recurring_event_id ~ '^[A-Za-z0-9_]+$')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_link_sources_owner ON public.calendar_link_sources (owner_user_id);
ALTER TABLE public.calendar_link_sources ENABLE ROW LEVEL SECURITY;   -- no policy: invisible through the API
REVOKE ALL ON public.calendar_link_sources FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.calendar_link_sources TO service_role;

-- ------------------------------------------------------------
-- 3. Events: Calendar links are announced without their title
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.external_links_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.external_resource_links%ROWTYPE;
    v_kind TEXT;     -- 'drive' | 'mail' | 'event'
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    v_kind := CASE WHEN v_row.provider LIKE 'gmail_%' THEN 'mail' WHEN v_row.provider = 'google_calendar_event' THEN 'event' ELSE 'drive' END;
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.project_id,
            CASE v_kind WHEN 'mail' THEN 'email_linked' WHEN 'event' THEN 'event_linked' ELSE 'drive_file_linked' END,
            CASE WHEN NEW.card_id IS NULL THEN 'project' ELSE 'task' END, NEW.id::text, NEW.card_id,
            CASE v_kind
                WHEN 'mail' THEN jsonb_build_object('kind', CASE NEW.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', NEW.id,
                                                    'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id))
                WHEN 'event' THEN jsonb_build_object('link_id', NEW.id, 'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id))
                ELSE jsonb_build_object('name', NEW.name, 'mime', NEW.mime_type, 'link_id', NEW.id,
                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id)) END);
    ELSIF TG_OP = 'DELETE' THEN
        -- the task or project is being deleted with it: the deletion is the event, not N unlinks
        IF (OLD.card_id IS NULL OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id))
           AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
            PERFORM public.collab_emit(OLD.project_id,
                CASE v_kind WHEN 'mail' THEN 'email_unlinked' WHEN 'event' THEN 'event_unlinked' ELSE 'drive_file_unlinked' END,
                CASE WHEN OLD.card_id IS NULL THEN 'project' ELSE 'task' END, OLD.id::text, OLD.card_id,
                CASE v_kind
                    WHEN 'mail' THEN jsonb_build_object('kind', CASE OLD.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', OLD.id,
                                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id))
                    WHEN 'event' THEN jsonb_build_object('link_id', OLD.id, 'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id))
                    ELSE jsonb_build_object('name', OLD.name, 'link_id', OLD.id,
                                            'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id)) END);
        END IF;
    END IF;
    -- metadata refreshes (UPDATE) are routine: no event, only the signal (ids only, never names, subjects, titles or links)
    PERFORM public.collab_send(public.collab_project_topic(v_row.project_id), 'change',
        jsonb_build_object('t', 'links', 'op', lower(TG_OP), 'card', v_row.card_id));
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'links', 'op', 'delete', 'card', OLD.card_id));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_events() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Per-service helpers: accept 'calendar' (earlier values unchanged)
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
                       'https://www.googleapis.com/auth/calendar.events.owned.readonly') THEN
        RAISE EXCEPTION 'Neplatná služba.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.google_connections g SET scopes = array_remove(g.scopes, p_scope), updated_at = now()
    WHERE g.user_id = v_uid AND p_scope = ANY (g.scopes) AND cardinality(g.scopes) > 1;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail)
    VALUES (v_uid, 'google', 'service_removed',
            CASE WHEN p_scope LIKE '%gmail%' THEN 'gmail' WHEN p_scope LIKE '%calendar%' THEN 'calendar' ELSE 'drive' END);
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
    IF p_event NOT IN ('service_added', 'scope_denied') OR p_service NOT IN ('gmail', 'drive', 'calendar') THEN
        RAISE EXCEPTION 'Neplatná událost.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail) VALUES (public.google_require_user(), 'google', p_event, p_service);
END $$;

-- ------------------------------------------------------------
-- 5. Calendar RPCs (server secret + the caller's own session; never anonymous)
-- ------------------------------------------------------------
-- The caller's Google account (sub) when it currently holds the Calendar permission in ClearSpace, else NULL.
CREATE OR REPLACE FUNCTION public.calendar_caller_sub()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT g.google_sub FROM public.google_connections g
    WHERE g.user_id = auth.uid() AND g.status = 'active'
      AND 'https://www.googleapis.com/auth/calendar.events.owned.readonly' = ANY (g.scopes)
$$;
REVOKE ALL ON FUNCTION public.calendar_caller_sub() FROM PUBLIC, anon, authenticated;

-- Attach an event the caller selected in their own primary calendar. The server read it from Google with the caller's OWN
-- token; the database re-checks: Calendar permission present, same Google account, edit rights, rate limit, duplicates.
CREATE OR REPLACE FUNCTION public.calendar_link_add(
    p_server_secret TEXT, p_project_id TEXT, p_card_id TEXT, p_ref TEXT, p_google_sub TEXT,
    p_event_id TEXT, p_recurring_event_id TEXT, p_title TEXT, p_start TIMESTAMP WITH TIME ZONE, p_end TIMESTAMP WITH TIME ZONE,
    p_all_day BOOLEAN, p_time_zone TEXT, p_recurring BOOLEAN, p_attendees INTEGER, p_organizer TEXT,
    p_updated TIMESTAMP WITH TIME ZONE, p_state TEXT)
RETURNS TABLE (id UUID, duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_pid TEXT := p_project_id;
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF public.calendar_caller_sub() IS DISTINCT FROM p_google_sub THEN
        RAISE EXCEPTION 'Google Kalendář není ve vašem účtu Google připojený.' USING ERRCODE = '42501';
    END IF;
    IF p_card_id IS NOT NULL THEN
        SELECT c.project_id INTO v_pid FROM public.cards c WHERE c.id = p_card_id;
        IF v_pid IS NULL OR v_pid IS DISTINCT FROM p_project_id THEN
            RAISE EXCEPTION 'Úkol do tohoto projektu nepatří.' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF NOT public.can_edit_project(v_pid) THEN
        RAISE EXCEPTION 'K tomuto projektu nemáte oprávnění připojovat události.' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.external_resource_links l
        WHERE l.linked_by = v_uid AND l.created_at > now() - interval '10 minutes') >= 60 THEN
        RAISE EXCEPTION 'Příliš mnoho připojených položek. Zkuste to prosím za několik minut.' USING ERRCODE = 'PT429';
    END IF;
    SELECT l.id INTO v_id FROM public.external_resource_links l
    WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '') AND l.provider = 'google_calendar_event' AND l.external_id = p_ref;
    IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, true; RETURN; END IF;
    INSERT INTO public.external_resource_links AS l
        (project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, modified_at, provider_state,
         metadata_checked_at, linked_by, linked_by_name, event_start, event_end, event_all_day, event_time_zone,
         event_recurring, event_attendees, event_organizer)
    VALUES (v_pid, p_card_id, 'google_calendar_event', p_ref, p_title, 'text/calendar', NULL, NULL, p_updated, coalesce(p_state, 'ok'),
            now(), v_uid, left(public.collab_actor_name(v_pid, v_uid), 200), p_start, p_end, p_all_day, p_time_zone,
            p_recurring, p_attendees, p_organizer)
    ON CONFLICT DO NOTHING
    RETURNING l.id INTO v_id;
    IF v_id IS NULL THEN -- lost a race with an identical attach
        SELECT l.id INTO v_id FROM public.external_resource_links l
        WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '') AND l.provider = 'google_calendar_event' AND l.external_id = p_ref;
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;
    INSERT INTO public.calendar_link_sources (link_id, owner_user_id, google_sub, event_id, recurring_event_id)
    VALUES (v_id, v_uid, p_google_sub, p_event_id, p_recurring_event_id);
    RETURN QUERY SELECT v_id, false;
END $$;

-- The private source of ONE link, for its owner only, and only while the link is visible to them (still a member).
-- same_account = the owner's currently connected Google account (with Calendar) is the one the link came from.
CREATE OR REPLACE FUNCTION public.calendar_link_source(p_server_secret TEXT, p_link_id UUID)
RETURNS TABLE (event_id TEXT, same_account BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    RETURN QUERY
    SELECT s.event_id, (s.google_sub = public.calendar_caller_sub()) IS TRUE
    FROM public.calendar_link_sources s JOIN public.external_resource_links l ON l.id = s.link_id
    WHERE s.link_id = p_link_id AND s.owner_user_id = auth.uid() AND public.is_project_member(l.project_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Událost může otevřít jen ten, kdo ji připojil, ze svého Google Kalendáře.' USING ERRCODE = '42501';
    END IF;
END $$;

-- Metadata refresh by the owner (their own token read it from Google): title, times, flags, counts, state.
CREATE OR REPLACE FUNCTION public.calendar_link_refresh(
    p_server_secret TEXT, p_link_id UUID, p_title TEXT, p_start TIMESTAMP WITH TIME ZONE, p_end TIMESTAMP WITH TIME ZONE,
    p_all_day BOOLEAN, p_time_zone TEXT, p_recurring BOOLEAN, p_attendees INTEGER, p_organizer TEXT,
    p_updated TIMESTAMP WITH TIME ZONE, p_state TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    IF NOT EXISTS (SELECT 1 FROM public.calendar_link_sources s JOIN public.external_resource_links l ON l.id = s.link_id
                   WHERE s.link_id = p_link_id AND s.owner_user_id = auth.uid() AND s.google_sub = public.calendar_caller_sub()
                     AND public.can_edit_project(l.project_id)) THEN
        RAISE EXCEPTION 'Informace o události může obnovit jen ten, kdo ji připojil.' USING ERRCODE = '42501';
    END IF;
    IF p_state IS NOT NULL AND p_state NOT IN ('ok', 'deleted') THEN RAISE EXCEPTION 'Neplatný stav.' USING ERRCODE = '22023'; END IF;
    UPDATE public.external_resource_links l
       SET name = coalesce(p_title, l.name), event_start = coalesce(p_start, l.event_start), event_end = coalesce(p_end, l.event_end),
           event_all_day = coalesce(p_all_day, l.event_all_day),
           event_time_zone = CASE WHEN p_start IS NULL THEN l.event_time_zone ELSE p_time_zone END,
           event_recurring = coalesce(p_recurring, l.event_recurring), event_attendees = coalesce(p_attendees, l.event_attendees),
           event_organizer = CASE WHEN p_title IS NULL THEN l.event_organizer ELSE p_organizer END,
           modified_at = coalesce(p_updated, l.modified_at), provider_state = coalesce(p_state, l.provider_state), metadata_checked_at = now()
     WHERE l.id = p_link_id
       AND (l.name, l.event_start, l.event_end, l.event_all_day, l.event_time_zone, l.event_recurring, l.event_attendees,
            l.event_organizer, l.modified_at, l.provider_state)
           IS DISTINCT FROM (coalesce(p_title, l.name), coalesce(p_start, l.event_start), coalesce(p_end, l.event_end),
                             coalesce(p_all_day, l.event_all_day), CASE WHEN p_start IS NULL THEN l.event_time_zone ELSE p_time_zone END,
                             coalesce(p_recurring, l.event_recurring), coalesce(p_attendees, l.event_attendees),
                             CASE WHEN p_title IS NULL THEN l.event_organizer ELSE p_organizer END,
                             coalesce(p_updated, l.modified_at), coalesce(p_state, l.provider_state));
    IF NOT FOUND THEN
        UPDATE public.external_resource_links l SET metadata_checked_at = now()
        WHERE l.id = p_link_id AND l.metadata_checked_at < now() - interval '1 minute';
        RETURN false;
    END IF;
    RETURN true;
END $$;

-- Data deletion on the user's request: remove every Calendar link THIS user created (in every project, also after they left
-- it). Where they are now a read-only Čtenář the viewer guard keeps the row; those are counted as skipped.
CREATE OR REPLACE FUNCTION public.calendar_links_purge_mine(p_server_secret TEXT)
RETURNS TABLE (removed INTEGER, skipped INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_link UUID;
    v_removed INTEGER := 0;
    v_skipped INTEGER := 0;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    FOR v_link IN SELECT s.link_id FROM public.calendar_link_sources s WHERE s.owner_user_id = v_uid LOOP
        BEGIN
            DELETE FROM public.external_resource_links l WHERE l.id = v_link;
            v_removed := v_removed + 1;
        EXCEPTION WHEN insufficient_privilege THEN
            v_skipped := v_skipped + 1;
        END;
    END LOOP;
    RETURN QUERY SELECT v_removed, v_skipped;
END $$;

REVOKE ALL ON FUNCTION public.google_service_remove(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_service_audit(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_link_source(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_link_refresh(TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_links_purge_mine(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.google_service_remove(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_service_audit(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_link_source(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_link_refresh(TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_links_purge_mine(TEXT) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261128001400_google_calendar')
ON CONFLICT (version) DO NOTHING;
