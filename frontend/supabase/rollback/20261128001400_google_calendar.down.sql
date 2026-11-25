-- ============================================================
-- Rollback of 20261128001400_google_calendar -> the 20261127001300 catalog.
--
-- REFUSES (changes nothing) while it would destroy data, unless the operator sets
--   SET clearspace.rollback_allow_data_loss = 'on';   (in the same session, before running this file)
--   * Calendar links exist (external_resource_links provider google_calendar_event),
--   * per-service audit rows for 'calendar' exist (service_added / service_removed / scope_denied with detail 'calendar').
-- Google connections that hold the Calendar permission are NOT changed: the grant stays at Google. Disable the feature first
-- (CALENDAR_INTEGRATION_ENABLED unset / 0), then let users turn Calendar off or disconnect; see docs/run04/PRODUCTION_ROLLOUT.md.
-- Activity events already written (event_linked / event_unlinked) stay; the timeline shows them neutrally.
-- Run as one transaction: psql --single-transaction -f 20261128001400_google_calendar.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        SELECT count(*) INTO v_n FROM public.external_resource_links WHERE provider = 'google_calendar_event';
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % Calendar links would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
        SELECT count(*) INTO v_n FROM public.integration_audit WHERE detail = 'calendar';
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % Calendar audit rows would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
    END IF;
END $$;

DELETE FROM public.external_resource_links WHERE provider = 'google_calendar_event';   -- only reached when allowed (or none exist)
DELETE FROM public.integration_audit WHERE detail = 'calendar';

DROP FUNCTION IF EXISTS public.calendar_links_purge_mine(TEXT);
DROP FUNCTION IF EXISTS public.calendar_link_refresh(TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT);
DROP FUNCTION IF EXISTS public.calendar_link_source(TEXT, UUID);
DROP FUNCTION IF EXISTS public.calendar_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, BOOLEAN, TEXT, BOOLEAN, INTEGER, TEXT, TIMESTAMP WITH TIME ZONE, TEXT);
DROP FUNCTION IF EXISTS public.calendar_caller_sub();
DROP TABLE IF EXISTS public.calendar_link_sources;

ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_event_fields;
ALTER TABLE public.external_resource_links DROP COLUMN IF EXISTS event_organizer, DROP COLUMN IF EXISTS event_attendees,
    DROP COLUMN IF EXISTS event_recurring, DROP COLUMN IF EXISTS event_time_zone, DROP COLUMN IF EXISTS event_all_day,
    DROP COLUMN IF EXISTS event_end, DROP COLUMN IF EXISTS event_start;
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_check
    CHECK (provider IN ('google_drive', 'gmail_message', 'gmail_thread'));

-- the 20261127001300 definitions, verbatim
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
    IF p_scope NOT IN ('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.file') THEN
        RAISE EXCEPTION 'Neplatná služba.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.google_connections g SET scopes = array_remove(g.scopes, p_scope), updated_at = now()
    WHERE g.user_id = v_uid AND p_scope = ANY (g.scopes) AND cardinality(g.scopes) > 1;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail)
    VALUES (v_uid, 'google', 'service_removed', CASE WHEN p_scope LIKE '%gmail%' THEN 'gmail' ELSE 'drive' END);
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
    IF p_event NOT IN ('service_added', 'scope_denied') OR p_service NOT IN ('gmail', 'drive') THEN
        RAISE EXCEPTION 'Neplatná událost.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail) VALUES (public.google_require_user(), 'google', p_event, p_service);
END $$;

CREATE OR REPLACE FUNCTION public.external_links_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.external_resource_links%ROWTYPE;
    v_mail BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    v_mail := v_row.provider LIKE 'gmail_%';
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.project_id, CASE WHEN v_mail THEN 'email_linked' ELSE 'drive_file_linked' END,
            CASE WHEN NEW.card_id IS NULL THEN 'project' ELSE 'task' END, NEW.id::text, NEW.card_id,
            CASE WHEN v_mail
                THEN jsonb_build_object('kind', CASE NEW.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', NEW.id,
                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id))
                ELSE jsonb_build_object('name', NEW.name, 'mime', NEW.mime_type, 'link_id', NEW.id,
                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id)) END);
    ELSIF TG_OP = 'DELETE' THEN
        -- the task or project is being deleted with it: the deletion is the event, not N unlinks
        IF (OLD.card_id IS NULL OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id))
           AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
            PERFORM public.collab_emit(OLD.project_id, CASE WHEN v_mail THEN 'email_unlinked' ELSE 'drive_file_unlinked' END,
                CASE WHEN OLD.card_id IS NULL THEN 'project' ELSE 'task' END, OLD.id::text, OLD.card_id,
                CASE WHEN v_mail
                    THEN jsonb_build_object('kind', CASE OLD.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', OLD.id,
                                            'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id))
                    ELSE jsonb_build_object('name', OLD.name, 'link_id', OLD.id,
                                            'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id)) END);
        END IF;
    END IF;
    -- metadata refreshes (UPDATE) are routine: no event, only the signal (ids only, never names, subjects or links)
    PERFORM public.collab_send(public.collab_project_topic(v_row.project_id), 'change',
        jsonb_build_object('t', 'links', 'op', lower(TG_OP), 'card', v_row.card_id));
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'links', 'op', 'delete', 'card', OLD.card_id));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_events() FROM PUBLIC, anon, authenticated;

DELETE FROM public.clearspace_migrations WHERE version = '20261128001400_google_calendar';
