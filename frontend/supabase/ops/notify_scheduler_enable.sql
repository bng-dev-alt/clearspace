-- ============================================================
-- RUN 05: switch ON the notification scheduler: pg_cron runs public.notify_scheduler_tick() every minute; the tick POSTs due
-- deliveries over pg_net to <app>/api/notify/dispatch and collects the answers on the next tick.
-- NOT a migration: run only where external notifications are switched on (local stack: notify-stack.sh scheduler-on;
-- production: only after the owner's decision, docs/run05/PRODUCTION_ROLLOUT.md). Idempotent.
--   psql -v url=https://<app>/api/notify/dispatch -v secret=<NOTIFY_SERVER_SECRET> -f notify_scheduler_enable.sql
-- The URL and the secret are kept in Supabase Vault (encrypted at rest). pg_net keeps a request (with the header) only until it is
-- sent; answers (ids + outcome codes, nothing else) for 6 hours.
-- ============================================================
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT vault.create_secret(:'secret', 'clearspace_notify_secret') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clearspace_notify_secret') \g /dev/null
SELECT vault.update_secret(id, :'secret') FROM vault.secrets WHERE name = 'clearspace_notify_secret' \g /dev/null
SELECT vault.create_secret(:'url', 'clearspace_notify_url') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clearspace_notify_url') \g /dev/null
SELECT vault.update_secret(id, :'url') FROM vault.secrets WHERE name = 'clearspace_notify_url' \g /dev/null
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'clearspace-notify-dispatch' \g /dev/null
SELECT cron.schedule('clearspace-notify-dispatch', '* * * * *', 'SELECT public.notify_scheduler_tick()') \g /dev/null
SELECT 'scheduler on: ' || jobname || ' ' || schedule FROM cron.job WHERE jobname = 'clearspace-notify-dispatch';
