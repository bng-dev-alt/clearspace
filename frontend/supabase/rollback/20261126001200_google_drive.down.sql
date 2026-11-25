-- ============================================================
-- Rollback of 20261126001200_google_drive -> the 20261125001100 catalog.
--
-- REFUSES (changes nothing) while it would destroy data, unless the operator sets
--   SET clearspace.rollback_allow_data_loss = 'on';   (in the same session, before running this file)
--   * Drive links exist (external_resource_links): project/task associations would be lost,
--   * Google connections exist (google_connections): users' credentials would be dropped WITHOUT revoking them
--     at Google -- disconnect them in the app first (it revokes), or revoke via the Google account settings.
-- Activity events already written (drive_file_linked / _unlinked) stay; the timeline shows them neutrally.
-- Run as one transaction: psql --single-transaction -f 20261126001200_google_drive.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        IF to_regclass('public.external_resource_links') IS NOT NULL THEN
            EXECUTE 'SELECT count(*) FROM public.external_resource_links' INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'Rollback refused: % Drive links would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
            END IF;
        END IF;
        IF to_regclass('public.google_connections') IS NOT NULL THEN
            EXECUTE 'SELECT count(*) FROM public.google_connections' INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'Rollback refused: % Google connections exist; disconnect them first so the grants are revoked at Google (or set clearspace.rollback_allow_data_loss = on). Nothing was changed.', v_n;
            END IF;
        END IF;
    END IF;
END $$;

DROP TRIGGER IF EXISTS external_links_follow_card ON public.cards;
DROP FUNCTION IF EXISTS public.external_links_follow_card();
DROP FUNCTION IF EXISTS public.drive_link_refresh(TEXT, UUID, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT);
DROP FUNCTION IF EXISTS public.drive_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT);
DROP TABLE IF EXISTS public.external_resource_links;   -- its triggers go with it
DROP FUNCTION IF EXISTS public.external_links_events();
DROP FUNCTION IF EXISTS public.external_links_server_fields();

DROP FUNCTION IF EXISTS public.google_disconnect(TEXT);
DROP FUNCTION IF EXISTS public.google_connection_mark(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.google_refresh_store(TEXT, BIGINT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT);
DROP FUNCTION IF EXISTS public.google_refresh_lease(TEXT, BIGINT);
DROP FUNCTION IF EXISTS public.google_credentials_get(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.google_oauth_audit_denied(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.google_oauth_complete(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS public.google_oauth_consume(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.google_oauth_begin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]);
DROP FUNCTION IF EXISTS public.google_require_user();
DROP FUNCTION IF EXISTS public.google_connection_status();
DROP TABLE IF EXISTS public.integration_audit;
DROP TABLE IF EXISTS public.google_oauth_states;
DROP TABLE IF EXISTS public.google_connections;

DELETE FROM public.clearspace_migrations WHERE version = '20261126001200_google_drive';
