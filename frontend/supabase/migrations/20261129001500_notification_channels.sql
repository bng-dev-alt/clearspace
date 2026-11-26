-- ============================================================
-- 20261129001500 -- Notifications outside the app: Slack & Telegram delivery layer (RUN 05)
--
-- Apply AFTER 20261128001400, in a transaction. Idempotent (re-running is a no-op).
-- Rollback: supabase/rollback/20261129001500_notification_channels.down.sql (refuses while it would lose data).
--
-- ADDITIVE ONLY (docs/run05/ARCHITECTURE_DECISION.md). This migration runs in production UNDER THE PREVIOUS BUILD, so:
--   * nothing existing changes: public.notifications, collab_notify() and every RUN 01 trigger stay byte-identical; the in-app
--     notifications produced by user actions are the same on 1400 and 1500 (DB test 95);
--   * the two new AFTER INSERT triggers (notifications, activity_logs) only queue a delivery for a user who has an ACTIVE external
--     channel -- none exists until the feature is switched on -- and swallow every error (they can never fail the user's write);
--   * no extension is installed and nothing is scheduled here (pg_cron + pg_net: supabase/ops/notify_scheduler_enable.sql, run only
--     when the owner switches the feature on).
--
-- Privacy (docs/run05/PRIVACY_AND_SECURITY.md): no client access to any new table. Credentials only as AES-GCM envelopes produced by
-- the server (key never in the database); link tokens / OAuth states only as SHA-256; the outbox holds ids, never titles or texts --
-- the message is composed at send time from the current rows, after re-checking access (notify_dispatch_claim).
--
--   1. notification_channels, notification_preferences, notification_deliveries (RLS on, no policies, no client grants)
--   2. internal helpers + the two enqueue triggers
--   3. server-secret RPCs for the signed-in user (connect / confirm / disconnect / preferences / test)
--   4. the scheduler / dispatcher: INTERNAL functions only (no client EXECUTE). notify_scheduler_tick() runs in the database and
--      hands the app one batch at a time over pg_net; the app answers with outcomes. Nothing here is reachable through the API.
-- ============================================================

DO $$
DECLARE
    v_missing TEXT := '';
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261128001400_google_calendar') THEN
        v_missing := v_missing || ' migration:20261128001400_google_calendar(apply it first)';
    END IF;
    IF to_regclass('public.notifications') IS NULL THEN v_missing := v_missing || ' table:notifications'; END IF;
    IF to_regclass('public.activity_logs') IS NULL THEN v_missing := v_missing || ' table:activity_logs'; END IF;
    IF to_regclass('public.card_assignees') IS NULL THEN v_missing := v_missing || ' table:card_assignees'; END IF;
    IF to_regprocedure('public.require_server_secret(text,text)') IS NULL THEN v_missing := v_missing || ' fn:require_server_secret'; END IF;
    IF to_regprocedure('public.google_require_user()') IS NULL THEN v_missing := v_missing || ' fn:google_require_user'; END IF;
    IF to_regprocedure('public.project_role_of(text,uuid)') IS NULL THEN v_missing := v_missing || ' fn:project_role_of'; END IF;
    IF to_regprocedure('public.collab_is_done_column(text)') IS NULL THEN v_missing := v_missing || ' fn:collab_is_done_column'; END IF;
    IF to_regprocedure('public.iso_date_or_null(text)') IS NULL THEN v_missing := v_missing || ' fn:iso_date_or_null'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- notification channels cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('slack', 'telegram')),
    -- linking: token / OAuth state issued · confirm: Telegram chat found, the user must confirm it in ClearSpace ·
    -- active: delivering · reconnect: the provider refused the credential · blocked: the user blocked the Telegram bot
    status TEXT NOT NULL DEFAULT 'linking' CHECK (status IN ('linking', 'confirm', 'active', 'reconnect', 'blocked')),
    enabled BOOLEAN NOT NULL DEFAULT true,
    -- AES-256-GCM envelope "v1.<key id>.<iv>.<ciphertext>.<tag>" (base64url) made by the server; AAD = provider + channel id
    secret_enc TEXT CHECK (secret_enc IS NULL OR (secret_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND char_length(secret_enc) <= 4096)),
    team_hmac TEXT CHECK (team_hmac IS NULL OR team_hmac ~ '^[0-9a-f]{64}$'),
    label TEXT CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 200 AND label !~ '[[:cntrl:]]')),
    link_hash TEXT CHECK (link_hash IS NULL OR link_hash ~ '^[0-9a-f]{64}$'),
    link_expires_at TIMESTAMP WITH TIME ZONE,
    link_issued_at TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
    last_sent_at TIMESTAMP WITH TIME ZONE,
    last_test_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider),
    CONSTRAINT notification_channels_active_has_secret CHECK (status IN ('linking') OR secret_enc IS NOT NULL),
    CONSTRAINT notification_channels_slack_team CHECK (provider <> 'slack' OR status = 'linking' OR team_hmac IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_channels_link ON public.notification_channels (link_hash) WHERE link_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_channels_team ON public.notification_channels (team_hmac) WHERE team_hmac IS NOT NULL;
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;   -- no policy: server-secret RPCs only
REVOKE ALL ON public.notification_channels FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.notification_channels TO service_role;

CREATE TABLE IF NOT EXISTS public.notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    event_types TEXT[] NOT NULL DEFAULT ARRAY['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership']
        CHECK (cardinality(event_types) <= 7 AND event_types <@ ARRAY['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership']),
    project_ids TEXT[] CHECK (project_ids IS NULL OR cardinality(project_ids) <= 200),
    hide_titles BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_preferences FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.notification_preferences TO service_role;

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.notification_channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('assignment', 'mention', 'comment', 'project_added', 'project_role_changed', 'project_removed',
                                       'task_completed', 'task_due_changed', 'due_soon')),
    dedupe_key TEXT NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 300),
    -- source references only (no titles, no texts): the message is built at send time from the current rows
    notification_id UUID,
    activity_id TEXT CHECK (activity_id IS NULL OR char_length(activity_id) <= 200),
    project_id TEXT CHECK (project_id IS NULL OR char_length(project_id) <= 200),
    card_id TEXT CHECK (card_id IS NULL OR char_length(card_id) <= 200),
    due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    lease_until TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (channel_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_due ON public.notification_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS notification_deliveries_sending ON public.notification_deliveries (lease_until) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS notification_deliveries_final ON public.notification_deliveries (updated_at) WHERE status IN ('sent', 'failed', 'cancelled');
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.notification_deliveries TO service_role;

-- ------------------------------------------------------------
-- 2. Internal helpers + enqueue triggers (never callable as RPCs)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_pref_key(p_kind TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT CASE WHEN p_kind IN ('project_added', 'project_role_changed', 'project_removed') THEN 'project_membership' ELSE p_kind END $$;

CREATE OR REPLACE FUNCTION public.notify_prefs_allow(p_uid UUID, p_kind TEXT, p_project_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT public.notify_pref_key(p_kind) = ANY (p.event_types)
                            AND (p.project_ids IS NULL OR p_project_id IS NULL OR p_project_id = ANY (p.project_ids))
                     FROM public.notification_preferences p WHERE p.user_id = p_uid), true)
$$;

-- Local time of the app (one fixed zone, docs/run05/DECISIONS.md D8): a date-only due date D is reminded from (D-1) 09:00 to D+1 00:00.
CREATE OR REPLACE FUNCTION public.notify_due_window_start(p_due DATE)
RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ((p_due - 1) + time '09:00') AT TIME ZONE 'Europe/Prague' $$;
CREATE OR REPLACE FUNCTION public.notify_due_window_end(p_due DATE)
RETURNS TIMESTAMP WITH TIME ZONE LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$ SELECT ((p_due + 1) + time '00:00') AT TIME ZONE 'Europe/Prague' $$;

CREATE OR REPLACE FUNCTION public.notify_enqueue(p_uid UUID, p_kind TEXT, p_key TEXT, p_notification UUID, p_activity TEXT,
                                                 p_project TEXT, p_card TEXT, p_due DATE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_uid IS NULL OR NOT public.notify_prefs_allow(p_uid, p_kind, p_project) THEN RETURN; END IF;
    INSERT INTO public.notification_deliveries (channel_id, user_id, kind, dedupe_key, notification_id, activity_id, project_id, card_id, due_date)
    SELECT c.id, c.user_id, p_kind, p_key, p_notification, p_activity, p_project, p_card, p_due
      FROM public.notification_channels c
     WHERE c.user_id = p_uid AND c.status = 'active' AND c.enabled
    ON CONFLICT (channel_id, dedupe_key) DO NOTHING;
END $$;

-- In-app notification -> external delivery (same recipient, same moment). Swallows every error: the user's write must never fail
-- because of the delivery layer.
CREATE OR REPLACE FUNCTION public.notify_from_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    BEGIN
        IF NEW.type IN ('assignment', 'mention', 'comment', 'project_added', 'project_role_changed', 'project_removed')
           AND EXISTS (SELECT 1 FROM public.notification_channels c WHERE c.user_id = NEW.recipient_id AND c.status = 'active' AND c.enabled) THEN
            PERFORM public.notify_enqueue(NEW.recipient_id, NEW.type, 'n:' || NEW.id::text, NEW.id, NULL, NEW.project_id, NEW.card_id, NULL);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN NULL;
END $$;

-- Activity -> "my task was completed" / "the due date of my task changed" for the task's assignees (not the actor).
CREATE OR REPLACE FUNCTION public.notify_from_activity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_kind TEXT;
    v_uid UUID;
BEGIN
    BEGIN
        IF NEW.card_id IS NULL THEN RETURN NULL; END IF;
        IF NEW.action_type = 'card_moved' AND NEW.details ->> 'completed' = 'true'
           AND NOT public.collab_is_done_column(NEW.details ->> 'from_column_id') THEN
            v_kind := 'task_completed';
        ELSIF NEW.action_type = 'card_due_changed' THEN
            v_kind := 'task_due_changed';
        ELSE
            RETURN NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.notification_channels c WHERE c.status = 'active' AND c.enabled) THEN RETURN NULL; END IF;
        FOR v_uid IN
            SELECT DISTINCT wm.profile_id FROM public.card_assignees ca
              JOIN public.workspace_members wm ON wm.id = ca.member_id
             WHERE ca.card_id = NEW.card_id AND wm.profile_id IS NOT NULL AND wm.profile_id IS DISTINCT FROM NEW.actor_id
        LOOP
            IF public.project_role_of(NEW.project_id, v_uid) IS NOT NULL THEN
                PERFORM public.notify_enqueue(v_uid, v_kind, 'a:' || NEW.id, NULL, NEW.id, NEW.project_id, NEW.card_id, NULL);
            END IF;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS z_notify_from_notification ON public.notifications;
CREATE TRIGGER z_notify_from_notification AFTER INSERT ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.notify_from_notification();
DROP TRIGGER IF EXISTS z_notify_from_activity ON public.activity_logs;
CREATE TRIGGER z_notify_from_activity AFTER INSERT ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.notify_from_activity();

REVOKE ALL ON FUNCTION public.notify_pref_key(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_prefs_allow(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_due_window_start(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_due_window_end(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_enqueue(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_from_notification() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_from_activity() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. RPCs for the signed-in user (authenticated + server secret)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_status(p_server_secret TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    RETURN jsonb_build_object(
        'channels', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'provider', c.provider, 'status', c.status, 'enabled', c.enabled, 'label', c.label, 'lastErrorCode', c.last_error_code,
            'lastSentAt', c.last_sent_at, 'linkPending', c.link_hash IS NOT NULL AND c.link_expires_at > now(),
            'failed7d', (SELECT count(*) FROM public.notification_deliveries d WHERE d.channel_id = c.id AND d.status = 'failed'
                                                                                AND d.updated_at > now() - interval '7 days'))
            ORDER BY c.provider) FROM public.notification_channels c WHERE c.user_id = v_uid), '[]'::jsonb),
        'preferences', coalesce((SELECT jsonb_build_object('eventTypes', to_jsonb(p.event_types), 'projectIds', to_jsonb(p.project_ids), 'hideTitles', p.hide_titles)
                                   FROM public.notification_preferences p WHERE p.user_id = v_uid), 'null'::jsonb));
END $$;

-- Issue a single-use link token (Telegram) or OAuth state (Slack) for the caller; only its SHA-256 is stored; valid 10 minutes.
CREATE OR REPLACE FUNCTION public.notify_link_begin(p_server_secret TEXT, p_provider TEXT, p_link_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    IF p_provider NOT IN ('slack', 'telegram') OR p_link_hash IS NULL OR p_link_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.notification_channels c WHERE c.user_id = v_uid AND c.provider = p_provider
                                                              AND c.link_issued_at > now() - interval '3 seconds') THEN
        RAISE EXCEPTION 'Příliš mnoho pokusů o připojení. Zkuste to prosím za chvíli.' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.notification_channels (user_id, provider, link_hash, link_expires_at, link_issued_at)
    VALUES (v_uid, p_provider, p_link_hash, now() + interval '10 minutes', now())
    ON CONFLICT (user_id, provider) DO UPDATE
        SET link_hash = EXCLUDED.link_hash, link_expires_at = EXCLUDED.link_expires_at, link_issued_at = now(), updated_at = now()
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- Slack: the caller's own unexpired OAuth state -> channel id (the AAD of the credential envelope).
CREATE OR REPLACE FUNCTION public.notify_slack_lookup(p_server_secret TEXT, p_link_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    RETURN (SELECT c.id FROM public.notification_channels c
             WHERE c.user_id = v_uid AND c.provider = 'slack' AND c.link_hash = p_link_hash AND c.link_expires_at > now());
END $$;

-- Slack: store the credential (consumes the state). Returns the previous credential when it belonged to ANOTHER workspace, with the
-- number of other active channels of that workspace (the server revokes the old bot token only when nobody else uses it).
CREATE OR REPLACE FUNCTION public.notify_slack_complete(p_server_secret TEXT, p_link_hash TEXT, p_secret_enc TEXT, p_team_hmac TEXT, p_label TEXT)
RETURNS TABLE (old_secret_enc TEXT, old_team_shared INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_old public.notification_channels%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    SELECT * INTO v_old FROM public.notification_channels c
     WHERE c.user_id = v_uid AND c.provider = 'slack' AND c.link_hash = p_link_hash AND c.link_expires_at > now() FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Požadavek na připojení vypršel nebo už byl použit. Zkuste to prosím znovu.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.notification_channels c
       SET secret_enc = p_secret_enc, team_hmac = p_team_hmac, label = p_label, status = 'active', enabled = true,
           link_hash = NULL, link_expires_at = NULL, last_error_code = NULL, updated_at = now()
     WHERE c.id = v_old.id;
    IF v_old.secret_enc IS NOT NULL AND v_old.team_hmac IS DISTINCT FROM p_team_hmac THEN
        RETURN QUERY SELECT v_old.secret_enc, (SELECT count(*)::int FROM public.notification_channels o
                                               WHERE o.team_hmac = v_old.team_hmac AND o.id <> v_old.id AND o.status = 'active');
    END IF;
END $$;

-- Telegram: any signed-in server request may process the bot's pending /start updates (getUpdates); a token resolves to its
-- channel no matter who processes it. Single use: attach clears the hash.
CREATE OR REPLACE FUNCTION public.notify_telegram_lookup(p_server_secret TEXT, p_link_hash TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    PERFORM public.google_require_user();
    RETURN (SELECT c.id FROM public.notification_channels c
             WHERE c.provider = 'telegram' AND c.link_hash = p_link_hash AND c.link_expires_at > now());
END $$;

CREATE OR REPLACE FUNCTION public.notify_telegram_attach(p_server_secret TEXT, p_link_hash TEXT, p_secret_enc TEXT, p_label TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    PERFORM public.google_require_user();
    UPDATE public.notification_channels c
       SET secret_enc = p_secret_enc, label = p_label, status = 'confirm', link_hash = NULL, link_expires_at = NULL,
           last_error_code = NULL, updated_at = now()
     WHERE c.provider = 'telegram' AND c.link_hash = p_link_hash AND c.link_expires_at > now()
    RETURNING c.id INTO v_id;
    -- a re-link of an active chat: queued deliveries of the old chat are cancelled at claim time (channel not active)
    RETURN v_id;
END $$;

-- Telegram: the owner confirms (or rejects) the chat found for their token. Nothing is delivered before 'active'.
CREATE OR REPLACE FUNCTION public.notify_telegram_confirm(p_server_secret TEXT, p_accept BOOLEAN)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    SELECT c.id INTO v_id FROM public.notification_channels c WHERE c.user_id = v_uid AND c.provider = 'telegram' AND c.status = 'confirm' FOR UPDATE;
    IF v_id IS NULL THEN RETURN 'none'; END IF;
    IF p_accept THEN
        UPDATE public.notification_channels SET status = 'active', enabled = true, updated_at = now() WHERE id = v_id;
        RETURN 'active';
    END IF;
    DELETE FROM public.notification_channels WHERE id = v_id;
    RETURN 'removed';
END $$;

CREATE OR REPLACE FUNCTION public.notify_channel_set_enabled(p_server_secret TEXT, p_provider TEXT, p_enabled BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    UPDATE public.notification_channels c SET enabled = coalesce(p_enabled, false), updated_at = now()
     WHERE c.user_id = v_uid AND c.provider = p_provider RETURNING c.id INTO v_id;
    IF v_id IS NOT NULL AND NOT coalesce(p_enabled, false) THEN
        UPDATE public.notification_deliveries SET status = 'cancelled', last_error_code = 'channel_paused', lease_until = NULL, updated_at = now()
         WHERE channel_id = v_id AND status = 'pending';
    END IF;
    RETURN v_id IS NOT NULL;
END $$;

-- Disconnect: deletes the channel (its queue cascades). Returns the credential so the server can revoke it, and how many OTHER active
-- channels share the Slack workspace (bot token): revoke only when that is 0.
CREATE OR REPLACE FUNCTION public.notify_channel_remove(p_server_secret TEXT, p_provider TEXT)
RETURNS TABLE (secret_enc TEXT, team_shared INTEGER, channel_id UUID, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_row public.notification_channels%ROWTYPE;
    v_shared INTEGER := 0;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    SELECT * INTO v_row FROM public.notification_channels c WHERE c.user_id = v_uid AND c.provider = p_provider FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    IF v_row.team_hmac IS NOT NULL THEN
        SELECT count(*)::int INTO v_shared FROM public.notification_channels o
         WHERE o.team_hmac = v_row.team_hmac AND o.id <> v_row.id AND o.status = 'active';
    END IF;
    DELETE FROM public.notification_channels c WHERE c.id = v_row.id;
    RETURN QUERY SELECT v_row.secret_enc, v_shared, v_row.id, v_row.status;
END $$;

-- Test message: the caller's own channel credential, at most one test per 30 s (also any confirm / connected message).
CREATE OR REPLACE FUNCTION public.notify_test_begin(p_server_secret TEXT, p_provider TEXT, p_allow_confirm BOOLEAN DEFAULT false)
RETURNS TABLE (channel_id UUID, secret_enc TEXT, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_row public.notification_channels%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    SELECT * INTO v_row FROM public.notification_channels c WHERE c.user_id = v_uid AND c.provider = p_provider FOR UPDATE;
    IF NOT FOUND OR v_row.secret_enc IS NULL OR NOT (v_row.status = 'active' OR (p_allow_confirm AND v_row.status = 'confirm')) THEN
        RAISE EXCEPTION 'Kanál není připojený.' USING ERRCODE = '22023';
    END IF;
    IF v_row.last_test_at > now() - interval '30 seconds' THEN
        RAISE EXCEPTION 'Zkušební zprávu lze poslat jednou za 30 sekund.' USING ERRCODE = 'PT429';
    END IF;
    UPDATE public.notification_channels c SET last_test_at = now() WHERE c.id = v_row.id;
    RETURN QUERY SELECT v_row.id, v_row.secret_enc, v_row.status;
END $$;

-- Outcome of a message the server sent with the caller's own channel (test / confirmation).
CREATE OR REPLACE FUNCTION public.notify_channel_mark(p_server_secret TEXT, p_provider TEXT, p_outcome TEXT, p_error_code TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    IF p_outcome NOT IN ('sent', 'failed', 'reconnect', 'blocked') OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.notification_channels c
       SET status = CASE WHEN p_outcome IN ('reconnect', 'blocked') THEN p_outcome ELSE c.status END,
           last_error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_error_code END,
           last_sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE c.last_sent_at END,
           updated_at = now()
     WHERE c.user_id = v_uid AND c.provider = p_provider;
END $$;

CREATE OR REPLACE FUNCTION public.notify_prefs_set(p_server_secret TEXT, p_event_types TEXT[], p_project_ids TEXT[], p_hide_titles BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('notify', p_server_secret);
    v_uid := public.google_require_user();
    IF p_event_types IS NULL OR NOT (p_event_types <@ ARRAY['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership'])
       OR (p_project_ids IS NOT NULL AND (cardinality(p_project_ids) > 200
           OR EXISTS (SELECT 1 FROM unnest(p_project_ids) x WHERE x IS NULL OR x !~ '^[A-Za-z0-9_-]{1,100}$'))) THEN
        RAISE EXCEPTION 'Neplatné nastavení oznámení.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.notification_preferences (user_id, event_types, project_ids, hide_titles, updated_at)
    VALUES (v_uid, (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(p_event_types) t), p_project_ids, coalesce(p_hide_titles, false), now())
    ON CONFLICT (user_id) DO UPDATE SET event_types = EXCLUDED.event_types, project_ids = EXCLUDED.project_ids,
                                        hide_titles = EXCLUDED.hide_titles, updated_at = now();
    -- preferences also apply to what is already queued
    UPDATE public.notification_deliveries d SET status = 'cancelled', last_error_code = 'preferences', updated_at = now()
     WHERE d.user_id = v_uid AND d.status = 'pending' AND NOT public.notify_prefs_allow(v_uid, d.kind, d.project_id);
END $$;

-- ------------------------------------------------------------
-- 4. Scheduler / dispatcher -- INTERNAL ONLY (no EXECUTE for anon or authenticated: not reachable through the API).
--    notify_scheduler_tick() runs inside the database (pg_cron, switched on by supabase/ops/notify_scheduler_enable.sql):
--      1. collects the answers of earlier sends (pg_net responses) and records the outcome of every delivery,
--      2. prepares (due-date reminders, interrupted sends, retention),
--      3. claims a batch -- re-checking EVERYTHING right before sending -- and POSTs it to the app (/api/notify/dispatch), which only
--         decrypts, sends and answers with one outcome per delivery. The app never needs database privileges for this.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_dispatch_runs (
    request_id BIGINT PRIMARY KEY,
    delivery_ids UUID[] NOT NULL CHECK (cardinality(delivery_ids) BETWEEN 1 AND 100),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_dispatch_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_dispatch_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.notification_dispatch_runs TO service_role;

CREATE OR REPLACE FUNCTION public.notify_dispatch_prepare(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := coalesce(p_now, now());
    v_today DATE := (coalesce(p_now, now()) AT TIME ZONE 'Europe/Prague')::date;
    v_ambiguous INTEGER := 0;
    v_due INTEGER := 0;
    v_purged INTEGER := 0;
BEGIN
    -- a send interrupted mid-way (crash / timeout / lost answer): it may or may not have reached the provider -> at most once
    UPDATE public.notification_deliveries d SET status = 'failed', last_error_code = 'ambiguous', lease_until = NULL, updated_at = now()
     WHERE d.status = 'sending' AND d.lease_until < now();
    GET DIAGNOSTICS v_ambiguous = ROW_COUNT;
    -- due-date reminders: date-only due date in Europe/Prague, window [(D-1) 09:00, D+1 00:00); catches up after an outage
    IF EXISTS (SELECT 1 FROM public.notification_channels c WHERE c.status = 'active' AND c.enabled) THEN
        INSERT INTO public.notification_deliveries (channel_id, user_id, kind, dedupe_key, project_id, card_id, due_date)
        SELECT DISTINCT ON (ch.id, k.id) ch.id, ch.user_id, 'due_soon', 'd:' || k.id || ':' || public.iso_date_or_null(k.due_date)::text,
               k.project_id, k.id, public.iso_date_or_null(k.due_date)
          FROM public.cards k
          JOIN public.card_assignees ca ON ca.card_id = k.id
          JOIN public.workspace_members wm ON wm.id = ca.member_id AND wm.profile_id IS NOT NULL
          JOIN public.notification_channels ch ON ch.user_id = wm.profile_id AND ch.status = 'active' AND ch.enabled
         WHERE k.due_date IN (to_char(v_today, 'YYYY-MM-DD'), to_char(v_today + 1, 'YYYY-MM-DD'))
           AND public.iso_date_or_null(k.due_date) IS NOT NULL
           AND v_now >= public.notify_due_window_start(public.iso_date_or_null(k.due_date))
           AND v_now < public.notify_due_window_end(public.iso_date_or_null(k.due_date))
           AND NOT coalesce(k.archived, false)
           AND NOT public.collab_is_done_column(k.column_id)
           AND public.project_role_of(k.project_id, wm.profile_id) IS NOT NULL
           AND public.notify_prefs_allow(wm.profile_id, 'due_soon', k.project_id)
        ON CONFLICT (channel_id, dedupe_key) DO NOTHING;
        GET DIAGNOSTICS v_due = ROW_COUNT;
    END IF;
    DELETE FROM public.notification_deliveries d WHERE d.status IN ('sent', 'failed', 'cancelled') AND d.updated_at < now() - interval '30 days';
    GET DIAGNOSTICS v_purged = ROW_COUNT;
    RETURN jsonb_build_object('ambiguous', v_ambiguous, 'dueQueued', v_due, 'purged', v_purged);
END $$;

-- Claim due deliveries (SKIP LOCKED: concurrent ticks never take the same row) and re-check EVERYTHING right before sending:
-- channel, preferences, source, access, task state, assignment, due date. Invalid rows are cancelled with the reason; valid rows
-- are leased ('sending') and returned with the current names the message is built from. (Provider switches live in the app:
-- it answers 'cancelled provider_disabled' for a provider that is off, or 503 when both are off.)
CREATE OR REPLACE FUNCTION public.notify_dispatch_claim(p_limit INTEGER, p_lease_seconds INTEGER, p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS TABLE (id UUID, provider TEXT, channel_id UUID, user_id UUID, secret_enc TEXT, kind TEXT, attempts INTEGER,
               actor_name TEXT, title TEXT, project_name TEXT, project_id TEXT, card_id TEXT, due_date DATE, new_due TEXT, hide_titles BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := coalesce(p_now, now());
    r public.notification_deliveries%ROWTYPE;
    ch public.notification_channels%ROWTYPE;
    n public.notifications%ROWTYPE;
    k public.cards%ROWTYPE;
    a public.activity_logs%ROWTYPE;
    v_reason TEXT;
    v_actor TEXT;
    v_title TEXT;
    v_new_due TEXT;
BEGIN
    FOR r IN
        SELECT d.* FROM public.notification_deliveries d
         WHERE d.status = 'pending' AND d.next_attempt_at <= now()
         ORDER BY d.next_attempt_at, d.created_at
         LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
         FOR UPDATE SKIP LOCKED
    LOOP
        v_reason := NULL; v_actor := NULL; v_title := NULL; v_new_due := NULL; n := NULL; k := NULL; a := NULL;
        SELECT * INTO ch FROM public.notification_channels c WHERE c.id = r.channel_id;
        IF NOT FOUND OR ch.status <> 'active' OR NOT ch.enabled OR ch.secret_enc IS NULL THEN v_reason := 'channel_inactive';
        ELSIF NOT public.notify_prefs_allow(r.user_id, r.kind, r.project_id) THEN v_reason := 'preferences';
        END IF;
        IF v_reason IS NULL AND r.notification_id IS NOT NULL THEN
            SELECT * INTO n FROM public.notifications x WHERE x.id = r.notification_id AND x.recipient_id = r.user_id;
            IF NOT FOUND THEN v_reason := 'source_gone'; ELSE v_actor := n.actor_name; v_title := n.title; END IF;
        END IF;
        IF v_reason IS NULL AND r.kind <> 'project_removed'
           AND (r.project_id IS NULL OR public.project_role_of(r.project_id, r.user_id) IS NULL) THEN
            v_reason := 'no_access';
        END IF;
        IF v_reason IS NULL AND r.card_id IS NOT NULL THEN
            SELECT * INTO k FROM public.cards x WHERE x.id = r.card_id;
            IF NOT FOUND OR k.project_id IS DISTINCT FROM r.project_id THEN v_reason := 'card_gone';
            ELSIF coalesce(k.archived, false) THEN v_reason := 'card_archived';
            ELSE v_title := k.title;
            END IF;
        END IF;
        IF v_reason IS NULL AND r.kind IN ('assignment', 'due_soon', 'task_completed', 'task_due_changed') AND NOT EXISTS (
               SELECT 1 FROM public.card_assignees ca JOIN public.workspace_members wm ON wm.id = ca.member_id
                WHERE ca.card_id = r.card_id AND wm.profile_id = r.user_id) THEN
            v_reason := 'not_assigned';
        END IF;
        IF v_reason IS NULL AND r.activity_id IS NOT NULL THEN
            SELECT * INTO a FROM public.activity_logs x WHERE x.id = r.activity_id;
            IF NOT FOUND THEN v_reason := 'source_gone';
            ELSE v_actor := a.actor_name; IF r.kind = 'task_due_changed' THEN v_new_due := a.details ->> 'to'; END IF;
            END IF;
        END IF;
        IF v_reason IS NULL AND r.kind = 'due_soon' THEN
            IF public.iso_date_or_null(k.due_date) IS DISTINCT FROM r.due_date THEN v_reason := 'due_changed';
            ELSIF public.collab_is_done_column(k.column_id) THEN v_reason := 'done';
            ELSIF v_now >= public.notify_due_window_end(r.due_date) THEN v_reason := 'expired';
            END IF;
        END IF;
        IF v_reason IS NOT NULL THEN
            UPDATE public.notification_deliveries d SET status = 'cancelled', last_error_code = v_reason, updated_at = now() WHERE d.id = r.id;
            CONTINUE;
        END IF;
        UPDATE public.notification_deliveries d
           SET status = 'sending', attempts = d.attempts + 1, lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 900)),
               updated_at = now()
         WHERE d.id = r.id;
        RETURN QUERY SELECT r.id, ch.provider, ch.id, r.user_id, ch.secret_enc, r.kind, r.attempts + 1, v_actor,
            coalesce(v_title, (SELECT p.name FROM public.projects p WHERE p.id = r.project_id)),
            (SELECT p.name FROM public.projects p WHERE p.id = r.project_id), r.project_id, r.card_id, r.due_date, v_new_due,
            coalesce((SELECT p.hide_titles FROM public.notification_preferences p WHERE p.user_id = r.user_id), false);
    END LOOP;
END $$;

-- Outcome of one claimed delivery. retry: backoff 1 / 5 / 15 / 60 min (or the provider's Retry-After when longer), max 5 attempts.
-- release: put back without counting the attempt (rate limited before it was tried). cancelled: e.g. the provider is switched off.
-- reconnect / blocked: the channel is unusable, its other queued deliveries are cancelled.
CREATE OR REPLACE FUNCTION public.notify_dispatch_result(p_id UUID, p_outcome TEXT, p_error_code TEXT, p_retry_seconds INTEGER)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    r public.notification_deliveries%ROWTYPE;
    v_status TEXT;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'retry', 'release', 'failed', 'cancelled', 'reconnect', 'blocked')
       OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
        RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.notification_deliveries d WHERE d.id = p_id AND d.status = 'sending' FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_leased'; END IF;
    v_status := CASE
        WHEN p_outcome = 'sent' THEN 'sent'
        WHEN p_outcome = 'cancelled' THEN 'cancelled'
        WHEN p_outcome = 'release' THEN 'pending'
        WHEN p_outcome = 'retry' AND r.attempts < 5 THEN 'pending'
        ELSE 'failed' END;
    -- never put a message back for a channel that meanwhile became unusable (paused, blocked, reconnect, removed)
    IF v_status = 'pending' AND NOT EXISTS (SELECT 1 FROM public.notification_channels c WHERE c.id = r.channel_id AND c.status = 'active' AND c.enabled) THEN
        v_status := 'cancelled';
        p_outcome := 'cancelled';
        p_error_code := 'channel_inactive';
    END IF;
    UPDATE public.notification_deliveries d
       SET status = v_status, lease_until = NULL, updated_at = now(),
           attempts = CASE WHEN p_outcome = 'release' THEN greatest(d.attempts - 1, 0) ELSE d.attempts END,
           last_error_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE coalesce(p_error_code, p_outcome) END,
           next_attempt_at = CASE WHEN v_status = 'pending' THEN now() + make_interval(secs => greatest(
               least(coalesce(p_retry_seconds, 0), 86400),
               CASE WHEN p_outcome = 'release' THEN 0 WHEN r.attempts <= 1 THEN 60 WHEN r.attempts = 2 THEN 300 WHEN r.attempts = 3 THEN 900 ELSE 3600 END))
               ELSE d.next_attempt_at END
     WHERE d.id = r.id;
    IF p_outcome = 'sent' THEN
        UPDATE public.notification_channels c SET last_sent_at = now(), last_error_code = NULL WHERE c.id = r.channel_id;
    ELSIF p_outcome IN ('reconnect', 'blocked') THEN
        UPDATE public.notification_channels c SET status = p_outcome, last_error_code = coalesce(p_error_code, p_outcome), updated_at = now()
         WHERE c.id = r.channel_id AND c.status = 'active';
        UPDATE public.notification_deliveries d SET status = 'cancelled', last_error_code = 'channel_inactive', updated_at = now()
         WHERE d.channel_id = r.channel_id AND d.status = 'pending';
    ELSIF v_status = 'failed' THEN
        UPDATE public.notification_channels c SET last_error_code = coalesce(p_error_code, p_outcome) WHERE c.id = r.channel_id;
    END IF;
    RETURN v_status;
END $$;

-- The app's answer for one batch: [{ "id": uuid, "outcome": ..., "code": ..., "retryAfter": seconds }]. Malformed entries are skipped.
CREATE OR REPLACE FUNCTION public.notify_dispatch_apply(p_results JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    e JSONB;
    v_n INTEGER := 0;
BEGIN
    IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN RETURN 0; END IF;
    FOR e IN SELECT x FROM jsonb_array_elements(p_results) x LIMIT 100 LOOP
        BEGIN
            IF e ->> 'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                PERFORM public.notify_dispatch_result((e ->> 'id')::uuid, e ->> 'outcome', e ->> 'code',
                    CASE WHEN e ->> 'retryAfter' ~ '^[0-9]{1,6}$' THEN (e ->> 'retryAfter')::int END);
                v_n := v_n + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;   -- one bad entry never blocks the others (its lease expires -> ambiguous)
        END;
    END LOOP;
    RETURN v_n;
END $$;

-- One scheduler tick (pg_cron every minute; notify-stack.sh tick by hand). p_now: test clock for due-date reminders only.
-- Needs pg_net + Vault (supabase/ops/notify_scheduler_enable.sql); without them it only collects/prepares and sends nothing.
CREATE OR REPLACE FUNCTION public.notify_scheduler_tick(p_now TIMESTAMP WITH TIME ZONE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    run public.notification_dispatch_runs%ROWTYPE;
    v_status INTEGER;
    v_content TEXT;
    v_found BOOLEAN;
    v_applied INTEGER := 0;
    v_disabled INTEGER := 0;
    v_prep JSONB;
    v_url TEXT;
    v_secret TEXT;
    v_items JSONB;
    v_ids UUID[];
    v_req BIGINT;
    v_n INTEGER;
BEGIN
    -- 1. collect answers of earlier batches
    IF to_regclass('net._http_response') IS NOT NULL THEN
        FOR run IN SELECT * FROM public.notification_dispatch_runs ORDER BY created_at LOOP
            EXECUTE 'SELECT true, r.status_code, r.content FROM net._http_response r WHERE r.id = $1' INTO v_found, v_status, v_content USING run.request_id;
            IF v_found IS NULL THEN
                IF run.created_at < now() - interval '15 minutes' THEN
                    DELETE FROM public.notification_dispatch_runs WHERE request_id = run.request_id;   -- answer lost: leases expire -> ambiguous
                END IF;
                CONTINUE;
            END IF;
            IF v_status = 200 THEN
                BEGIN
                    v_applied := v_applied + public.notify_dispatch_apply(v_content::jsonb -> 'results');
                EXCEPTION WHEN OTHERS THEN NULL;
                END;
            ELSIF v_status = 503 THEN
                -- both providers switched off in the app: nothing was sent; drop that batch (no stale messages later)
                UPDATE public.notification_deliveries d SET status = 'cancelled', last_error_code = 'provider_disabled', lease_until = NULL, updated_at = now()
                 WHERE d.id = ANY (run.delivery_ids) AND d.status = 'sending';
                GET DIAGNOSTICS v_n = ROW_COUNT; v_disabled := v_disabled + v_n;
            END IF;   -- anything else (timeout, 5xx, 401): leases expire -> ambiguous, never re-sent
            DELETE FROM public.notification_dispatch_runs WHERE request_id = run.request_id;
            v_found := NULL;
        END LOOP;
    END IF;
    -- 2. prepare
    v_prep := public.notify_dispatch_prepare(p_now);
    -- 3. claim + send (only when the scheduler is configured)
    IF to_regclass('vault.decrypted_secrets') IS NULL OR to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'scheduler', 'not_configured');
    END IF;
    EXECUTE $q$SELECT (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'clearspace_notify_url'),
                      (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'clearspace_notify_secret')$q$ INTO v_url, v_secret;
    IF v_url IS NULL OR v_secret IS NULL OR v_url !~ '^https?://' THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0, 'scheduler', 'not_configured');
    END IF;
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'provider', c.provider, 'channelId', c.channel_id, 'secret', c.secret_enc, 'kind', c.kind,
                                        'attempt', c.attempts, 'actor', c.actor_name, 'title', c.title, 'projectName', c.project_name,
                                        'projectId', c.project_id, 'cardId', c.card_id, 'dueDate', c.due_date, 'newDue', c.new_due,
                                        'hideTitles', c.hide_titles)),
           array_agg(c.id)
      INTO v_items, v_ids
      FROM public.notify_dispatch_claim(20, 300, p_now) c;
    IF v_ids IS NULL THEN
        RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', 0);
    END IF;
    EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 60000)' INTO v_req
      USING v_url, jsonb_build_object('items', v_items, 'now', p_now),
            jsonb_build_object('content-type', 'application/json', 'x-notify-secret', v_secret);
    INSERT INTO public.notification_dispatch_runs (request_id, delivery_ids) VALUES (v_req, v_ids);
    RETURN v_prep || jsonb_build_object('applied', v_applied, 'disabled', v_disabled, 'sent', cardinality(v_ids), 'request', v_req);
END $$;

REVOKE ALL ON FUNCTION public.notify_status(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_link_begin(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_slack_lookup(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_slack_complete(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_telegram_lookup(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_telegram_attach(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_telegram_confirm(TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_channel_set_enabled(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_channel_remove(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_test_begin(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_channel_mark(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.notify_prefs_set(TEXT, TEXT[], TEXT[], BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_status(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_link_begin(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_slack_lookup(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_slack_complete(TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_telegram_lookup(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_telegram_attach(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_telegram_confirm(TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_channel_set_enabled(TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_channel_remove(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_test_begin(TEXT, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_channel_mark(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_prefs_set(TEXT, TEXT[], TEXT[], BOOLEAN) TO authenticated;
-- the scheduler / dispatcher is internal: no client role can call it (only the owner: pg_cron, ops, tests)
REVOKE ALL ON FUNCTION public.notify_dispatch_prepare(TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_dispatch_claim(INTEGER, INTEGER, TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_dispatch_result(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_dispatch_apply(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_scheduler_tick(TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon, authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261129001500_notification_channels')
ON CONFLICT (version) DO NOTHING;
