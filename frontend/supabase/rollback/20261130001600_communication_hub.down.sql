-- ============================================================
-- Rollback of 20261130001600_communication_hub -> the 20261129001500 catalog.
-- REFUSES (changes nothing) while it would destroy data, unless SET clearspace.rollback_allow_data_loss = 'on' in the same session:
--   destinations, Slack installations, identities, stored communication, queued work or the hub scheduler job exist.
-- Before: switch HUB_* features off, disable the scheduler (supabase/ops/hub_scheduler_disable.sql), remove webhooks at the providers.
-- Existing objects (cards, task_comments, activity_logs, RUN 05 notify_*) were never changed by 1600.
-- Run as one transaction: psql --single-transaction -f 20261130001600_communication_hub.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT := 0;
BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = ''clearspace-hub-dispatch''' INTO v_n;
    END IF;
    IF coalesce(v_n, 0) > 0 THEN
        RAISE EXCEPTION 'Rollback refused: the hub scheduler is still on (run supabase/ops/hub_scheduler_disable.sql first). Nothing was changed.';
    END IF;
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        SELECT (SELECT count(*) FROM public.hub_destinations) + (SELECT count(*) FROM public.hub_slack_installations) + (SELECT count(*) FROM public.hub_identities)
             + (SELECT count(*) FROM public.hub_messages) + (SELECT count(*) FROM public.hub_outbox) INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % hub rows (destinations / installations / identities / communication / queue) would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
    END IF;
END $$;

DROP TRIGGER IF EXISTS z_hub_from_activity ON public.activity_logs;
DROP TRIGGER IF EXISTS z_hub_from_comment ON public.task_comments;
DROP VIEW IF EXISTS public.hub_intelligence_messages;
DO $$
DECLARE f RECORD;
BEGIN
    FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hub\_%' LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %s', f.sig);
    END LOOP;
END $$;
DROP TABLE IF EXISTS public.hub_dispatch_runs, public.hub_outbox, public.hub_inbox, public.hub_comment_links, public.hub_messages, public.hub_conversations,
                     public.hub_identities, public.hub_link_codes, public.hub_destinations, public.hub_slack_installations, public.hub_audit, public.hub_service_principal;
DELETE FROM public.clearspace_migrations WHERE version = '20261130001600_communication_hub';
