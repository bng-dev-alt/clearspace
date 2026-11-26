-- ============================================================
-- RUN 07B: Communication Hub hardening (on top of 20261130001600_communication_hub). Idempotent, backward-compatible with the RUN 07 code
-- (hub switches off) and with every older build: no existing object outside hub_* is changed, no extension, nothing scheduled.
--   1. durable inbound processing: hub_inbox becomes a work queue (received -> processing -> replying -> completed | retry -> failed),
--      payload kept only until done; leases + claim are atomic, retries bounded, an interrupted REPLY is never re-sent (at most once outbound)
--   2. concurrency: per-message advisory locks in task creation / inbound messages (no duplicate cards or comments under parallel retries);
--      code-based linking and identity completion are replay-safe
--   3. identity linking is started by the SIGNED-IN user (code shown in ClearSpace) and completed from the chat account (proof of both sides)
--   4. Telegram full-group ingestion for Project Intelligence only through a separate, optional PI bot (`full_ingest`, opt-in, off by default)
--   5. re-check of a destination after the bot was added back; permalinks for synced replies; comment provenance readable by members
-- Rollback: supabase/rollback/20261201001700_hub_hardening.down.sql
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261130001600_communication_hub') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261130001600_communication_hub first. Nothing was changed.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
ALTER TABLE public.hub_inbox
    ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS payload JSONB,
    ADD COLUMN IF NOT EXISTS last_error_code TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now();
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_inbox_state') THEN
        ALTER TABLE public.hub_inbox ADD CONSTRAINT hub_inbox_state CHECK (
            status IN ('received', 'processing', 'replying', 'completed', 'retry', 'failed')
            AND attempts BETWEEN 0 AND 100
            AND (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$')
            AND (payload IS NULL OR octet_length(payload::text) <= 300000)
            -- finished work keeps no message content
            AND (status NOT IN ('completed', 'failed') OR payload IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_inbox_id_key') THEN
        ALTER TABLE public.hub_inbox ADD CONSTRAINT hub_inbox_id_key UNIQUE (id);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS hub_inbox_due ON public.hub_inbox (next_attempt_at) WHERE status IN ('received', 'processing', 'replying', 'retry');

-- the scheduler may now call the app for inbound work only (no outbox items)
ALTER TABLE public.hub_dispatch_runs DROP CONSTRAINT IF EXISTS hub_dispatch_runs_outbox_ids_check;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_dispatch_runs_ids') THEN
        ALTER TABLE public.hub_dispatch_runs ADD CONSTRAINT hub_dispatch_runs_ids CHECK (cardinality(outbox_ids) <= 100);
    END IF;
END $$;

-- identity codes are now issued to a signed-in user (created_by) and completed by the chat account
DELETE FROM public.hub_link_codes WHERE purpose = 'identity' AND created_by IS NULL;     -- RUN 07 chat-initiated codes (pre-release only)
ALTER TABLE public.hub_link_codes DROP CONSTRAINT IF EXISTS hub_link_codes_shape;
ALTER TABLE public.hub_link_codes ADD CONSTRAINT hub_link_codes_shape CHECK (
        (purpose = 'destination' AND project_id IS NOT NULL AND created_by IS NOT NULL)
     OR (purpose = 'identity' AND created_by IS NOT NULL)
     OR (purpose = 'slack_install' AND provider = 'slack' AND created_by IS NOT NULL));

ALTER TABLE public.hub_destinations ADD COLUMN IF NOT EXISTS full_ingest BOOLEAN NOT NULL DEFAULT false;
-- who typed the linking code in the chat (shown to the manager before confirming); never a provider id
ALTER TABLE public.hub_destinations ADD COLUMN IF NOT EXISTS linked_by_label TEXT CHECK (linked_by_label IS NULL OR (char_length(linked_by_label) <= 200 AND linked_by_label !~ '[[:cntrl:]]'));
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_destinations_full_ingest') THEN
        ALTER TABLE public.hub_destinations ADD CONSTRAINT hub_destinations_full_ingest CHECK (NOT full_ingest OR (intelligence AND provider = 'telegram'));
    END IF;
END $$;
GRANT SELECT (id, project_id, status, intelligence, full_ingest) ON public.hub_destinations TO authenticated;
-- comment provenance (members see which comments came from / went to chat, with the original message link)
GRANT SELECT (comment_id, direction, provider, message_id) ON public.hub_comment_links TO authenticated;

-- ------------------------------------------------------------
-- 2. Durable inbound processing (service principal only)
-- ------------------------------------------------------------
-- Record an event. New -> 'received' with its payload; already known -> its current state (provider retry / replay = no second processing).
CREATE OR REPLACE FUNCTION public.hub_svc_inbox_receive(p_server_secret TEXT, p_provider TEXT, p_event_key TEXT, p_payload JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r public.hub_inbox%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    INSERT INTO public.hub_inbox (provider, event_key, status, payload) VALUES (p_provider, p_event_key, 'received', p_payload)
    ON CONFLICT (provider, event_key) DO NOTHING
    RETURNING * INTO r;
    IF r.id IS NOT NULL THEN RETURN jsonb_build_object('id', r.id, 'new', true, 'status', r.status); END IF;
    SELECT * INTO r FROM public.hub_inbox i WHERE i.provider = p_provider AND i.event_key = p_event_key;
    RETURN jsonb_build_object('id', r.id, 'new', false, 'status', r.status);
END $$;

-- Claim one event for processing (atomic: exactly one concurrent caller wins). Expired leases are taken over; the 6th attempt fails terminally.
CREATE OR REPLACE FUNCTION public.hub_svc_inbox_claim(p_server_secret TEXT, p_id UUID, p_lease_seconds INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r public.hub_inbox%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    SELECT * INTO r FROM public.hub_inbox i WHERE i.id = p_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF NOT (r.status IN ('received', 'retry') AND r.next_attempt_at <= now() OR r.status = 'processing' AND r.lease_until < now()) THEN RETURN NULL; END IF;
    IF r.attempts >= 5 THEN
        UPDATE public.hub_inbox SET status = 'failed', payload = NULL, lease_until = NULL, last_error_code = coalesce(last_error_code, 'retry_exhausted'), updated_at = now() WHERE id = r.id;
        RETURN NULL;
    END IF;
    UPDATE public.hub_inbox SET status = 'processing', attempts = attempts + 1, updated_at = now(),
           lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 60), 15), 300))
     WHERE id = r.id;
    RETURN jsonb_build_object('id', r.id, 'provider', r.provider, 'payload', r.payload, 'attempt', r.attempts + 1);
END $$;

-- Effects are done; the replies are about to be sent. From here on the event is never processed again (an interrupted reply is NOT re-sent).
CREATE OR REPLACE FUNCTION public.hub_svc_inbox_replying(p_server_secret TEXT, p_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_inbox SET status = 'replying', payload = NULL, lease_until = now() + interval '2 minutes', updated_at = now()
     WHERE id = p_id AND status = 'processing';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n = 1;
END $$;

-- Finish: completed | retry (bounded exponential backoff, terminal after 5 attempts) | failed. Finished events keep no payload.
CREATE OR REPLACE FUNCTION public.hub_svc_inbox_done(p_server_secret TEXT, p_id UUID, p_outcome TEXT, p_error_code TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r public.hub_inbox%ROWTYPE; v_status TEXT;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    IF p_outcome NOT IN ('completed', 'retry', 'failed') OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.hub_inbox i WHERE i.id = p_id AND i.status IN ('processing', 'replying') FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_claimed'; END IF;
    v_status := CASE WHEN r.status = 'replying' THEN 'completed'                 -- replies began: never processed again
                     WHEN p_outcome = 'retry' AND r.attempts >= 5 THEN 'failed' ELSE p_outcome END;
    UPDATE public.hub_inbox SET status = v_status, lease_until = NULL, updated_at = now(),
           payload = CASE WHEN v_status IN ('completed', 'failed') THEN NULL ELSE payload END,
           last_error_code = CASE WHEN v_status = 'completed' AND p_outcome = 'completed' THEN NULL ELSE coalesce(p_error_code, last_error_code) END,
           next_attempt_at = CASE WHEN v_status = 'retry' THEN now() + make_interval(secs => (30 * power(4, least(r.attempts, 4)))::int) ELSE next_attempt_at END
     WHERE id = r.id;
    RETURN v_status;
END $$;

-- Due work for the dispatcher (stale leases included). Fresh 'received' events are left to the request that stored them for 30 s.
CREATE OR REPLACE FUNCTION public.hub_svc_inbox_due(p_server_secret TEXT, p_limit INTEGER)
RETURNS UUID[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    RETURN coalesce((SELECT array_agg(id) FROM (
        SELECT i.id FROM public.hub_inbox i
         WHERE (i.status = 'received' AND i.received_at < now() - interval '30 seconds')
            OR (i.status = 'retry' AND i.next_attempt_at <= now())
            OR (i.status = 'processing' AND i.lease_until < now())
         ORDER BY i.next_attempt_at LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) x), '{}');
END $$;

-- ------------------------------------------------------------
-- 3. Replay-safe linking + identity started in ClearSpace
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.hub_svc_link_destination(text, uuid, text, text, text, text, text, text, uuid);
CREATE OR REPLACE FUNCTION public.hub_svc_link_destination(p_server_secret TEXT, p_id UUID, p_code_hash TEXT, p_provider TEXT, p_ext_key TEXT, p_ext_ref_enc TEXT,
                                                           p_label TEXT, p_kind TEXT, p_installation UUID, p_linked_by TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    c public.hub_link_codes%ROWTYPE;
    v_existing public.hub_destinations%ROWTYPE;
    v_id UUID;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    PERFORM pg_advisory_xact_lock(hashtextextended('hub_link:' || p_provider || ':' || p_ext_key, 0));
    UPDATE public.hub_link_codes x SET consumed_at = now()
     WHERE x.code_hash = p_code_hash AND x.purpose = 'destination' AND x.provider = p_provider AND x.consumed_at IS NULL AND x.expires_at > now()
    RETURNING * INTO c;
    IF NOT FOUND THEN
        -- replay of the SAME link (provider retry after a crash): the code was consumed for this very chat -> same answer, nothing new
        SELECT * INTO c FROM public.hub_link_codes x WHERE x.code_hash = p_code_hash AND x.purpose = 'destination' AND x.provider = p_provider
           AND x.consumed_at > now() - interval '15 minutes';
        IF FOUND THEN
            SELECT * INTO v_existing FROM public.hub_destinations d WHERE d.provider = p_provider AND d.ext_key_hmac = p_ext_key AND d.project_id = c.project_id
               AND d.created_at >= c.consumed_at - interval '5 seconds';
            IF FOUND THEN
                RETURN jsonb_build_object('ok', true, 'replay', true, 'destinationId', v_existing.id, 'projectName', (SELECT p.name FROM public.projects p WHERE p.id = c.project_id));
            END IF;
        END IF;
        RETURN jsonb_build_object('ok', false, 'reason', 'code_invalid');
    END IF;
    IF coalesce(public.project_role_of(c.project_id, c.created_by), '') NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'issuer_not_manager');
    END IF;
    SELECT * INTO v_existing FROM public.hub_destinations d WHERE d.provider = p_provider AND d.ext_key_hmac = p_ext_key;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', CASE WHEN v_existing.project_id = c.project_id THEN 'already_linked_here' ELSE 'linked_elsewhere' END);
    END IF;
    INSERT INTO public.hub_destinations (project_id, provider, installation_id, ext_key_hmac, ext_ref_enc, label, kind, created_by, id, linked_by_label)
    VALUES (c.project_id, p_provider, p_installation, p_ext_key, p_ext_ref_enc, p_label, p_kind, c.created_by, p_id, left(nullif(trim(p_linked_by), ''), 200))
    RETURNING id INTO v_id;
    PERFORM public.hub_audit_add(c.project_id, v_id, NULL, 'service', 'destination_linked', 'provider=' || p_provider);
    RETURN jsonb_build_object('ok', true, 'destinationId', v_id, 'projectName', (SELECT p.name FROM public.projects p WHERE p.id = c.project_id));
END $$;

-- A code shown in a chat by someone who may not use it (not a group admin) is burnt: nobody else in that chat can copy it elsewhere.
CREATE OR REPLACE FUNCTION public.hub_svc_burn_code(p_server_secret TEXT, p_code_hash TEXT, p_provider TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_link_codes SET consumed_at = now(), expires_at = least(expires_at, now())
     WHERE code_hash = p_code_hash AND purpose = 'destination' AND provider = p_provider AND consumed_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;

-- Signed-in user: a single-use code (10 min, hash only) that the user then sends FROM the chat account (Slack `/clearspace ucet KÓD`,
-- Telegram deep link /start KÓD). The chat side alone can never bind itself to someone else's ClearSpace account (RUN 07B security fix).
CREATE OR REPLACE FUNCTION public.hub_identity_begin(p_server_secret TEXT, p_provider TEXT, p_code_hash TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret);
BEGIN
    IF p_provider NOT IN ('slack', 'telegram') OR p_code_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    IF (SELECT count(*) FROM public.hub_link_codes c WHERE c.created_by = v_uid AND c.purpose = 'identity' AND c.created_at > now() - interval '10 minutes') >= 5 THEN
        RAISE EXCEPTION 'Příliš mnoho pokusů. Zkuste to prosím za chvíli.' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.hub_link_codes (code_hash, purpose, provider, created_by, expires_at) VALUES (p_code_hash, 'identity', p_provider, v_uid, now() + interval '10 minutes');
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_identity_complete(p_server_secret TEXT, p_code_hash TEXT, p_provider TEXT, p_ext_user TEXT, p_label TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE c public.hub_link_codes%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    IF p_ext_user !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    UPDATE public.hub_link_codes x SET consumed_at = now(), ext_user_hmac = p_ext_user
     WHERE x.code_hash = p_code_hash AND x.purpose = 'identity' AND x.provider = p_provider AND x.consumed_at IS NULL AND x.expires_at > now()
    RETURNING * INTO c;
    IF NOT FOUND THEN
        SELECT * INTO c FROM public.hub_link_codes x WHERE x.code_hash = p_code_hash AND x.purpose = 'identity' AND x.provider = p_provider
           AND x.ext_user_hmac = p_ext_user AND x.consumed_at > now() - interval '15 minutes';
        IF FOUND AND EXISTS (SELECT 1 FROM public.hub_identities i WHERE i.provider = p_provider AND i.ext_user_hmac = p_ext_user AND i.user_id = c.created_by) THEN
            RETURN jsonb_build_object('ok', true, 'replay', true, 'name', (SELECT p.display_name FROM public.profiles p WHERE p.id = c.created_by));
        END IF;
        RETURN jsonb_build_object('ok', false, 'reason', 'code_invalid');
    END IF;
    IF EXISTS (SELECT 1 FROM public.hub_service_principal s WHERE s.user_id = c.created_by) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'code_invalid');
    END IF;
    INSERT INTO public.hub_identities (provider, ext_user_hmac, user_id, label) VALUES (p_provider, p_ext_user, c.created_by, left(nullif(trim(p_label), ''), 200))
    ON CONFLICT (provider, ext_user_hmac) DO UPDATE SET user_id = EXCLUDED.user_id, label = EXCLUDED.label, created_at = now();
    PERFORM public.hub_audit_add(NULL, NULL, c.created_by, 'service', 'identity_linked', 'provider=' || p_provider);
    RETURN jsonb_build_object('ok', true, 'name', (SELECT p.display_name FROM public.profiles p WHERE p.id = c.created_by));
END $$;
DROP FUNCTION IF EXISTS public.hub_svc_identity_begin(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.hub_identity_confirm(text, text);

-- ------------------------------------------------------------
-- 4. Concurrency-safe task creation and inbound messages (advisory lock per project message)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_svc_create_task(p_server_secret TEXT, p_destination UUID, p_ext_user TEXT, p_title TEXT, p_details TEXT,
                                                      p_msg_key TEXT, p_author_label TEXT, p_text TEXT, p_permalink TEXT, p_sent_at TIMESTAMP WITH TIME ZONE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    d public.hub_destinations%ROWTYPE;
    v_uid UUID;
    v_role TEXT;
    v_col TEXT;
    v_card TEXT;
    v_prev JSONB;
    v_existing public.hub_messages%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR SHARE;
    IF NOT FOUND OR d.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'destination_inactive'); END IF;
    IF NOT d.interactive THEN RETURN jsonb_build_object('ok', false, 'reason', 'interactive_off'); END IF;
    SELECT i.user_id INTO v_uid FROM public.hub_identities i WHERE i.provider = d.provider AND i.ext_user_hmac = p_ext_user;
    IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'identity_unlinked'); END IF;
    v_role := public.project_role_of(d.project_id, v_uid);
    IF coalesce(v_role, '') NOT IN ('owner', 'admin', 'member') THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_edit_right'); END IF;
    -- one task per source message even under parallel retries / double submissions
    PERFORM pg_advisory_xact_lock(hashtextextended('hub_msg:' || d.project_id || ':' || p_msg_key, 0));
    SELECT * INTO v_existing FROM public.hub_messages m WHERE m.project_id = d.project_id AND m.msg_key_hmac = p_msg_key AND m.kind = 'task_source';
    IF FOUND AND v_existing.card_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.cards k WHERE k.id = v_existing.card_id AND k.project_id = d.project_id) THEN
            RETURN jsonb_build_object('ok', false, 'reason', 'card_moved');       -- never reveal a card that now lives in another project
        END IF;
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'cardId', v_existing.card_id, 'projectId', d.project_id,
                                  'title', (SELECT k.title FROM public.cards k WHERE k.id = v_existing.card_id), 'projectName', (SELECT p.name FROM public.projects p WHERE p.id = d.project_id));
    END IF;
    IF char_length(trim(coalesce(p_title, ''))) = 0 OR char_length(p_title) > 200 OR char_length(coalesce(p_details, '')) > 4000 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
    END IF;
    SELECT c.id INTO v_col FROM public.columns c WHERE c.project_id = d.project_id AND NOT public.collab_is_done_column(c.id) ORDER BY c.position LIMIT 1;
    IF v_col IS NULL THEN SELECT c.id INTO v_col FROM public.columns c WHERE c.project_id = d.project_id ORDER BY c.position LIMIT 1; END IF;
    IF v_col IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_column'); END IF;
    v_card := 'hub-' || replace(gen_random_uuid()::text, '-', '');
    v_prev := public.hub_act_as(v_uid);
    PERFORM set_config('clearspace.hub_inbound', d.id::text, true);     -- loop guard for THIS destination only: other destinations are notified
    INSERT INTO public.cards (id, column_id, project_id, title, details, position)
    VALUES (v_card, v_col, d.project_id, trim(p_title), coalesce(p_details, ''),
            coalesce((SELECT max(k.position) + 1 FROM public.cards k WHERE k.column_id = v_col), 0));
    INSERT INTO public.hub_messages (project_id, destination_id, destination_label, provider, card_id, msg_key_hmac, kind, author_label, author_user_id, verified, text, permalink, sent_at)
    -- the SOURCE message is recorded with its own (unverified) author; who created the task is in the task's activity
    VALUES (d.project_id, d.id, d.label, d.provider, v_card, p_msg_key, 'task_source', left(coalesce(nullif(trim(p_author_label), ''), 'externí autor'), 200), NULL, false,
            left(coalesce(p_text, ''), 4000), p_permalink, coalesce(p_sent_at, now()))
    ON CONFLICT (project_id, msg_key_hmac) DO UPDATE SET card_id = EXCLUDED.card_id, kind = 'task_source', retain_until = NULL,
                                                         permalink = coalesce(hub_messages.permalink, EXCLUDED.permalink);
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'service', 'task_created_from_chat', 'provider=' || d.provider);
    RETURN jsonb_build_object('ok', true, 'duplicate', false, 'cardId', v_card, 'projectId', d.project_id, 'title', trim(p_title),
                              'projectName', (SELECT p.name FROM public.projects p WHERE p.id = d.project_id));
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_inbound_message(p_server_secret TEXT, p_destination UUID, p_thread_key TEXT, p_msg_key TEXT, p_ext_user TEXT,
                                                          p_author_label TEXT, p_text TEXT, p_permalink TEXT, p_sent_at TIMESTAMP WITH TIME ZONE, p_ingest_allowed BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    d public.hub_destinations%ROWTYPE;
    cv public.hub_conversations%ROWTYPE;
    v_uid UUID;
    v_role TEXT;
    v_msg UUID;
    v_comment TEXT;
    v_prev JSONB;
    v_kind TEXT;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR SHARE;
    IF NOT FOUND OR d.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'dropped', 'reason', 'destination_inactive'); END IF;
    IF p_thread_key IS NOT NULL AND d.interactive THEN
        SELECT * INTO cv FROM public.hub_conversations c WHERE c.destination_id = d.id AND c.thread_key_hmac = p_thread_key;
    END IF;
    -- a task moved to another project is no longer this channel's conversation
    IF cv.id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cards k WHERE k.id = cv.card_id AND k.project_id = d.project_id) THEN cv := NULL; END IF;
    IF cv.id IS NOT NULL THEN v_kind := 'thread_reply';
    ELSIF d.intelligence AND coalesce(p_ingest_allowed, false) THEN v_kind := 'ingested';
    ELSE RETURN jsonb_build_object('outcome', 'dropped', 'reason', 'not_linked');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('hub_msg:' || d.project_id || ':' || p_msg_key, 0));
    SELECT i.user_id INTO v_uid FROM public.hub_identities i WHERE i.provider = d.provider AND i.ext_user_hmac = p_ext_user;
    v_role := CASE WHEN v_uid IS NULL THEN NULL ELSE public.project_role_of(d.project_id, v_uid) END;
    INSERT INTO public.hub_messages (project_id, destination_id, destination_label, provider, card_id, conversation_id, msg_key_hmac, kind, author_label,
                                     author_user_id, verified, text, permalink, sent_at, retain_until)
    VALUES (d.project_id, d.id, d.label, d.provider, cv.card_id, cv.id, p_msg_key, v_kind,
            left(coalesce(nullif(trim(p_author_label), ''), 'externí autor'), 200), CASE WHEN v_role IS NOT NULL THEN v_uid END, v_role IS NOT NULL,
            left(coalesce(p_text, ''), 4000), p_permalink, coalesce(p_sent_at, now()), CASE WHEN v_kind = 'ingested' THEN now() + interval '90 days' END)
    ON CONFLICT (project_id, msg_key_hmac) DO NOTHING
    RETURNING id INTO v_msg;
    IF v_msg IS NULL THEN RETURN jsonb_build_object('outcome', 'duplicate'); END IF;
    IF v_kind = 'thread_reply' AND coalesce(v_role, '') IN ('owner', 'admin', 'member') AND char_length(trim(coalesce(p_text, ''))) BETWEEN 1 AND 5000 THEN
        v_comment := 'hub-' || replace(gen_random_uuid()::text, '-', '');
        v_prev := public.hub_act_as(v_uid);
        PERFORM set_config('clearspace.hub_inbound', d.id::text, true);
        BEGIN
            INSERT INTO public.task_comments (id, card_id, author_name, content, author_id)
            VALUES (v_comment, cv.card_id, coalesce((SELECT p.display_name FROM public.profiles p WHERE p.id = v_uid), 'ClearSpace'), trim(p_text), v_uid);
            INSERT INTO public.hub_comment_links (comment_id, direction, provider, message_id) VALUES (v_comment, 'inbound', d.provider, v_msg);
        EXCEPTION WHEN OTHERS THEN
            v_comment := NULL;      -- e.g. the RUN 01 comment rate limit: the record stays, no comment
        END;
    END IF;
    RETURN jsonb_build_object('outcome', 'stored', 'kind', v_kind, 'messageId', v_msg, 'commentId', v_comment, 'verified', v_role IS NOT NULL);
