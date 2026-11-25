-- ============================================================
-- Rollback of 20261127001300_gmail -> the 20261126001200 catalog.
--
-- REFUSES (changes nothing) while it would destroy data, unless the operator sets
--   SET clearspace.rollback_allow_data_loss = 'on';   (in the same session, before running this file)
--   * Gmail links exist (external_resource_links provider gmail_*): project/task associations would be lost,
--   * audit rows of the new kinds exist (service_added / service_removed): they would be deleted.
-- Google connections that hold the Gmail permission are NOT changed by this file: the grant stays at Google. Disable the
-- feature first (GMAIL_INTEGRATION_ENABLED unset), then let users remove Gmail or disconnect; see docs/run03/PRODUCTION_ROLLOUT.md.
-- Activity events already written (email_linked / email_unlinked) stay; the timeline shows them neutrally.
-- Run as one transaction: psql --single-transaction -f 20261127001300_gmail.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        SELECT count(*) INTO v_n FROM public.external_resource_links WHERE provider <> 'google_drive';
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % Gmail links would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
        SELECT count(*) INTO v_n FROM public.integration_audit WHERE event IN ('service_added', 'service_removed');
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % per-service audit rows would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
    END IF;
END $$;

DELETE FROM public.external_resource_links WHERE provider <> 'google_drive';   -- only reached when allowed (or none exist)
DELETE FROM public.integration_audit WHERE event IN ('service_added', 'service_removed');

DROP FUNCTION IF EXISTS public.gmail_links_purge_mine(TEXT);
DROP FUNCTION IF EXISTS public.gmail_link_refresh(TEXT, UUID, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.gmail_link_source(TEXT, UUID);
DROP FUNCTION IF EXISTS public.gmail_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.google_service_audit(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.google_service_remove(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.google_connection_sub(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.gmail_caller_sub();
DROP TABLE IF EXISTS public.gmail_link_sources;

ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_email_fields;
ALTER TABLE public.external_resource_links DROP COLUMN IF EXISTS email_attachments, DROP COLUMN IF EXISTS email_count, DROP COLUMN IF EXISTS email_from;
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_state_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_state_check CHECK (provider_state IN ('ok', 'trashed'));
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_web_url_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_web_url_check
    CHECK (char_length(web_url) <= 500 AND web_url ~ '^https://(drive|docs)\.google\.com/[A-Za-z0-9/_?=&.%-]*$');
ALTER TABLE public.external_resource_links ALTER COLUMN web_url SET NOT NULL;
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_check CHECK (provider IN ('google_drive'));
ALTER TABLE public.integration_audit DROP CONSTRAINT IF EXISTS integration_audit_event_check;
ALTER TABLE public.integration_audit ADD CONSTRAINT integration_audit_event_check
    CHECK (event IN ('connected', 'reconnected', 'disconnected', 'revoked_by_provider', 'refresh_failed', 'scope_denied'));

-- the 20261126001200 definition, verbatim
CREATE OR REPLACE FUNCTION public.external_links_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.external_resource_links%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.project_id, 'drive_file_linked', CASE WHEN NEW.card_id IS NULL THEN 'project' ELSE 'task' END,
            NEW.id::text, NEW.card_id, jsonb_build_object(
                'name', NEW.name, 'mime', NEW.mime_type, 'link_id', NEW.id,
                'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id)));
    ELSIF TG_OP = 'DELETE' THEN
        -- the task or project is being deleted with it: the deletion is the event, not N unlinks
        IF (OLD.card_id IS NULL OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id))
           AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
            PERFORM public.collab_emit(OLD.project_id, 'drive_file_unlinked', CASE WHEN OLD.card_id IS NULL THEN 'project' ELSE 'task' END,
                OLD.id::text, OLD.card_id, jsonb_build_object(
                    'name', OLD.name, 'link_id', OLD.id,
                    'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id)));
        END IF;
    END IF;
    -- metadata refreshes (UPDATE) are routine: no event, only the signal
    PERFORM public.collab_send(public.collab_project_topic(v_row.project_id), 'change',
        jsonb_build_object('t', 'links', 'op', lower(TG_OP), 'card', v_row.card_id));
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'links', 'op', 'delete', 'card', OLD.card_id));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_events() FROM PUBLIC, anon, authenticated;

DELETE FROM public.clearspace_migrations WHERE version = '20261127001300_gmail';
