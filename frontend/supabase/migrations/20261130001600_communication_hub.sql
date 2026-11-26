-- ============================================================
-- 20261130001600 -- Project Communication Hub: Slack channels / Telegram groups bound to projects (RUN 07)
--
-- Apply AFTER 20261129001500, in a transaction. Idempotent. Rollback: supabase/rollback/20261130001600_communication_hub.down.sql.
-- ADDITIVE ONLY: no existing table, function or trigger changes. The two new triggers (activity_logs, task_comments) only queue work for
-- projects with an ACTIVE destination -- none exists until the feature is switched on -- and swallow every error. Nothing is scheduled and
-- no extension is installed here (supabase/ops/hub_scheduler_enable.sql). Architecture / threat model: docs/run07/.
--
--   1. tables (RLS on; clients read only hub_messages + hub_comment_links of their own projects)
--   2. helpers: server secret 'hub' + the dedicated SERVICE PRINCIPAL (webhooks have no user; no service-role key, no anonymous RPC)
--   3. RPCs for signed-in users (authenticated + server secret): status, link codes, confirm, configure, remove, identity, Slack install
--   4. RPCs for the service principal (webhooks): inbox dedupe, link, resolve, identity, create task, inbound message, state changes
--   5. outbound queue triggers + INTERNAL scheduler (hub_scheduler_tick -> pg_net -> /api/hub/dispatch)
-- ============================================================