END $$;

-- Original-message link for a stored record (fetched after storing: one provider call only for messages that were kept).
CREATE OR REPLACE FUNCTION public.hub_svc_message_permalink(p_server_secret TEXT, p_destination UUID, p_msg_key TEXT, p_permalink TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    IF p_permalink IS NULL OR p_permalink !~ '^https://' OR char_length(p_permalink) > 500 THEN RETURN false; END IF;
    UPDATE public.hub_messages m SET permalink = p_permalink WHERE m.destination_id = p_destination AND m.msg_key_hmac = p_msg_key AND m.permalink IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;

-- ------------------------------------------------------------
-- 5. Status, capabilities (full group ingestion), re-check
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_svc_resolve(p_server_secret TEXT, p_provider TEXT, p_ext_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    RETURN (SELECT jsonb_build_object('id', d.id, 'projectId', d.project_id, 'projectName', p.name, 'status', d.status, 'label', d.label,
                                      'notify', d.notify, 'interactive', d.interactive, 'intelligence', d.intelligence, 'fullIngest', d.full_ingest,
                                      'extRefEnc', d.ext_ref_enc, 'installationId', d.installation_id)
              FROM public.hub_destinations d JOIN public.projects p ON p.id = d.project_id
             WHERE d.provider = p_provider AND d.ext_key_hmac = p_ext_key);
END $$;

CREATE OR REPLACE FUNCTION public.hub_project_status(p_server_secret TEXT, p_project_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    v_role TEXT := public.project_role_of(p_project_id, v_uid);
    v_manage BOOLEAN;
BEGIN
    IF v_role IS NULL THEN RAISE EXCEPTION 'K projektu nemáte přístup.' USING ERRCODE = '42501'; END IF;
    v_manage := v_role IN ('owner', 'admin');
    RETURN jsonb_build_object(
        'canManage', v_manage,
        'destinations', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', d.id, 'provider', d.provider, 'label', d.label, 'kind', d.kind, 'status', d.status, 'notify', d.notify,
            'interactive', d.interactive, 'intelligence', d.intelligence, 'fullIngest', d.full_ingest, 'eventTypes', to_jsonb(d.event_types), 'linkedBy', d.linked_by_label,
            'lastErrorCode', d.last_error_code, 'createdAt', d.created_at, 'confirmedAt', d.confirmed_at,
            'messages', (SELECT count(*) FROM public.hub_messages m WHERE m.destination_id = d.id))
            ORDER BY d.created_at) FROM public.hub_destinations d WHERE d.project_id = p_project_id), '[]'::jsonb),
        'pendingCodes', CASE WHEN v_manage THEN (SELECT count(*) FROM public.hub_link_codes c WHERE c.project_id = p_project_id AND c.purpose = 'destination'
                                                   AND c.consumed_at IS NULL AND c.expires_at > now()) ELSE 0 END,
        -- only workspaces this project uses or the caller installed (never other tenants' workspace names)
        'slackWorkspaces', CASE WHEN v_manage THEN coalesce((SELECT jsonb_agg(jsonb_build_object('label', i.team_label, 'status', i.status) ORDER BY i.created_at)
                                                            FROM public.hub_slack_installations i
                                                           WHERE i.installed_by = v_uid OR EXISTS (SELECT 1 FROM public.hub_destinations x WHERE x.installation_id = i.id AND x.project_id = p_project_id)), '[]'::jsonb)
                                ELSE '[]'::jsonb END,
        'audit', CASE WHEN v_manage THEN coalesce((SELECT jsonb_agg(jsonb_build_object('action', a.action, 'detail', a.detail, 'actorKind', a.actor_kind,
                                                       'actor', (SELECT p.display_name FROM public.profiles p WHERE p.id = a.actor_user_id), 'at', a.created_at) ORDER BY a.created_at DESC)
                                                   FROM (SELECT * FROM public.hub_audit x WHERE x.project_id = p_project_id ORDER BY x.created_at DESC LIMIT 30) a), '[]'::jsonb)
                      ELSE '[]'::jsonb END);
