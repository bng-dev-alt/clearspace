-- ============================================================
-- Rollback of 20261129001500_notification_channels -> the 20261128001400 catalog.
--
-- REFUSES (changes nothing) while it would destroy data, unless the operator sets
--   SET clearspace.rollback_allow_data_loss = 'on';   (in the same session, before running this file)
--   * notification channels exist (connected Slack / Telegram), or
--   * notification preferences or deliveries exist.
-- Before a rollback: switch both features off (SLACK_INTEGRATION_ENABLED / TELEGRAM_INTEGRATION_ENABLED unset or 0) and disable the
-- scheduler (supabase/ops/notify_scheduler_disable.sql), see docs/run05/PRODUCTION_ROLLOUT.md. Stored Slack bot tokens are NOT revoked
-- here (the database cannot decrypt them): users disconnect first, or the Slack app is uninstalled by its owner.
-- Existing objects (notifications, activity_logs, collab_notify, RUN 01-04 triggers) were never changed by 1500 and stay as they are.
-- Run as one transaction: psql --single-transaction -f 20261129001500_notification_channels.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = ''clearspace-notify-dispatch''' INTO v_n;
    END IF;
    IF coalesce(v_n, 0) > 0 THEN
        RAISE EXCEPTION 'Rollback refused: the notification scheduler is still on (run supabase/ops/notify_scheduler_disable.sql first). Nothing was changed.';
    END IF;
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        SELECT count(*) INTO v_n FROM public.notification_channels;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % notification channels would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
        SELECT (SELECT count(*) FROM public.notification_preferences) + (SELECT count(*) FROM public.notification_deliveries) INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % notification preference / delivery rows would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
        END IF;
    END IF;
END $$;

DROP TRIGGER IF EXISTS z_notify_from_notification ON public.notifications;
DROP TRIGGER IF EXISTS z_notify_from_activity ON public.activity_logs;

DROP FUNCTION IF EXISTS public.notify_scheduler_tick(TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS public.notify_dispatch_apply(JSONB);
DROP FUNCTION IF EXISTS public.notify_dispatch_result(UUID, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.notify_dispatch_claim(INTEGER, INTEGER, TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS public.notify_dispatch_prepare(TIMESTAMP WITH TIME ZONE);
DROP FUNCTION IF EXISTS public.notify_prefs_set(TEXT, TEXT[], TEXT[], BOOLEAN);
DROP FUNCTION IF EXISTS public.notify_channel_mark(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_test_begin(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.notify_channel_remove(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_channel_set_enabled(TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.notify_telegram_confirm(TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.notify_telegram_attach(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_telegram_lookup(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_slack_complete(TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_slack_lookup(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_link_begin(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_status(TEXT);
DROP FUNCTION IF EXISTS public.notify_from_activity();
DROP FUNCTION IF EXISTS public.notify_from_notification();
DROP FUNCTION IF EXISTS public.notify_enqueue(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS public.notify_due_window_end(DATE);
DROP FUNCTION IF EXISTS public.notify_due_window_start(DATE);
DROP FUNCTION IF EXISTS public.notify_prefs_allow(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.notify_pref_key(TEXT);

DROP TABLE IF EXISTS public.notification_dispatch_runs;
DROP TABLE IF EXISTS public.notification_deliveries;
DROP TABLE IF EXISTS public.notification_preferences;
DROP TABLE IF EXISTS public.notification_channels;

DELETE FROM public.clearspace_migrations WHERE version = '20261129001500_notification_channels';
