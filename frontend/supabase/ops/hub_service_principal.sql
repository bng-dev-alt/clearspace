-- RUN 07: register the dedicated SERVICE PRINCIPAL the webhooks use (a normal Supabase user with no project rights) and the server secret.
-- NOT a migration (production: only when the hub is switched on). psql -v uid=<auth user id> -v secret_sha256=<sha256 hex of HUB_SERVER_SECRET> -f ...
\set ON_ERROR_STOP on
INSERT INTO public.hub_service_principal (singleton, user_id) VALUES (true, :'uid') ON CONFLICT (singleton) DO UPDATE SET user_id = EXCLUDED.user_id, registered_at = now();
INSERT INTO public.server_trust (purpose, secret_sha256) VALUES ('hub', :'secret_sha256') ON CONFLICT (purpose) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, rotated_at = now();
SELECT 'hub principal registered';
