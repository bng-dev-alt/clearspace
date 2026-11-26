-- RUN 07: switch OFF the communication-hub scheduler (idempotent). Queue stays; a batch in flight expires as 'ambiguous'.
\set ON_ERROR_STOP on
DO $$ BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'clearspace-hub-dispatch'; END IF;
END $$;
DELETE FROM vault.secrets WHERE name IN ('clearspace_hub_secret', 'clearspace_hub_url');
SELECT 'hub scheduler off';
