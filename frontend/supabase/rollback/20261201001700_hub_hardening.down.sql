-- ============================================================
-- Rollback of 20261201001700_hub_hardening -> the 20261130001600 catalog. TWO steps, each one transaction:
--   1. psql --single-transaction -f 20261201001700_hub_hardening.down.sql
--   2. psql --single-transaction -f ../migrations/20261130001600_communication_hub.sql   (restores the 1600 function bodies, signatures, grants)
-- REFUSES (changes nothing) while the hub holds data, unless SET clearspace.rollback_allow_data_loss = 'on' (same rule as 1600).
-- ============================================================
DO $$
DECLARE v_n BIGINT := 0;
BEGIN
    IF to_regclass('cron.job') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM cron.job WHERE jobname = ''clearspace-hub-dispatch''' INTO v_n;
    END IF;
    IF coalesce(v_n, 0) > 0 THEN RAISE EXCEPTION 'Rollback refused: the hub scheduler is still on. Nothing was changed.'; END IF;
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        SELECT (SELECT count(*) FROM public.hub_destinations) + (SELECT count(*) FROM public.hub_slack_installations) + (SELECT count(*) FROM public.hub_identities)
             + (SELECT count(*) FROM public.hub_messages) + (SELECT count(*) FROM public.hub_outbox)
             + (SELECT count(*) FROM public.hub_inbox WHERE status NOT IN ('completed', 'failed')) INTO v_n;
        IF v_n > 0 THEN RAISE EXCEPTION 'Rollback refused: % hub rows would be lost. Nothing was changed.', v_n; END IF;
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.hub_svc_inbox_receive(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.hub_svc_inbox_claim(text, uuid, integer);
DROP FUNCTION IF EXISTS public.hub_svc_inbox_replying(text, uuid);
DROP FUNCTION IF EXISTS public.hub_svc_inbox_done(text, uuid, text, text);
DROP FUNCTION IF EXISTS public.hub_svc_inbox_due(text, integer);
DROP FUNCTION IF EXISTS public.hub_identity_begin(text, text, text);
DROP FUNCTION IF EXISTS public.hub_svc_identity_complete(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.hub_svc_message_permalink(text, uuid, text, text);
DROP FUNCTION IF EXISTS public.hub_svc_burn_code(text, text, text);
DROP FUNCTION IF EXISTS public.hub_svc_link_destination(text, uuid, text, text, text, text, text, text, uuid, text);
DROP FUNCTION IF EXISTS public.hub_destination_configure(text, uuid, boolean, boolean, boolean, boolean, text[], boolean);
DELETE FROM public.hub_link_codes WHERE purpose = 'identity';
ALTER TABLE public.hub_link_codes DROP CONSTRAINT IF EXISTS hub_link_codes_shape;
ALTER TABLE public.hub_link_codes ADD CONSTRAINT hub_link_codes_shape CHECK (
        (purpose = 'destination' AND project_id IS NOT NULL AND created_by IS NOT NULL)
     OR (purpose = 'identity' AND ext_user_hmac IS NOT NULL)
     OR (purpose = 'slack_install' AND provider = 'slack' AND created_by IS NOT NULL));
REVOKE SELECT (full_ingest) ON public.hub_destinations FROM authenticated;
REVOKE SELECT (message_id) ON public.hub_comment_links FROM authenticated;
ALTER TABLE public.hub_destinations DROP CONSTRAINT IF EXISTS hub_destinations_full_ingest;
ALTER TABLE public.hub_destinations DROP COLUMN IF EXISTS full_ingest, DROP COLUMN IF EXISTS linked_by_label;
ALTER TABLE public.hub_dispatch_runs DROP CONSTRAINT IF EXISTS hub_dispatch_runs_ids;
DELETE FROM public.hub_dispatch_runs WHERE cardinality(outbox_ids) = 0;
ALTER TABLE public.hub_dispatch_runs ADD CONSTRAINT hub_dispatch_runs_outbox_ids_check CHECK (cardinality(outbox_ids) BETWEEN 1 AND 100);
DROP INDEX IF EXISTS public.hub_inbox_due;
ALTER TABLE public.hub_inbox DROP CONSTRAINT IF EXISTS hub_inbox_state, DROP CONSTRAINT IF EXISTS hub_inbox_id_key;
ALTER TABLE public.hub_inbox DROP COLUMN IF EXISTS id, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS next_attempt_at,
    DROP COLUMN IF EXISTS lease_until, DROP COLUMN IF EXISTS payload, DROP COLUMN IF EXISTS last_error_code, DROP COLUMN IF EXISTS updated_at;
DELETE FROM public.clearspace_migrations WHERE version = '20261201001700_hub_hardening';