END $$;

DROP FUNCTION IF EXISTS public.hub_destination_configure(text, uuid, boolean, boolean, boolean, boolean, text[]);
CREATE OR REPLACE FUNCTION public.hub_destination_configure(p_server_secret TEXT, p_destination UUID, p_notify BOOLEAN, p_interactive BOOLEAN,
                                                            p_intelligence BOOLEAN, p_intelligence_ack BOOLEAN, p_event_types TEXT[], p_full_ingest BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    d public.hub_destinations%ROWTYPE;
    v_full BOOLEAN := coalesce(p_full_ingest, false) AND coalesce(p_intelligence, false);
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cíl neexistuje.' USING ERRCODE = '22023'; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF d.status = 'pending' THEN RAISE EXCEPTION 'Cíl nejdřív potvrďte.' USING ERRCODE = '22023'; END IF;
    IF p_event_types IS NULL OR NOT (p_event_types <@ ARRAY['task_created', 'task_completed', 'status_changed', 'due_soon']) THEN
        RAISE EXCEPTION 'Neplatné typy událostí.' USING ERRCODE = '22023';
    END IF;
    IF v_full AND d.provider <> 'telegram' THEN RAISE EXCEPTION 'Celou komunikaci lze zapnout jen u Telegram skupiny.' USING ERRCODE = '22023'; END IF;
    IF ((coalesce(p_intelligence, false) AND NOT d.intelligence) OR (v_full AND NOT d.full_ingest)) AND NOT coalesce(p_intelligence_ack, false) THEN
        RAISE EXCEPTION 'Zapnutí Project Intelligence vyžaduje výslovné potvrzení.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.hub_destinations
       SET notify = coalesce(p_notify, false), interactive = coalesce(p_interactive, false), intelligence = coalesce(p_intelligence, false), full_ingest = v_full,
           intelligence_confirmed_by = CASE WHEN coalesce(p_intelligence, false) AND (NOT d.intelligence OR (v_full AND NOT d.full_ingest)) THEN v_uid
                                            WHEN NOT coalesce(p_intelligence, false) THEN NULL ELSE intelligence_confirmed_by END,
           intelligence_confirmed_at = CASE WHEN coalesce(p_intelligence, false) AND (NOT d.intelligence OR (v_full AND NOT d.full_ingest)) THEN now()
                                            WHEN NOT coalesce(p_intelligence, false) THEN NULL ELSE intelligence_confirmed_at END,
           event_types = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(p_event_types) t), updated_at = now()
     WHERE id = d.id;
    -- switching Project Intelligence off deletes what was imported for it (it must not stay readable anywhere)
    IF d.intelligence AND NOT coalesce(p_intelligence, false) THEN
        DELETE FROM public.hub_messages m WHERE m.destination_id = d.id AND m.kind = 'ingested';
    END IF;
    UPDATE public.hub_outbox o SET status = 'cancelled', last_error_code = 'capability_off', updated_at = now()
     WHERE o.destination_id = d.id AND o.status = 'pending'
       AND ((o.kind = 'comment_sync' AND NOT coalesce(p_interactive, false))
         OR (o.kind <> 'comment_sync' AND (NOT coalesce(p_notify, false) OR NOT (o.kind = ANY (p_event_types)) AND o.kind <> 'test')));
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_configured',
        'notify=' || coalesce(p_notify, false)::text || ',interactive=' || coalesce(p_interactive, false)::text || ',intelligence=' || coalesce(p_intelligence, false)::text
        || ',full=' || v_full::text);