DO $$
DECLARE v_missing TEXT := '';
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261129001500_notification_channels') THEN
        v_missing := v_missing || ' migration:20261129001500_notification_channels(apply it first)';
    END IF;
    IF to_regprocedure('public.require_server_secret(text,text)') IS NULL THEN v_missing := v_missing || ' fn:require_server_secret'; END IF;
    IF to_regprocedure('public.project_role_of(text,uuid)') IS NULL THEN v_missing := v_missing || ' fn:project_role_of'; END IF;
    IF to_regprocedure('public.is_project_member(text)') IS NULL THEN v_missing := v_missing || ' fn:is_project_member'; END IF;
    IF to_regprocedure('public.collab_is_done_column(text)') IS NULL THEN v_missing := v_missing || ' fn:collab_is_done_column'; END IF;
    IF to_regprocedure('public.notify_due_window_start(date)') IS NULL THEN v_missing := v_missing || ' fn:notify_due_window_start'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- communication hub cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hub_service_principal (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    registered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hub_slack_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_hmac TEXT NOT NULL UNIQUE CHECK (team_hmac ~ '^[0-9a-f]{64}$'),
    team_label TEXT NOT NULL CHECK (char_length(team_label) BETWEEN 1 AND 200 AND team_label !~ '[[:cntrl:]]'),
    -- AES-256-GCM envelope (server key), AAD = installation id: {botToken, botUserId, appId}
    secret_enc TEXT NOT NULL CHECK (secret_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND char_length(secret_enc) <= 4096),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) <= 20),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    installed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hub_destinations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    installation_id UUID REFERENCES public.hub_slack_installations(id) ON DELETE CASCADE,
    -- HMAC(server secret, workspace + channel) / HMAC(chat id): routing key, globally unique => one channel/group = one project
    ext_key_hmac TEXT NOT NULL CHECK (ext_key_hmac ~ '^[0-9a-f]{64}$'),
    ext_ref_enc TEXT NOT NULL CHECK (ext_ref_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND char_length(ext_ref_enc) <= 4096),
    label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND label !~ '[[:cntrl:]]'),
    kind TEXT NOT NULL CHECK (kind IN ('slack_channel', 'telegram_group', 'telegram_supergroup')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'removed_bot', 'revoked', 'archived', 'error')),
    notify BOOLEAN NOT NULL DEFAULT true,
    interactive BOOLEAN NOT NULL DEFAULT false,
    intelligence BOOLEAN NOT NULL DEFAULT false,
    intelligence_confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    intelligence_confirmed_at TIMESTAMP WITH TIME ZONE,
    event_types TEXT[] NOT NULL DEFAULT ARRAY['task_created', 'task_completed', 'status_changed', 'due_soon']
        CHECK (event_types <@ ARRAY['task_created', 'task_completed', 'status_changed', 'due_soon']),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
    last_test_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (provider, ext_key_hmac),
    CONSTRAINT hub_destinations_slack_install CHECK ((provider = 'slack') = (installation_id IS NOT NULL)),
    CONSTRAINT hub_destinations_intelligence_confirmed CHECK (NOT intelligence OR intelligence_confirmed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS hub_destinations_project ON public.hub_destinations (project_id);

CREATE TABLE IF NOT EXISTS public.hub_link_codes (
    code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    purpose TEXT NOT NULL CHECK (purpose IN ('destination', 'identity', 'slack_install')),
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE,
    created_by UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    ext_user_hmac TEXT CHECK (ext_user_hmac IS NULL OR ext_user_hmac ~ '^[0-9a-f]{64}$'),
    ext_label TEXT CHECK (ext_label IS NULL OR (char_length(ext_label) <= 200 AND ext_label !~ '[[:cntrl:]]')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    CONSTRAINT hub_link_codes_shape CHECK (
        (purpose = 'destination' AND project_id IS NOT NULL AND created_by IS NOT NULL)
     OR (purpose = 'identity' AND ext_user_hmac IS NOT NULL)
     OR (purpose = 'slack_install' AND provider = 'slack' AND created_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.hub_identities (
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    ext_user_hmac TEXT NOT NULL CHECK (ext_user_hmac ~ '^[0-9a-f]{64}$'),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    label TEXT CHECK (label IS NULL OR (char_length(label) <= 200 AND label !~ '[[:cntrl:]]')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, ext_user_hmac)
);
CREATE INDEX IF NOT EXISTS hub_identities_user ON public.hub_identities (user_id);

CREATE TABLE IF NOT EXISTS public.hub_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id UUID NOT NULL REFERENCES public.hub_destinations(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
    thread_key_hmac TEXT NOT NULL CHECK (thread_key_hmac ~ '^[0-9a-f]{64}$'),
    thread_ref TEXT NOT NULL CHECK (thread_ref ~ '^[0-9.]{1,40}$'),     -- Slack thread ts / Telegram message id of the bot's confirmation
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (destination_id, thread_key_hmac)
);
CREATE INDEX IF NOT EXISTS hub_conversations_card ON public.hub_conversations (card_id);

CREATE TABLE IF NOT EXISTS public.hub_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    destination_id UUID REFERENCES public.hub_destinations(id) ON DELETE SET NULL,
    destination_label TEXT NOT NULL CHECK (char_length(destination_label) BETWEEN 1 AND 200),
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    card_id TEXT REFERENCES public.cards(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES public.hub_conversations(id) ON DELETE SET NULL,
    msg_key_hmac TEXT NOT NULL CHECK (msg_key_hmac ~ '^[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('task_source', 'thread_reply', 'ingested')),
    author_label TEXT NOT NULL CHECK (char_length(author_label) BETWEEN 1 AND 200 AND author_label !~ '[[:cntrl:]]'),
    author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified BOOLEAN NOT NULL DEFAULT false,
    text TEXT NOT NULL CHECK (char_length(text) <= 4000),
    permalink TEXT CHECK (permalink IS NULL OR (char_length(permalink) <= 500 AND permalink ~ '^https://')),
    sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
    edited_at TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE,
    retain_until TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (project_id, msg_key_hmac)
);
CREATE INDEX IF NOT EXISTS hub_messages_project ON public.hub_messages (project_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS hub_messages_card ON public.hub_messages (card_id) WHERE card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.hub_comment_links (
    comment_id TEXT PRIMARY KEY REFERENCES public.task_comments(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    message_id UUID REFERENCES public.hub_messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hub_inbox (
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    event_key TEXT NOT NULL CHECK (char_length(event_key) BETWEEN 1 AND 200),
    received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_key)
);

CREATE TABLE IF NOT EXISTS public.hub_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    destination_id UUID NOT NULL REFERENCES public.hub_destinations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('task_created', 'task_completed', 'status_changed', 'due_soon', 'comment_sync', 'test')),
    dedupe_key TEXT NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 300),
    card_id TEXT,
    activity_id TEXT,
    comment_id TEXT,
    conversation_id UUID REFERENCES public.hub_conversations(id) ON DELETE CASCADE,
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    lease_until TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (destination_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS hub_outbox_due ON public.hub_outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.hub_dispatch_runs (
    request_id BIGINT PRIMARY KEY,
    outbox_ids UUID[] NOT NULL CHECK (cardinality(outbox_ids) BETWEEN 1 AND 100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.hub_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE,
    destination_id UUID,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service')),
    action TEXT NOT NULL CHECK (action ~ '^[a-z_]{1,48}$'),
    detail TEXT CHECK (detail IS NULL OR detail ~ '^[a-z0-9_:,=-]{1,200}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_audit_project ON public.hub_audit (project_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['hub_service_principal', 'hub_slack_installations', 'hub_destinations', 'hub_link_codes', 'hub_identities',
                             'hub_conversations', 'hub_messages', 'hub_comment_links', 'hub_inbox', 'hub_outbox', 'hub_dispatch_runs', 'hub_audit']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END $$;
-- Clients may READ the communication records of projects they belong to (the Communication view); nothing else.
DROP POLICY IF EXISTS "Members read project communication" ON public.hub_messages;
CREATE POLICY "Members read project communication" ON public.hub_messages FOR SELECT TO authenticated USING (public.is_project_member(project_id));
GRANT SELECT (id, project_id, destination_id, destination_label, provider, card_id, conversation_id, kind, author_label, author_user_id, verified,
              text, permalink, sent_at, edited_at, deleted_at, created_at) ON public.hub_messages TO authenticated;
DROP POLICY IF EXISTS "Members read comment sources" ON public.hub_comment_links;
CREATE POLICY "Members read comment sources" ON public.hub_comment_links FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.task_comments c JOIN public.cards k ON k.id = c.card_id WHERE c.id = comment_id AND public.is_project_member(k.project_id)));
GRANT SELECT (comment_id, direction, provider) ON public.hub_comment_links TO authenticated;

-- Project Intelligence reads ONLY this view: active destinations with intelligence switched on, not deleted. Invoker rights => RLS of
-- hub_messages (project members) still applies. Disconnect / switch-off removes the rows from it at once.
CREATE OR REPLACE VIEW public.hub_intelligence_messages WITH (security_invoker = true) AS
    SELECT m.id, m.project_id, m.provider, m.destination_label, m.card_id, m.kind, m.author_label, m.verified, m.text, m.permalink, m.sent_at
      FROM public.hub_messages m
      JOIN public.hub_destinations d ON d.id = m.destination_id
     WHERE d.status = 'active' AND d.intelligence AND m.deleted_at IS NULL;
REVOKE ALL ON public.hub_intelligence_messages FROM PUBLIC, anon;
GRANT SELECT ON public.hub_intelligence_messages TO authenticated;
-- the view joins hub_destinations under the CALLER's rights: members need to see the two flags of their project's destinations
DROP POLICY IF EXISTS "Members see destination flags" ON public.hub_destinations;
CREATE POLICY "Members see destination flags" ON public.hub_destinations FOR SELECT TO authenticated USING (public.is_project_member(project_id));
GRANT SELECT (id, project_id, status, intelligence) ON public.hub_destinations TO authenticated;

-- ------------------------------------------------------------
-- 2. Helpers (internal)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_require_user(p_server_secret TEXT)
RETURNS UUID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('hub', p_server_secret);
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    IF EXISTS (SELECT 1 FROM public.hub_service_principal s WHERE s.user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Servisní identita nemá uživatelská práva.' USING ERRCODE = '42501';
    END IF;
    RETURN auth.uid();
END $$;

-- Webhooks: the caller must BE the registered service principal AND present the server secret.
CREATE OR REPLACE FUNCTION public.hub_require_service(p_server_secret TEXT)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('hub', p_server_secret);
    IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.hub_service_principal s WHERE s.user_id = auth.uid()) THEN
        RAISE EXCEPTION 'Tato operace je vyhrazena serveru.' USING ERRCODE = '42501';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.hub_require_manager(p_project_id TEXT, p_uid UUID)
RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF coalesce(public.project_role_of(p_project_id, p_uid), '') NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'Integrace projektu spravuje jen vlastník nebo správce projektu.' USING ERRCODE = '42501';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.hub_audit_add(p_project TEXT, p_destination UUID, p_actor UUID, p_kind TEXT, p_action TEXT, p_detail TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ INSERT INTO public.hub_audit (project_id, destination_id, actor_user_id, actor_kind, action, detail) VALUES (p_project, p_destination, p_actor, p_kind, p_action, p_detail) $$;

-- Run the rest of the transaction as a VERIFIED ClearSpace user (the mapped identity): RUN 01 triggers -- including the DEFERRED ones that
-- run at COMMIT (card/assignee events) -- see auth.uid() = that user and apply their rules (viewer guard, comment author, rate limits,
-- activity attribution). Only called by hub_svc_* as their LAST write step, after the permission checks; the request ends right after.
CREATE OR REPLACE FUNCTION public.hub_act_as(p_uid UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_prev JSONB := jsonb_build_object('claims', current_setting('request.jwt.claims', true), 'sub', current_setting('request.jwt.claim.sub', true));
BEGIN
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
    PERFORM set_config('clearspace.hub_inbound', 'on', true);       -- loop guard for the outbound triggers
    RETURN v_prev;
END $$;
-- ------------------------------------------------------------
-- 3. Signed-in users
-- ------------------------------------------------------------
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
            'interactive', d.interactive, 'intelligence', d.intelligence, 'eventTypes', to_jsonb(d.event_types),
            'lastErrorCode', d.last_error_code, 'createdAt', d.created_at, 'confirmedAt', d.confirmed_at,
            'messages', (SELECT count(*) FROM public.hub_messages m WHERE m.destination_id = d.id))
            ORDER BY d.created_at) FROM public.hub_destinations d WHERE d.project_id = p_project_id), '[]'::jsonb),
        'pendingCodes', CASE WHEN v_manage THEN (SELECT count(*) FROM public.hub_link_codes c WHERE c.project_id = p_project_id AND c.purpose = 'destination'
                                                   AND c.consumed_at IS NULL AND c.expires_at > now()) ELSE 0 END,
        'slackWorkspaces', CASE WHEN v_manage THEN coalesce((SELECT jsonb_agg(jsonb_build_object('label', i.team_label, 'status', i.status) ORDER BY i.created_at)
                                                            FROM public.hub_slack_installations i), '[]'::jsonb) ELSE '[]'::jsonb END,
        'audit', CASE WHEN v_manage THEN coalesce((SELECT jsonb_agg(jsonb_build_object('action', a.action, 'detail', a.detail, 'actorKind', a.actor_kind,
                                                       'actor', (SELECT p.display_name FROM public.profiles p WHERE p.id = a.actor_user_id), 'at', a.created_at) ORDER BY a.created_at DESC)
                                                   FROM (SELECT * FROM public.hub_audit x WHERE x.project_id = p_project_id ORDER BY x.created_at DESC LIMIT 30) a), '[]'::jsonb)
                      ELSE '[]'::jsonb END);
END $$;

-- A single-use code (only its SHA-256 is stored), valid 10 minutes, that a project manager hands to the channel / group.
CREATE OR REPLACE FUNCTION public.hub_link_begin(p_server_secret TEXT, p_project_id TEXT, p_provider TEXT, p_code_hash TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret);
BEGIN
    PERFORM public.hub_require_manager(p_project_id, v_uid);
    IF p_provider NOT IN ('slack', 'telegram') OR p_code_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    IF (SELECT count(*) FROM public.hub_link_codes c WHERE c.created_by = v_uid AND c.created_at > now() - interval '10 minutes') >= 10 THEN
        RAISE EXCEPTION 'Příliš mnoho kódů za krátkou dobu. Zkuste to prosím za chvíli.' USING ERRCODE = 'PT429';
    END IF;
    DELETE FROM public.hub_link_codes c WHERE c.expires_at < now() - interval '1 day';
    INSERT INTO public.hub_link_codes (code_hash, purpose, provider, project_id, created_by, expires_at)
    VALUES (p_code_hash, 'destination', p_provider, p_project_id, v_uid, now() + interval '10 minutes');
    PERFORM public.hub_audit_add(p_project_id, NULL, v_uid, 'user', 'link_code_issued', 'provider=' || p_provider);
END $$;

CREATE OR REPLACE FUNCTION public.hub_destination_decide(p_server_secret TEXT, p_destination UUID, p_accept BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    d public.hub_destinations%ROWTYPE;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cíl neexistuje.' USING ERRCODE = '22023'; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF d.status <> 'pending' THEN RETURN d.status; END IF;
    IF p_accept THEN
        UPDATE public.hub_destinations SET status = 'active', confirmed_by = v_uid, confirmed_at = now(), updated_at = now() WHERE id = d.id;
        PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_confirmed', 'provider=' || d.provider);
        RETURN 'active';
    END IF;
    DELETE FROM public.hub_destinations WHERE id = d.id;
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_rejected', 'provider=' || d.provider);
    RETURN 'removed';
END $$;

-- Capabilities. Project Intelligence needs an explicit acknowledgement (informed confirmation in the UI) every time it is switched on.
CREATE OR REPLACE FUNCTION public.hub_destination_configure(p_server_secret TEXT, p_destination UUID, p_notify BOOLEAN, p_interactive BOOLEAN,
                                                            p_intelligence BOOLEAN, p_intelligence_ack BOOLEAN, p_event_types TEXT[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    d public.hub_destinations%ROWTYPE;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cíl neexistuje.' USING ERRCODE = '22023'; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF p_event_types IS NULL OR NOT (p_event_types <@ ARRAY['task_created', 'task_completed', 'status_changed', 'due_soon']) THEN
        RAISE EXCEPTION 'Neplatné typy událostí.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(p_intelligence, false) AND NOT d.intelligence AND NOT coalesce(p_intelligence_ack, false) THEN
        RAISE EXCEPTION 'Zapnutí Project Intelligence vyžaduje výslovné potvrzení.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.hub_destinations
       SET notify = coalesce(p_notify, false), interactive = coalesce(p_interactive, false), intelligence = coalesce(p_intelligence, false),
           intelligence_confirmed_by = CASE WHEN coalesce(p_intelligence, false) AND NOT d.intelligence THEN v_uid
                                            WHEN NOT coalesce(p_intelligence, false) THEN NULL ELSE intelligence_confirmed_by END,
           intelligence_confirmed_at = CASE WHEN coalesce(p_intelligence, false) AND NOT d.intelligence THEN now()
                                            WHEN NOT coalesce(p_intelligence, false) THEN NULL ELSE intelligence_confirmed_at END,
           event_types = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(p_event_types) t), updated_at = now()
     WHERE id = d.id;
    -- switching notifications / interaction off drops what is queued for it (no stale messages later)
    UPDATE public.hub_outbox o SET status = 'cancelled', last_error_code = 'capability_off', updated_at = now()
     WHERE o.destination_id = d.id AND o.status = 'pending'
       AND ((o.kind = 'comment_sync' AND NOT coalesce(p_interactive, false))
         OR (o.kind <> 'comment_sync' AND (NOT coalesce(p_notify, false) OR NOT (o.kind = ANY (p_event_types)) AND o.kind <> 'test')));
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_configured',
        'notify=' || coalesce(p_notify, false)::text || ',interactive=' || coalesce(p_interactive, false)::text || ',intelligence=' || coalesce(p_intelligence, false)::text);
END $$;

-- Disconnect: the binding and its conversations go at once (Project Intelligence stops seeing anything immediately). Messages imported for
-- Project Intelligence are always deleted; task-linked records stay as history unless p_purge.
CREATE OR REPLACE FUNCTION public.hub_destination_remove(p_server_secret TEXT, p_destination UUID, p_purge BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    d public.hub_destinations%ROWTYPE;
    v_deleted INTEGER;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('removed', false); END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    DELETE FROM public.hub_messages m WHERE m.destination_id = d.id AND (m.kind = 'ingested' OR coalesce(p_purge, false));
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    DELETE FROM public.hub_destinations WHERE id = d.id;
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'user', 'destination_removed', 'provider=' || d.provider || ',purged=' || v_deleted);
    RETURN jsonb_build_object('removed', true, 'provider', d.provider, 'purgedMessages', v_deleted, 'extRefEnc', d.ext_ref_enc,
                              'installationEnc', (SELECT i.secret_enc FROM public.hub_slack_installations i WHERE i.id = d.installation_id), 'installationId', d.installation_id,
                              'status', d.status, 'label', d.label);
END $$;

-- Test message (manager, max 1 / 30 s): the target for the server to send to.
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
    IF d.status <> 'active' THEN RAISE EXCEPTION 'Cíl není aktivní.' USING ERRCODE = '22023'; END IF;
    IF d.last_test_at > now() - interval '30 seconds' THEN RAISE EXCEPTION 'Zkušební zprávu lze poslat jednou za 30 sekund.' USING ERRCODE = 'PT429'; END IF;
    UPDATE public.hub_destinations SET last_test_at = now() WHERE id = d.id;
    RETURN jsonb_build_object('id', d.id, 'provider', d.provider, 'extRefEnc', d.ext_ref_enc, 'installationId', d.installation_id,
                              'installationEnc', (SELECT i.secret_enc FROM public.hub_slack_installations i WHERE i.id = d.installation_id AND i.status = 'active'),
                              'projectName', (SELECT p.name FROM public.projects p WHERE p.id = d.project_id), 'projectId', d.project_id);
END $$;

CREATE OR REPLACE FUNCTION public.hub_destination_mark_user(p_server_secret TEXT, p_destination UUID, p_status TEXT, p_error TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret); d public.hub_destinations%ROWTYPE;
BEGIN
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination;
    IF NOT FOUND THEN RETURN; END IF;
    PERFORM public.hub_require_manager(d.project_id, v_uid);
    IF p_status NOT IN ('active', 'removed_bot', 'revoked', 'archived', 'error') OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.hub_destinations SET status = CASE WHEN status = 'pending' THEN status ELSE p_status END, last_error_code = p_error, updated_at = now() WHERE id = d.id;
END $$;

-- Identity: the signed-in user confirms the link they received privately in Slack / Telegram.
CREATE OR REPLACE FUNCTION public.hub_identity_confirm(p_server_secret TEXT, p_code_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := public.hub_require_user(p_server_secret);
    c public.hub_link_codes%ROWTYPE;
BEGIN
    UPDATE public.hub_link_codes x SET consumed_at = now()
     WHERE x.code_hash = p_code_hash AND x.purpose = 'identity' AND x.consumed_at IS NULL AND x.expires_at > now()
    RETURNING * INTO c;
    IF NOT FOUND THEN RAISE EXCEPTION 'Odkaz vypršel nebo už byl použit. Vyžádejte si v chatu nový.' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.hub_identities (provider, ext_user_hmac, user_id, label) VALUES (c.provider, c.ext_user_hmac, v_uid, c.ext_label)
    ON CONFLICT (provider, ext_user_hmac) DO UPDATE SET user_id = EXCLUDED.user_id, label = EXCLUDED.label, created_at = now();
    PERFORM public.hub_audit_add(NULL, NULL, v_uid, 'user', 'identity_linked', 'provider=' || c.provider);
    RETURN jsonb_build_object('provider', c.provider, 'label', c.ext_label);
END $$;

CREATE OR REPLACE FUNCTION public.hub_identities_mine(p_server_secret TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret);
BEGIN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('provider', i.provider, 'key', i.ext_user_hmac, 'label', i.label, 'createdAt', i.created_at) ORDER BY i.created_at)
                       FROM public.hub_identities i WHERE i.user_id = v_uid), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.hub_identity_remove(p_server_secret TEXT, p_provider TEXT, p_key TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret); v_n INTEGER;
BEGIN
    DELETE FROM public.hub_identities i WHERE i.user_id = v_uid AND i.provider = p_provider AND i.ext_user_hmac = p_key;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN PERFORM public.hub_audit_add(NULL, NULL, v_uid, 'user', 'identity_unlinked', 'provider=' || p_provider); END IF;
    RETURN v_n > 0;
END $$;

-- Slack workspace installation (OAuth v2 of the PROJECT app): state bound to the user + browser (hash of state.nonce), 10 min.
CREATE OR REPLACE FUNCTION public.hub_slack_install_begin(p_server_secret TEXT, p_state_hash TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret);
BEGIN
    IF p_state_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE public.project_role_of(p.id, v_uid) IN ('owner', 'admin')) THEN
        RAISE EXCEPTION 'Slack může nainstalovat jen vlastník nebo správce projektu.' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.hub_link_codes c WHERE c.created_by = v_uid AND c.created_at > now() - interval '10 minutes') >= 10 THEN
        RAISE EXCEPTION 'Příliš mnoho pokusů. Zkuste to prosím za chvíli.' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.hub_link_codes (code_hash, purpose, provider, created_by, expires_at) VALUES (p_state_hash, 'slack_install', 'slack', v_uid, now() + interval '10 minutes');
END $$;

CREATE OR REPLACE FUNCTION public.hub_slack_install_lookup(p_server_secret TEXT, p_state_hash TEXT, p_team_hmac TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_uid UUID := public.hub_require_user(p_server_secret); v_ok UUID;
BEGIN
    UPDATE public.hub_link_codes x SET consumed_at = now()
     WHERE x.code_hash = p_state_hash AND x.purpose = 'slack_install' AND x.created_by = v_uid AND x.consumed_at IS NULL AND x.expires_at > now()
    RETURNING created_by INTO v_ok;
    IF v_ok IS NULL THEN RETURN NULL; END IF;
    -- the id the credential envelope is sealed for (AAD): the workspace's existing installation, or a new one
    RETURN coalesce((SELECT i.id FROM public.hub_slack_installations i WHERE i.team_hmac = p_team_hmac), gen_random_uuid());
END $$;

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
    -- a reinstall reactivates destinations that a revocation of this workspace had cut off
    UPDATE public.hub_destinations SET status = 'active', last_error_code = NULL, updated_at = now() WHERE installation_id = v_id AND status = 'revoked';
    PERFORM public.hub_audit_add(NULL, NULL, v_uid, 'user', 'slack_installed', NULL);
    RETURN v_id;
END $$;

-- ------------------------------------------------------------
-- 4. Service principal (webhooks / interactivity; no user session)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_svc_inbox(p_server_secret TEXT, p_provider TEXT, p_event_key TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    INSERT INTO public.hub_inbox (provider, event_key) VALUES (p_provider, p_event_key) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n = 1;     -- false = already seen (provider retry / replay)
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_installation(p_server_secret TEXT, p_team_hmac TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    RETURN (SELECT jsonb_build_object('id', i.id, 'status', i.status, 'secretEnc', i.secret_enc) FROM public.hub_slack_installations i WHERE i.team_hmac = p_team_hmac);
END $$;

-- Bind a channel / group to the project of a valid code -> PENDING (a project manager confirms in ClearSpace).
CREATE OR REPLACE FUNCTION public.hub_svc_link_destination(p_server_secret TEXT, p_id UUID, p_code_hash TEXT, p_provider TEXT, p_ext_key TEXT, p_ext_ref_enc TEXT,
                                                           p_label TEXT, p_kind TEXT, p_installation UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    c public.hub_link_codes%ROWTYPE;
    v_existing public.hub_destinations%ROWTYPE;
    v_id UUID;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_link_codes x SET consumed_at = now()
     WHERE x.code_hash = p_code_hash AND x.purpose = 'destination' AND x.provider = p_provider AND x.consumed_at IS NULL AND x.expires_at > now()
    RETURNING * INTO c;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'code_invalid'); END IF;
    IF coalesce(public.project_role_of(c.project_id, c.created_by), '') NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'issuer_not_manager');
    END IF;
    SELECT * INTO v_existing FROM public.hub_destinations d WHERE d.provider = p_provider AND d.ext_key_hmac = p_ext_key;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', CASE WHEN v_existing.project_id = c.project_id THEN 'already_linked_here' ELSE 'linked_elsewhere' END);
    END IF;
    INSERT INTO public.hub_destinations (project_id, provider, installation_id, ext_key_hmac, ext_ref_enc, label, kind, created_by, id)
    VALUES (c.project_id, p_provider, p_installation, p_ext_key, p_ext_ref_enc, p_label, p_kind, c.created_by, p_id)
    RETURNING id INTO v_id;
    PERFORM public.hub_audit_add(c.project_id, v_id, NULL, 'service', 'destination_linked', 'provider=' || p_provider);
    RETURN jsonb_build_object('ok', true, 'destinationId', v_id, 'projectName', (SELECT p.name FROM public.projects p WHERE p.id = c.project_id));
END $$;

-- The envelope of a pending destination is sealed for its id: the server asks for a fresh id first (AAD), then links with it.
CREATE OR REPLACE FUNCTION public.hub_svc_new_id(p_server_secret TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ BEGIN PERFORM public.hub_require_service(p_server_secret); RETURN gen_random_uuid(); END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_resolve(p_server_secret TEXT, p_provider TEXT, p_ext_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    RETURN (SELECT jsonb_build_object('id', d.id, 'projectId', d.project_id, 'projectName', p.name, 'status', d.status, 'label', d.label,
                                      'notify', d.notify, 'interactive', d.interactive, 'intelligence', d.intelligence, 'extRefEnc', d.ext_ref_enc,
                                      'installationId', d.installation_id)
              FROM public.hub_destinations d JOIN public.projects p ON p.id = d.project_id
             WHERE d.provider = p_provider AND d.ext_key_hmac = p_ext_key);
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_identity_begin(p_server_secret TEXT, p_code_hash TEXT, p_provider TEXT, p_ext_user TEXT, p_label TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    IF (SELECT count(*) FROM public.hub_link_codes c WHERE c.ext_user_hmac = p_ext_user AND c.created_at > now() - interval '10 minutes') >= 5 THEN
        RAISE EXCEPTION 'Příliš mnoho odkazů za krátkou dobu.' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.hub_link_codes (code_hash, purpose, provider, ext_user_hmac, ext_label, expires_at)
    VALUES (p_code_hash, 'identity', p_provider, p_ext_user, p_label, now() + interval '10 minutes');
END $$;

-- Create a task from a chat message on behalf of the VERIFIED ClearSpace user mapped to the external author (edit rights required now).
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
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination;
    IF NOT FOUND OR d.status <> 'active' THEN RETURN jsonb_build_object('ok', false, 'reason', 'destination_inactive'); END IF;
    IF NOT d.interactive THEN RETURN jsonb_build_object('ok', false, 'reason', 'interactive_off'); END IF;
    SELECT i.user_id INTO v_uid FROM public.hub_identities i WHERE i.provider = d.provider AND i.ext_user_hmac = p_ext_user;
    IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'identity_unlinked'); END IF;
    v_role := public.project_role_of(d.project_id, v_uid);
    IF coalesce(v_role, '') NOT IN ('owner', 'admin', 'member') THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_edit_right'); END IF;
    -- idempotent: the same message already became a task
    SELECT * INTO v_existing FROM public.hub_messages m WHERE m.project_id = d.project_id AND m.msg_key_hmac = p_msg_key AND m.kind = 'task_source';
    IF FOUND AND v_existing.card_id IS NOT NULL THEN
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
    INSERT INTO public.cards (id, column_id, project_id, title, details, position)
    VALUES (v_card, v_col, d.project_id, trim(p_title), coalesce(p_details, ''),
            coalesce((SELECT max(k.position) + 1 FROM public.cards k WHERE k.column_id = v_col), 0));
    INSERT INTO public.hub_messages (project_id, destination_id, destination_label, provider, card_id, msg_key_hmac, kind, author_label, author_user_id, verified, text, permalink, sent_at)
    VALUES (d.project_id, d.id, d.label, d.provider, v_card, p_msg_key, 'task_source', left(coalesce(nullif(trim(p_author_label), ''), 'externí autor'), 200), v_uid, true,
            left(coalesce(p_text, ''), 4000), p_permalink, coalesce(p_sent_at, now()))
    ON CONFLICT (project_id, msg_key_hmac) DO UPDATE SET card_id = EXCLUDED.card_id, kind = 'task_source';
    PERFORM public.hub_audit_add(d.project_id, d.id, v_uid, 'service', 'task_created_from_chat', 'provider=' || d.provider);
    RETURN jsonb_build_object('ok', true, 'duplicate', false, 'cardId', v_card, 'projectId', d.project_id, 'title', trim(p_title),
                              'projectName', (SELECT p.name FROM public.projects p WHERE p.id = d.project_id));
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_attach_conversation(p_server_secret TEXT, p_destination UUID, p_card TEXT, p_thread_key TEXT, p_thread_ref TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID; d public.hub_destinations%ROWTYPE;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination AND x.status = 'active';
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.cards k WHERE k.id = p_card AND k.project_id = d.project_id) THEN RETURN NULL; END IF;
    INSERT INTO public.hub_conversations (destination_id, card_id, thread_key_hmac, thread_ref, created_by)
    VALUES (d.id, p_card, p_thread_key, p_thread_ref, (SELECT m.author_user_id FROM public.hub_messages m WHERE m.card_id = p_card AND m.kind = 'task_source' LIMIT 1))
    ON CONFLICT (destination_id, thread_key_hmac) DO UPDATE SET card_id = hub_conversations.card_id
    RETURNING id INTO v_id;
    UPDATE public.hub_messages SET conversation_id = v_id WHERE card_id = p_card AND destination_id = d.id AND kind = 'task_source' AND conversation_id IS NULL;
    RETURN v_id;
END $$;

-- An inbound message from a bound channel / group. Stored ONLY when it belongs to a linked task conversation (interactive) or the destination
-- has Project Intelligence on (and the server says ingestion is allowed); everything else is dropped without a trace.
-- A verified author with edit rights in a linked conversation also becomes a task comment (as that ClearSpace user).
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
    SELECT * INTO d FROM public.hub_destinations x WHERE x.id = p_destination;
    IF NOT FOUND OR d.status <> 'active' THEN RETURN jsonb_build_object('outcome', 'dropped', 'reason', 'destination_inactive'); END IF;
    IF p_thread_key IS NOT NULL AND d.interactive THEN
        SELECT * INTO cv FROM public.hub_conversations c WHERE c.destination_id = d.id AND c.thread_key_hmac = p_thread_key;
    END IF;
    IF cv.id IS NOT NULL THEN v_kind := 'thread_reply';
    ELSIF d.intelligence AND coalesce(p_ingest_allowed, false) THEN v_kind := 'ingested';
    ELSE RETURN jsonb_build_object('outcome', 'dropped', 'reason', 'not_linked');
    END IF;
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

CREATE OR REPLACE FUNCTION public.hub_svc_message_changed(p_server_secret TEXT, p_destination UUID, p_msg_key TEXT, p_text TEXT, p_deleted BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_messages m
       SET text = CASE WHEN p_deleted THEN '' ELSE left(coalesce(p_text, m.text), 4000) END,
           deleted_at = CASE WHEN p_deleted THEN now() ELSE m.deleted_at END, edited_at = CASE WHEN p_deleted THEN m.edited_at ELSE now() END
     WHERE m.destination_id = p_destination AND m.msg_key_hmac = p_msg_key;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_destination_state(p_server_secret TEXT, p_destination UUID, p_status TEXT, p_error TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    IF p_status NOT IN ('active', 'removed_bot', 'revoked', 'archived', 'error') OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.hub_destinations SET status = p_status, last_error_code = p_error, updated_at = now() WHERE id = p_destination AND status <> 'pending';
    UPDATE public.hub_outbox SET status = 'cancelled', last_error_code = 'destination_inactive', updated_at = now()
     WHERE destination_id = p_destination AND status = 'pending' AND p_status <> 'active';
    PERFORM public.hub_audit_add((SELECT project_id FROM public.hub_destinations WHERE id = p_destination), p_destination, NULL, 'service', 'destination_state', 'status=' || p_status);
END $$;

CREATE OR REPLACE FUNCTION public.hub_svc_installation_revoked(p_server_secret TEXT, p_team_hmac TEXT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID; v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_slack_installations SET status = 'revoked', updated_at = now() WHERE team_hmac = p_team_hmac RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN 0; END IF;
    UPDATE public.hub_destinations SET status = 'revoked', last_error_code = 'tokens_revoked', updated_at = now() WHERE installation_id = v_id AND status <> 'pending';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE public.hub_outbox o SET status = 'cancelled', last_error_code = 'destination_inactive', updated_at = now()
      FROM public.hub_destinations d WHERE o.destination_id = d.id AND d.installation_id = v_id AND o.status = 'pending';
    RETURN v_n;
END $$;

-- Telegram: a group became a supergroup (new chat id). Same binding, new routing key / envelope.
CREATE OR REPLACE FUNCTION public.hub_svc_migrate(p_server_secret TEXT, p_old_key TEXT, p_new_key TEXT, p_new_ref_enc TEXT, p_destination UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
    PERFORM public.hub_require_service(p_server_secret);
    UPDATE public.hub_destinations SET ext_key_hmac = p_new_key, ext_ref_enc = p_new_ref_enc, kind = 'telegram_supergroup', updated_at = now()
     WHERE id = p_destination AND provider = 'telegram' AND ext_key_hmac = p_old_key
       AND NOT EXISTS (SELECT 1 FROM public.hub_destinations x WHERE x.provider = 'telegram' AND x.ext_key_hmac = p_new_key);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;

-- ------------------------------------------------------------
-- 5. Outbound queue (triggers) + internal scheduler
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hub_from_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_kind TEXT;
BEGIN
    BEGIN
        IF current_setting('clearspace.hub_inbound', true) = 'on' OR NEW.card_id IS NULL THEN RETURN NULL; END IF;
        IF NEW.action_type = 'card_created' THEN v_kind := 'task_created';
        ELSIF NEW.action_type = 'card_moved' AND NEW.details ->> 'completed' = 'true' THEN v_kind := 'task_completed';
        ELSIF NEW.action_type = 'card_moved' THEN v_kind := 'status_changed';
        ELSE RETURN NULL;
        END IF;
        INSERT INTO public.hub_outbox (destination_id, kind, dedupe_key, card_id, activity_id)
        SELECT d.id, v_kind, 'a:' || NEW.id, NEW.card_id, NEW.id
          FROM public.hub_destinations d
         WHERE d.project_id = NEW.project_id AND d.status = 'active' AND d.notify AND v_kind = ANY (d.event_types)
        ON CONFLICT (destination_id, dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.hub_from_comment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    BEGIN
        IF current_setting('clearspace.hub_inbound', true) = 'on' THEN RETURN NULL; END IF;
        INSERT INTO public.hub_outbox (destination_id, kind, dedupe_key, card_id, comment_id, conversation_id)
        SELECT cv.destination_id, 'comment_sync', 'c:' || NEW.id || ':' || cv.id, NEW.card_id, NEW.id, cv.id
          FROM public.hub_conversations cv JOIN public.hub_destinations d ON d.id = cv.destination_id
         WHERE cv.card_id = NEW.card_id AND d.status = 'active' AND d.interactive
        ON CONFLICT (destination_id, dedupe_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS z_hub_from_activity ON public.activity_logs;
CREATE TRIGGER z_hub_from_activity AFTER INSERT ON public.activity_logs FOR EACH ROW EXECUTE FUNCTION public.hub_from_activity();
DROP TRIGGER IF EXISTS z_hub_from_comment ON public.task_comments;
CREATE TRIGGER z_hub_from_comment AFTER INSERT ON public.task_comments FOR EACH ROW EXECUTE FUNCTION public.hub_from_comment();

CREATE OR REPLACE FUNCTION public.hub_dispatch_prepare(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := coalesce(p_now, now());
    v_today DATE := (coalesce(p_now, now()) AT TIME ZONE 'Europe/Prague')::date;
    v_amb INTEGER := 0; v_due INTEGER := 0; v_purged INTEGER := 0;
BEGIN
    UPDATE public.hub_outbox SET status = 'failed', last_error_code = 'ambiguous', lease_until = NULL, updated_at = now() WHERE status = 'sending' AND lease_until < now();
    GET DIAGNOSTICS v_amb = ROW_COUNT;
    -- deadline reminders per destination: cards due in the window [(D-1) 09:00, D+1 00:00) Europe/Prague (same rule as RUN 05)
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
    -- retention
    DELETE FROM public.hub_outbox WHERE status IN ('sent', 'failed', 'cancelled') AND updated_at < now() - interval '30 days';
    DELETE FROM public.hub_inbox WHERE received_at < now() - interval '7 days';
    DELETE FROM public.hub_messages WHERE retain_until IS NOT NULL AND retain_until < now();
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    DELETE FROM public.hub_link_codes WHERE expires_at < now() - interval '1 day';
    RETURN jsonb_build_object('ambiguous', v_amb, 'dueQueued', v_due, 'purgedMessages', v_purged);
END $$;

-- Claim + re-check right before sending (destination active, capability, event type, card state, comment still there).
CREATE OR REPLACE FUNCTION public.hub_dispatch_claim(p_limit INTEGER, p_lease_seconds INTEGER, p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS TABLE (id UUID, destination_id UUID, provider TEXT, ext_ref_enc TEXT, installation_id UUID, installation_enc TEXT, kind TEXT, attempts INTEGER,
               card_id TEXT, title TEXT, project_id TEXT, project_name TEXT, column_name TEXT, actor_name TEXT, comment_text TEXT, comment_author TEXT,
               thread_ref TEXT, due_date DATE)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := coalesce(p_now, now());
    r public.hub_outbox%ROWTYPE;
    d public.hub_destinations%ROWTYPE;
    k public.cards%ROWTYPE;
    a public.activity_logs%ROWTYPE;
    cm public.task_comments%ROWTYPE;
    cv public.hub_conversations%ROWTYPE;
    v_reason TEXT;
BEGIN
    FOR r IN SELECT o.* FROM public.hub_outbox o WHERE o.status = 'pending' AND o.next_attempt_at <= now()
              ORDER BY o.next_attempt_at, o.created_at LIMIT least(greatest(coalesce(p_limit, 20), 1), 100) FOR UPDATE SKIP LOCKED
    LOOP
        v_reason := NULL; k := NULL; a := NULL; cm := NULL; cv := NULL;
        SELECT * INTO d FROM public.hub_destinations x WHERE x.id = r.destination_id;
        IF NOT FOUND OR d.status <> 'active' THEN v_reason := 'destination_inactive';
        ELSIF r.kind = 'comment_sync' AND NOT d.interactive THEN v_reason := 'capability_off';
        ELSIF r.kind NOT IN ('comment_sync', 'test') AND (NOT d.notify OR NOT (r.kind = ANY (d.event_types))) THEN v_reason := 'capability_off';
        END IF;
        IF v_reason IS NULL AND r.card_id IS NOT NULL THEN
            SELECT * INTO k FROM public.cards x WHERE x.id = r.card_id;
            IF NOT FOUND OR k.project_id IS DISTINCT FROM d.project_id THEN v_reason := 'card_gone';
            ELSIF coalesce(k.archived, false) THEN v_reason := 'card_archived';
            END IF;
        END IF;
        IF v_reason IS NULL AND r.kind = 'due_soon' THEN
            IF public.iso_date_or_null(k.due_date) IS DISTINCT FROM r.due_date THEN v_reason := 'due_changed';
            ELSIF public.collab_is_done_column(k.column_id) THEN v_reason := 'done';
            ELSIF v_now >= public.notify_due_window_end(r.due_date) THEN v_reason := 'expired';
            END IF;
        END IF;
        IF v_reason IS NULL AND r.activity_id IS NOT NULL THEN
            SELECT * INTO a FROM public.activity_logs x WHERE x.id = r.activity_id;
        END IF;
        IF v_reason IS NULL AND r.kind = 'comment_sync' THEN
            SELECT * INTO cm FROM public.task_comments x WHERE x.id = r.comment_id;
            SELECT * INTO cv FROM public.hub_conversations x WHERE x.id = r.conversation_id;
            IF cm.id IS NULL OR cv.id IS NULL THEN v_reason := 'source_gone';
            ELSIF EXISTS (SELECT 1 FROM public.hub_comment_links l WHERE l.comment_id = cm.id AND l.direction = 'inbound') THEN v_reason := 'loop';
            END IF;
        END IF;
        IF v_reason IS NOT NULL THEN
            UPDATE public.hub_outbox o SET status = 'cancelled', last_error_code = v_reason, updated_at = now() WHERE o.id = r.id;
            CONTINUE;
        END IF;
        UPDATE public.hub_outbox o SET status = 'sending', attempts = o.attempts + 1,
               lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 900)), updated_at = now() WHERE o.id = r.id;
        RETURN QUERY SELECT r.id, d.id, d.provider, d.ext_ref_enc, d.installation_id,
            (SELECT i.secret_enc FROM public.hub_slack_installations i WHERE i.id = d.installation_id AND i.status = 'active'),
            r.kind, r.attempts + 1, k.id, k.title, d.project_id, (SELECT p.name FROM public.projects p WHERE p.id = d.project_id),
            coalesce(a.details ->> 'to', (SELECT c.name FROM public.columns c WHERE c.id = k.column_id)), a.actor_name,
            left(cm.content, 2000), cm.author_name, cv.thread_ref, r.due_date;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.hub_dispatch_result(p_id UUID, p_outcome TEXT, p_error_code TEXT, p_retry_seconds INTEGER)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r public.hub_outbox%ROWTYPE; v_status TEXT;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'release', 'failed', 'cancelled', 'reconnect', 'removed_bot', 'archived')
       OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.hub_outbox o WHERE o.id = p_id AND o.status = 'sending' FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_leased'; END IF;
    v_status := CASE WHEN p_outcome = 'sent' THEN 'sent' WHEN p_outcome = 'cancelled' THEN 'cancelled' WHEN p_outcome = 'release' THEN 'pending'
                     WHEN p_outcome = 'retry' AND r.attempts < 5 THEN 'pending' ELSE 'failed' END;
    IF v_status = 'pending' AND NOT EXISTS (SELECT 1 FROM public.hub_destinations d WHERE d.id = r.destination_id AND d.status = 'active') THEN v_status := 'cancelled'; END IF;
    UPDATE public.hub_outbox o SET status = v_status, lease_until = NULL, updated_at = now(),
           attempts = CASE WHEN p_outcome = 'release' THEN greatest(o.attempts - 1, 0) ELSE o.attempts END,
           last_error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE coalesce(p_error_code, p_outcome) END,
           next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + make_interval(secs => greatest(least(coalesce(p_retry_seconds, 0), 86400),
               CASE WHEN p_outcome = 'release' THEN 0 WHEN r.attempts <= 1 THEN 60 WHEN r.attempts = 2 THEN 300 WHEN r.attempts = 3 THEN 900 ELSE 3600 END)) ELSE o.next_attempt_at END
     WHERE o.id = r.id;
    IF p_outcome IN ('reconnect', 'removed_bot', 'archived') THEN
        UPDATE public.hub_destinations SET status = CASE p_outcome WHEN 'reconnect' THEN 'revoked' ELSE p_outcome END, last_error_code = coalesce(p_error_code, p_outcome), updated_at = now()
         WHERE id = r.destination_id AND status = 'active';
        UPDATE public.hub_outbox SET status = 'cancelled', last_error_code = 'destination_inactive', updated_at = now() WHERE destination_id = r.destination_id AND status = 'pending';
    ELSIF p_outcome = 'sent' AND r.kind = 'comment_sync' AND r.comment_id IS NOT NULL THEN
        INSERT INTO public.hub_comment_links (comment_id, direction, provider) SELECT r.comment_id, 'outbound', d.provider FROM public.hub_destinations d WHERE d.id = r.destination_id
        ON CONFLICT (comment_id) DO NOTHING;
    END IF;
    RETURN v_status;
END $$;

CREATE OR REPLACE FUNCTION public.hub_dispatch_apply(p_results JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE e JSONB; v_n INTEGER := 0;
BEGIN
    IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN RETURN 0; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_results) x LIMIT 100 LOOP
        BEGIN
            IF e ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                PERFORM public.hub_dispatch_result((e ->> 'id')::uuid, e ->> 'outcome', e ->> 'code',
                    CASE WHEN e ->> 'retryAfter' ~ '^[0-9]{1,6}$' THEN (e ->> 'retryAfter')::int END);
                v_n := v_n + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END LOOP;
    RETURN v_n;
END $$;

CREATE OR REPLACE FUNCTION public.hub_scheduler_tick(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    run public.hub_dispatch_runs%ROWTYPE;
    v_found BOOLEAN; v_status INTEGER; v_content TEXT;
    v_applied INTEGER := 0; v_disabled INTEGER := 0; v_n INTEGER;
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
    IF v_url IS NULL OR v_secret IS NULL OR v_url !~ '^https?://' THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'scheduler', 'not_configured');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'destinationId', c.destination_id, 'provider', c.provider, 'extRef', c.ext_ref_enc,
                                        'installationId', c.installation_id, 'installation', c.installation_enc, 'kind', c.kind, 'attempt', c.attempts,
                                        'cardId', c.card_id, 'title', c.title, 'projectId', c.project_id, 'projectName', c.project_name, 'column', c.column_name,
                                        'actor', c.actor_name, 'comment', c.comment_text, 'commentAuthor', c.comment_author, 'threadRef', c.thread_ref, 'dueDate', c.due_date)),
           array_agg(c.id)
      INTO v_items, v_ids
      FROM public.hub_dispatch_claim(20, 300, p_now) c;
    IF v_ids IS NULL THEN RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0); END IF;
    EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' INTO v_req
      USING v_url, jsonb_build_object('items', v_items, 'now', p_now), jsonb_build_object('content-type', 'application/json', 'x-hub-secret', v_secret);
    INSERT INTO public.hub_dispatch_runs (request_id, outbox_ids) VALUES (v_req, v_ids);
    RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', cardinality(v_ids), 'request', v_req);
END $$;

-- ------------------------------------------------------------
-- Grants: internal helpers / triggers / scheduler -> nobody; user RPCs -> authenticated; service RPCs -> authenticated (gated by principal+secret)
-- ------------------------------------------------------------
DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY['hub_require_user(text)', 'hub_require_service(text)', 'hub_require_manager(text,uuid)', 'hub_audit_add(text,uuid,uuid,text,text,text)',
        'hub_act_as(uuid)', 'hub_from_activity()', 'hub_from_comment()', 'hub_dispatch_prepare(timestamp with time zone)',
        'hub_dispatch_claim(integer,integer,timestamp with time zone)', 'hub_dispatch_result(uuid,text,text,integer)', 'hub_dispatch_apply(jsonb)',
        'hub_scheduler_tick(timestamp with time zone)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    END LOOP;
    FOREACH f IN ARRAY ARRAY['hub_project_status(text,text)', 'hub_link_begin(text,text,text,text)', 'hub_destination_decide(text,uuid,boolean)',
        'hub_destination_configure(text,uuid,boolean,boolean,boolean,boolean,text[])', 'hub_destination_remove(text,uuid,boolean)',
        'hub_destination_target(text,uuid)', 'hub_destination_mark_user(text,uuid,text,text)', 'hub_identity_confirm(text,text)', 'hub_identities_mine(text)',
        'hub_identity_remove(text,text,text)', 'hub_slack_install_begin(text,text)', 'hub_slack_install_lookup(text,text,text)',
        'hub_slack_install_store(text,uuid,text,text,text,text[])',
        'hub_svc_inbox(text,text,text)', 'hub_svc_installation(text,text)', 'hub_svc_link_destination(text,uuid,text,text,text,text,text,text,uuid)',
        'hub_svc_new_id(text)', 'hub_svc_resolve(text,text,text)', 'hub_svc_identity_begin(text,text,text,text,text)',
        'hub_svc_create_task(text,uuid,text,text,text,text,text,text,text,timestamp with time zone)', 'hub_svc_attach_conversation(text,uuid,text,text,text)',
        'hub_svc_inbound_message(text,uuid,text,text,text,text,text,text,timestamp with time zone,boolean)', 'hub_svc_message_changed(text,uuid,text,text,boolean)',
        'hub_svc_destination_state(text,uuid,text,text)', 'hub_svc_installation_revoked(text,text)', 'hub_svc_migrate(text,text,text,text,uuid)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
    END LOOP;
END $$;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261130001600_communication_hub') ON CONFLICT (version) DO NOTHING;
