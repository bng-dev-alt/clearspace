-- RUN 05: switch OFF the notification scheduler (idempotent). Leaves the extensions installed and the queue as it is
-- (leases of a batch in flight expire -> 'ambiguous', never re-sent).
\set ON_ERROR_STOP on
DO $$ BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'clearspace-notify-dispatch';
    END IF;
END $$;
DELETE FROM vault.secrets WHERE name IN ('clearspace_notify_secret', 'clearspace_notify_url');
SELECT 'scheduler off';