END $$;

-- Test message / re-check: an active destination, or one the provider had cut off (bot removed, archived, error) -- a successful send
-- re-activates it (bot added back). A revoked workspace needs a reinstall, a pending one a confirmation.
CREATE OR REPLACE FUNCTION public.hub_destination_target(p_server_secret TEXT, p_destination UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    d public.hub_destinations%ROWTYPE;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cíl neexistuje.' USING ERRCODE = '22023'; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF d.status NOT IN ('active', 'removed_bot', 'archived', 'error', 'revoked') THEN RAISE EXCEPTION 'Cíl není aktivní.' USING ERRCODE = '22023'; END IF;
    IF d.provider = 'slack' AND NOT EXISTS (SELECT 1 FROM public.hub_slack_installations i WHERE i.id = d.installation_id AND i.status = 'active') THEN
        RAISE EXCEPTION 'Přístup aplikace byl zrušen. Nainstalujte Slack aplikaci znovu.' USING ERRCODE = '22023';
    END IF;
    IF d.last_test_at > now() - interval '30 seconds' THEN RAISE EXCEPTION 'Zkušební zprávu lze poslat jednou za 30 sekund.' USING ERRCODE = 'PT429'; END IF;
    UPDATE public.hub_destinations SET last_test_at = now() WHERE id = d.id;
    RETURN jsonb_build_object('id', d.id, 'provider', d.provider, 'status', d.status, 'extRefEnc', d.ext_ref_enc, 'installationId', d.installation_id,
                              'installationEnc', (SELECT i.secret_enc FROM public.hub_slack_installations i WHERE i.id = d.installation_id AND i.status = 'active'),
                              'projectName', (SELECT p.name FROM public.projects p WHERE p.id = d.project_id), 'projectId', d.project_id);
END $$;

CREATE OR REPLACE FUNCTION public.hub_destination_mark_user(p_server_secret TEXT, p_destination UUID, p_status TEXT, p_error TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret); d public.hub_destinations%ROWTYPE;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF p_status NOT IN ('active', 'removed_bot', 'revoked', 'archived', 'error') OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    -- re-activation only after a send that the server just proved (hub_destination_target + provider "sent"); never a pending or revoked one
    IF p_status = 'active' AND (d.status = 'pending' OR d.last_test_at IS NULL OR d.last_test_at < now() - interval '2 minutes'
                                OR (d.provider = 'slack' AND NOT EXISTS (SELECT 1 FROM public.hub_slack_installations i WHERE i.id = d.installation_id AND i.status = 'active'))) THEN RETURN; END IF;
    UPDATE public.hub_destinations SET status = CASE WHEN status = 'pending' THEN status ELSE p_status END, last_error_code = CASE WHEN p_status = 'active' THEN NULL ELSE p_error END,
           updated_at = now() WHERE id = d.id;
    IF p_status = 'active' AND d.status <> 'active' THEN
        PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_reactivated', 'provider=' || d.provider);
    END IF;
END $$;

-- ------------------------------------------------------------
-- 6. Scheduler: also hands due inbound work to the app; stale replies are never re-sent
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_dispatch_prepare(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := coalesce(p_now, now());
    v_today DATE := (coalesce(p_now, now()) AT TIME ZONE 'Europe/Prague')::date;
    v_amb INTEGER := 0; v_due INTEGER := 0; v_purged INTEGER := 0; v_replies INTEGER := 0;
BEGIN
    UPDATE public.hub_outbox SET status = 'failed', last_error_code = 'ambiguous', lease_until = NULL, updated_at = now() WHERE status = 'sending' AND lease_until < now();
    GET DIAGNOSTICS v_amb = ROW_COUNT;
    -- an interrupted reply may have reached the chat: finish without re-sending (at most once outbound)
    UPDATE public.hub_inbox SET status = 'completed', payload = NULL, lease_until = NULL, last_error_code = 'reply_ambiguous', updated_at = now()
     WHERE status = 'replying' AND lease_until < now();
    GET DIAGNOSTICS v_replies = ROW_COUNT;
    INSERT INTO public.hub_outbox (destination_id, kind, dedupe_key, card_id, due_date)
    SELECT d.id, 'due_soon', 'd:' || k.id || ':' || public.iso_date_or_null(k.due_date)::text, k.id, public.iso_date_or_null(k.due_date)
      FROM public.hub_destinations d
      JOIN public.cards k ON k.project_id = d.project_id
     WHERE d.status = 'active' AND d.notify AND 'due_soon' = ANY (d.event_types)
       AND k.due_date IN (to_char(v_today, 'YYYY-MM-DD'), to_char(v_today + 1, 'YYYY-MM-DD'))
       AND public.iso_date_or_null(k.due_date) IS NOT NULL
       AND v_now >= public.notify_due_window_start(public.iso_date_or_null(k.due_date))
       AND v_now < public.notify_due_window_end(public.iso_date_or_null(k.due_date))
       AND NOT coalesce(k.archived, false) AND NOT public.collab_is_done_column(k.column_id)
    ON CONFLICT (destination_id, dedupe_key) DO NOTHING;
    GET DIAGNOSTICS v_due = ROW_COUNT;
    DELETE FROM public.hub_outbox WHERE status IN ('sent', 'failed', 'cancelled') AND updated_at < now() - interval '30 days';
    DELETE FROM public.hub_inbox WHERE status IN ('completed', 'failed') AND updated_at < now() - interval '7 days';
    UPDATE public.hub_inbox SET status = 'failed', payload = NULL, lease_until = NULL, last_error_code = 'expired', updated_at = now()
     WHERE status NOT IN ('completed', 'failed') AND received_at < now() - interval '2 days';
    DELETE FROM public.hub_messages WHERE retain_until IS NOT NULL AND retain_until < now();
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    DELETE FROM public.hub_link_codes WHERE expires_at < now() - interval '1 day';
    DELETE FROM public.hub_destinations WHERE status = 'pending' AND created_at < now() - interval '24 hours';   -- unconfirmed links expire
    RETURN jsonb_build_object('ambiguous', v_amb, 'dueQueued', v_due, 'purgedMessages', v_purged, 'ambiguousReplies', v_replies);
END $$;

CREATE OR REPLACE FUNCTION public.hub_scheduler_tick(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    run public.hub_dispatch_runs%ROWTYPE;
    v_found BOOLEAN; v_status INTEGER; v_content TEXT;
    v_applied INTEGER := 0; v_disabled INTEGER := 0; v_n INTEGER; v_inbound INTEGER := 0;
    v_prep JSONB; v_url TEXT; v_secret TEXT; v_items JSONB; v_ids UUID[]; v_req BIGINT;
BEGIN
    IF to_regclass('net._http_response') IS NOT NULL THEN
        FOR run IN SELECT * FROM public.hub_dispatch_runs ORDER BY created_at LOOP
            v_found := NULL;
            EXECUTE 'SELECT true, r.status_code, r.content FROM net._http_response r WHERE r.id = $1' INTO v_found, v_status, v_content USING run.request_id;
            IF v_found IS NULL THEN
                IF run.created_at < now() - interval '15 minutes' THEN DELETE FROM public.hub_dispatch_runs WHERE request_id = run.request_id; END IF;
                CONTINUE;
            END IF;
            IF v_status = 200 THEN
                BEGIN v_applied := v_applied + public.hub_dispatch_apply(v_content::jsonb -> 'results'); EXCEPTION WHEN OTHERS THEN NULL; END;
            ELSIF v_status = 503 THEN
                UPDATE public.hub_outbox o SET status = 'cancelled', last_error_code = 'provider_disabled', lease_until = NULL, updated_at = now()
                 WHERE o.id = ANY (run.outbox_ids) AND o.status = 'sending';
                GET DIAGNOSTICS v_n = ROW_COUNT; v_disabled := v_disabled + v_n;
            END IF;
            DELETE FROM public.hub_dispatch_runs WHERE request_id = run.request_id;
        END LOOP;
    END IF;
    v_prep := public.hub_dispatch_prepare(p_now);
    IF to_regclass('vault.decrypted_secrets') IS NULL OR to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'scheduler', 'not_configured');
    END IF;
    EXECUTE $q$SELECT (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'clearspace_hub_url'),
                      (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'clearspace_hub_secret')$q$ INTO v_url, v_secret;
    IF v_url IS NULL OR v_secret IS NULL OR (v_url !~ '^https://' AND v_url !~ '^http://(host\.docker\.internal|127\.0\.0\.1|localhost)(:[0-9]+)?/') THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'scheduler', 'not_configured');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'destinationId', c.destination_id, 'provider', c.provider, 'extRef', c.ext_ref_enc,
                                        'installationId', c.installation_id, 'installation', c.installation_enc, 'kind', c.kind, 'attempt', c.attempts,
                                        'cardId', c.card_id, 'title', c.title, 'projectId', c.project_id, 'projectName', c.project_name, 'column', c.column_name,
                                        'actor', c.actor_name, 'comment', c.comment_text, 'commentAuthor', c.comment_author, 'threadRef', c.thread_ref, 'dueDate', c.due_date)),
           array_agg(c.id)
      INTO v_items, v_ids
      FROM public.hub_dispatch_claim(20, 300, p_now) c;
    SELECT count(*) INTO v_inbound FROM public.hub_inbox i
     WHERE (i.status = 'received' AND i.received_at < now() - interval '30 seconds') OR (i.status = 'retry' AND i.next_attempt_at <= now())
        OR (i.status = 'processing' AND i.lease_until < now());
    IF v_ids IS NULL AND v_inbound = 0 THEN RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'inbound', 0); END IF;
    EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' INTO v_req
      USING v_url, jsonb_build_object('items', coalesce(v_items, '[]'::jsonb), 'inbound', v_inbound > 0, 'now', p_now),
            jsonb_build_object('content-type', 'application/json', 'x-hub-secret', v_secret);
    INSERT INTO public.hub_dispatch_runs (request_id, outbox_ids) VALUES (v_req, coalesce(v_ids, '{}'));
    RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', coalesce(cardinality(v_ids), 0), 'inbound', v_inbound, 'request', v_req);
