-- RUN 07: switch ON the communication-hub scheduler (pg_cron every minute -> public.hub_scheduler_tick() -> pg_net -> <app>/api/hub/dispatch).
-- NOT a migration: only where the hub is switched on (local: hub-stack.sh scheduler-on; production: only after the owner's decision,
-- docs/run07/PRODUCTION_ROLLOUT.md). Idempotent.   psql -v url=https://<app>/api/hub/dispatch -v secret=<HUB_SERVER_SECRET> -f hub_scheduler_enable.sql
\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
SELECT vault.create_secret(:'secret', 'clearspace_hub_secret') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clearspace_hub_secret') \g /dev/null
SELECT vault.update_secret(id, :'secret') FROM vault.secrets WHERE name = 'clearspace_hub_secret' \g /dev/null
SELECT vault.create_secret(:'url', 'clearspace_hub_url') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'clearspace_hub_url') \g /dev/null
SELECT vault.update_secret(id, :'url') FROM vault.secrets WHERE name = 'clearspace_hub_url' \g /dev/null
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'clearspace-hub-dispatch' \g /dev/null
SELECT cron.schedule('clearspace-hub-dispatch', '* * * * *', 'SELECT public.hub_scheduler_tick()') \g /dev/null
SELECT 'hub scheduler on: ' || jobname || ' ' || schedule FROM cron.job WHERE jobname = 'clearspace-hub-dispatch';