END $$;


-- ------------------------------------------------------------
-- 7. Review fixes (RUN 07B): one conversation per thread, origin-only loop guard, no silent cross-tenant re-activation
-- ------------------------------------------------------------
-- A thread belongs to the FIRST task created from it; a second task from the same thread is created but not linked (replies stay unambiguous).
CREATE OR REPLACE FUNCTION public.hub_svc_attach_conversation(p_server_secret TEXT, p_destination UUID, p_card TEXT, p_thread_key TEXT, p_thread_ref TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID; v_card TEXT; d public.hub_destinations%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination AND x.status = 'active';
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.cards k WHERE k.id = p_card AND k.project_id = d.project_id) THEN RETURN NULL; END IF;
    INSERT INTO public.hub_conversations (destination_id, card_id, thread_key_hmac, thread_ref, created_by)
    VALUES (d.id, p_card, p_thread_key, p_thread_ref, (SELECT a.actor_id FROM public.activity_logs a WHERE a.card_id = p_card AND a.action_type = 'card_created' LIMIT 1))
    ON CONFLICT (destination_id, thread_key_hmac) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        SELECT c.id, c.card_id INTO v_id, v_card FROM public.hub_conversations c WHERE c.destination_id = d.id AND c.thread_key_hmac = p_thread_key;
        IF v_card IS DISTINCT FROM p_card THEN RETURN NULL; END IF;
    END IF;
    UPDATE public.hub_messages SET conversation_id = v_id WHERE card_id = p_card AND destination_id = d.id AND kind = 'task_source' AND conversation_id IS NULL;
    RETURN v_id;
END $$;

-- 'on' = suppress everything (RUN 07 behaviour); a destination id = suppress only that destination (it already got its own confirmation)
CREATE OR REPLACE FUNCTION public.hub_from_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_kind TEXT; v_origin TEXT := coalesce(current_setting('clearspace.hub_inbound', true), '');
BEGIN
    BEGIN
        IF v_origin = 'on' OR NEW.card_id IS NULL THEN RETURN NULL; END IF;
        IF NEW.action_type = 'card_created' THEN v_kind := 'task_created';
        ELSIF NEW.action_type = 'card_moved' AND NEW.details ->> 'completed' = 'true' THEN v_kind := 'task_completed';
        ELSIF NEW.action_type = 'card_moved' THEN v_kind := 'status_changed';
        ELSE RETURN NULL;
        END IF;
        INSERT INTO public.hub_outbox (destination_id, kind, dedupe_key, card_id, activity_id)
        SELECT d.id, v_kind, 'a:' || NEW.id, NEW.card_id, NEW.id
          FROM public.hub_destinations d
         WHERE d.project_id = NEW.project_id AND d.status = 'active' AND d.notify AND v_kind = ANY (d.event_types) AND d.id::text <> v_origin
        ON CONFLICT (destination_id, dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.hub_from_comment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_origin TEXT := coalesce(current_setting('clearspace.hub_inbound', true), '');
BEGIN
    BEGIN
        IF v_origin = 'on' THEN RETURN NULL; END IF;
        INSERT INTO public.hub_outbox (destination_id, kind, dedupe_key, card_id, comment_id, conversation_id)
        SELECT cv.destination_id, 'comment_sync', 'c:' || NEW.id || ':' || cv.id, NEW.card_id, NEW.id, cv.id
          FROM public.hub_conversations cv JOIN public.hub_destinations d ON d.id = cv.destination_id
         WHERE cv.card_id = NEW.card_id AND d.status = 'active' AND d.interactive AND d.id::text <> v_origin
           AND EXISTS (SELECT 1 FROM public.cards k WHERE k.id = NEW.card_id AND k.project_id = d.project_id)
        ON CONFLICT (destination_id, dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NULL;
END $$;

-- A reinstall restores the workspace token only; destinations cut off by a revocation are re-checked by their own project managers.
CREATE OR REPLACE FUNCTION public.hub_slack_install_store(p_server_secret TEXT, p_installation UUID, p_team_hmac TEXT, p_team_label TEXT, p_secret_enc TEXT, p_scopes TEXT[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret); v_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.hub_link_codes c WHERE c.purpose = 'slack_install' AND c.created_by = v_uid AND c.consumed_at > now() - interval '5 minutes') THEN
        RAISE EXCEPTION 'Instalace Slacku vypršela. Zkuste to prosím znovu.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.hub_slack_installations (id, team_hmac, team_label, secret_enc, scopes, installed_by)
    VALUES (p_installation, p_team_hmac, p_team_label, p_secret_enc, p_scopes, v_uid)
    ON CONFLICT (team_hmac) DO UPDATE SET team_label = EXCLUDED.team_label, secret_enc = EXCLUDED.secret_enc, scopes = EXCLUDED.scopes, status = 'active',
                                          installed_by = EXCLUDED.installed_by, updated_at = now()
    RETURNING id INTO v_id;
    IF v_id <> p_installation THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    PERFORM public.hub_audit_add(NULL, NULL, v_uid, 'user', 'slack_installed', NULL);
    RETURN v_id;
END $$;

-- ------------------------------------------------------------
-- Grants
-- ------------------------------------------------------------
DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY['hub_dispatch_prepare(timestamp with time zone)', 'hub_scheduler_tick(timestamp with time zone)', 'hub_from_activity()', 'hub_from_comment()'] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    END LOOP;
    FOREACH f IN ARRAY ARRAY['hub_svc_inbox_receive(text,text,text,jsonb)', 'hub_svc_inbox_claim(text,uuid,integer)', 'hub_svc_inbox_replying(text,uuid)',
        'hub_svc_inbox_done(text,uuid,text,text)', 'hub_svc_inbox_due(text,integer)', 'hub_svc_link_destination(text,uuid,text,text,text,text,text,text,uuid,text)', 'hub_svc_burn_code(text,text,text)',
        'hub_svc_attach_conversation(text,uuid,text,text,text)', 'hub_slack_install_store(text,uuid,text,text,text,text[])',
        'hub_identity_begin(text,text,text)', 'hub_svc_identity_complete(text,text,text,text,text)',
        'hub_svc_create_task(text,uuid,text,text,text,text,text,text,text,timestamp with time zone)',
        'hub_svc_inbound_message(text,uuid,text,text,text,text,text,text,timestamp with time zone,boolean)', 'hub_svc_message_permalink(text,uuid,text,text)',
        'hub_svc_resolve(text,text,text)', 'hub_project_status(text,text)', 'hub_destination_configure(text,uuid,boolean,boolean,boolean,boolean,text[],boolean)',
        'hub_destination_target(text,uuid)', 'hub_destination_mark_user(text,uuid,text,text)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261201001700_hub_hardening') ON CONFLICT (version) DO NOTHING;
