-- ============================================================
-- 20261126001200 -- Google account connections + Google Drive links (RUN 02)
--
-- Apply AFTER 20261125001100, in a transaction. Idempotent (re-running is a no-op).
-- Rollback: supabase/rollback/20261126001200_google_drive.down.sql (refuses while it would lose data).
--
--   1. google_connections: one Google account per ClearSpace user (integration authorization, separate from
--      ClearSpace login). Tokens are stored ONLY as AES-256-GCM ciphertext produced by the server
--      (key in the server environment, never in the database). The table is invisible to anon/authenticated:
--      the browser sees a status projection through google_connection_status(); everything else goes through
--      SECURITY DEFINER RPCs that require the server secret (server_trust purpose 'google') AND act only on
--      the caller's own row (auth.uid()). No anonymous RPC: the OAuth completion runs under the user's session.
--   2. google_oauth_states: single-use, 10-minute OAuth transactions bound to the initiating user (begin AND
--      completion are authenticated calls by the same user) and to the initiating browser (HttpOnly cookie nonce).
--   3. integration_audit: connect / reconnect / disconnect / provider revocation, readable by the user (own rows).
--   4. external_resource_links: a project- or task-level link to an external file (provider 'google_drive').
--      Metadata is written only by the server (from the Drive API, never from the client): insert/refresh are
--      server-secret RPCs that also enforce can_edit_project(). Members read (RLS), editors remove, viewers are
--      read-only (existing viewer guard). Changes: trusted activity events, child_rev for task links, and a
--      signal-only broadcast on the private project topic.
--
-- Data impact: additive only. No existing row is changed.
-- ============================================================

DO $$
DECLARE
    v_missing TEXT := '';
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261125001100_collab_hardening') THEN
        v_missing := v_missing || ' migration:20261125001100_collab_hardening(apply it first)';
    END IF;
    IF to_regprocedure('public.require_server_secret(text,text)') IS NULL THEN v_missing := v_missing || ' fn:require_server_secret'; END IF;
    IF to_regprocedure('public.can_edit_project(text)') IS NULL THEN v_missing := v_missing || ' fn:can_edit_project'; END IF;
    IF to_regprocedure('public.collab_emit(text,text,text,text,text,jsonb)') IS NULL THEN v_missing := v_missing || ' fn:collab_emit'; END IF;
    IF to_regprocedure('public.collab_send(text,text,jsonb)') IS NULL THEN v_missing := v_missing || ' fn:collab_send'; END IF;
    IF to_regprocedure('public.collab_guard_write()') IS NULL THEN v_missing := v_missing || ' fn:collab_guard_write'; END IF;
    IF to_regprocedure('public.collab_touch_card()') IS NULL THEN v_missing := v_missing || ' fn:collab_touch_card'; END IF;
    IF to_regclass('auth.users') IS NULL THEN v_missing := v_missing || ' table:auth.users'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- Google Drive integration cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Connections (credentials: ciphertext only, no client access at all)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.google_connections (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    google_sub TEXT NOT NULL CHECK (google_sub ~ '^[0-9]{1,64}$' OR google_sub ~ '^[A-Za-z0-9_-]{1,64}$'),
    google_email TEXT NOT NULL CHECK (char_length(google_email) BETWEEN 3 AND 320),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 20),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
    -- AES-256-GCM envelopes "v1.<key id>.<iv>.<ciphertext>.<tag>" (base64url), bound to user + purpose (AAD)
    refresh_token_enc TEXT NOT NULL CHECK (refresh_token_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND char_length(refresh_token_enc) <= 4096),
    access_token_enc TEXT CHECK (access_token_enc IS NULL OR (access_token_enc ~ '^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND char_length(access_token_enc) <= 8192)),
    access_expires_at TIMESTAMP WITH TIME ZONE,
    token_version BIGINT NOT NULL DEFAULT 1,
    refresh_lock_until TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT CHECK (char_length(last_error_code) <= 64),
    api_window_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    api_window_count INTEGER NOT NULL DEFAULT 0,
    connected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
-- One Google account <-> one ClearSpace account: revoking one grant at Google revokes the app's access for that
-- Google account everywhere, so sharing it between ClearSpace accounts would let one disconnect break another.
CREATE UNIQUE INDEX IF NOT EXISTS google_connections_sub ON public.google_connections (google_sub);
ALTER TABLE public.google_connections ENABLE ROW LEVEL SECURITY; -- no policy: invisible through the API
REVOKE ALL ON public.google_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.google_connections TO service_role;

CREATE TABLE IF NOT EXISTS public.google_oauth_states (
    state_sha256 TEXT PRIMARY KEY CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    binding_sha256 TEXT NOT NULL CHECK (binding_sha256 ~ '^[0-9a-f]{64}$'),
    code_verifier_enc TEXT NOT NULL CHECK (char_length(code_verifier_enc) <= 1024),
    return_to TEXT NOT NULL CHECK (return_to ~ '^/[A-Za-z0-9/_-]{0,200}$'),
    scopes TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 20),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_states_user ON public.google_oauth_states (user_id, created_at DESC);
ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.google_oauth_states TO service_role;

CREATE TABLE IF NOT EXISTS public.integration_audit (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('google')),
    event TEXT NOT NULL CHECK (event IN ('connected', 'reconnected', 'disconnected', 'revoked_by_provider', 'refresh_failed', 'scope_denied')),
    detail TEXT CHECK (char_length(detail) <= 120),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_audit_user ON public.integration_audit (user_id, created_at DESC);
ALTER TABLE public.integration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.integration_audit TO authenticated;
GRANT ALL ON public.integration_audit TO service_role;
DROP POLICY IF EXISTS "integration_audit_own" ON public.integration_audit;
CREATE POLICY "integration_audit_own" ON public.integration_audit FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Status projection for the browser: never a token, never the token metadata.
CREATE OR REPLACE FUNCTION public.google_connection_status()
RETURNS TABLE (google_email TEXT, scopes TEXT[], status TEXT, connected_at TIMESTAMP WITH TIME ZONE, last_error_code TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT g.google_email, g.scopes, g.status, g.connected_at, g.last_error_code
    FROM public.google_connections g WHERE g.user_id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.google_connection_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.google_connection_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.google_require_user()
RETURNS UUID
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    RETURN auth.uid();
END $$;
REVOKE ALL ON FUNCTION public.google_require_user() FROM PUBLIC, anon, authenticated;

-- OAuth begin: authenticated caller + server secret. At most 10 open transactions per 10 minutes.
CREATE OR REPLACE FUNCTION public.google_oauth_begin(
    p_server_secret TEXT, p_state_sha256 TEXT, p_binding_sha256 TEXT, p_code_verifier_enc TEXT, p_return_to TEXT, p_scopes TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    DELETE FROM public.google_oauth_states s WHERE s.expires_at < now() - interval '1 day';
    IF (SELECT count(*) FROM public.google_oauth_states s WHERE s.user_id = v_uid AND s.created_at > now() - interval '10 minutes') >= 10 THEN
        RAISE EXCEPTION 'Příliš mnoho pokusů o připojení. Zkuste to prosím za několik minut.' USING ERRCODE = 'PT429';
    END IF;
    INSERT INTO public.google_oauth_states (state_sha256, user_id, binding_sha256, code_verifier_enc, return_to, scopes, expires_at)
    VALUES (p_state_sha256, v_uid, p_binding_sha256, p_code_verifier_enc, p_return_to, p_scopes, now() + interval '10 minutes');
END $$;

-- OAuth completion, step 1: consume the state exactly once. Bound three ways: the signed-in ClearSpace user who
-- began it (auth.uid()), the browser (hash of the HttpOnly nonce cookie) and a 10-minute lifetime.
CREATE OR REPLACE FUNCTION public.google_oauth_consume(p_server_secret TEXT, p_state_sha256 TEXT, p_binding_sha256 TEXT)
RETURNS TABLE (user_id UUID, code_verifier_enc TEXT, return_to TEXT, scopes TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    RETURN QUERY
    UPDATE public.google_oauth_states s SET consumed_at = now()
    WHERE s.state_sha256 = p_state_sha256 AND s.binding_sha256 = p_binding_sha256 AND s.user_id = auth.uid()
      AND s.consumed_at IS NULL AND s.expires_at > now()
    RETURNING s.user_id, s.code_verifier_enc, s.return_to, s.scopes;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Požadavek na připojení vypršel nebo už byl použit.' USING ERRCODE = '22023';
    END IF;
END $$;

-- OAuth completion, step 2: store the connection for the user of a just-consumed state (once per state).
-- p_refresh_token_enc NULL = Google returned no new refresh token: keep the stored one (same Google account only).
CREATE OR REPLACE FUNCTION public.google_oauth_complete(
    p_server_secret TEXT, p_state_sha256 TEXT, p_sub TEXT, p_email TEXT, p_scopes TEXT[],
    p_refresh_token_enc TEXT, p_access_token_enc TEXT, p_access_expires_at TIMESTAMP WITH TIME ZONE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_old public.google_connections%ROWTYPE;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    UPDATE public.google_oauth_states s SET completed_at = now()
    WHERE s.state_sha256 = p_state_sha256 AND s.consumed_at IS NOT NULL AND s.completed_at IS NULL
      AND s.consumed_at > now() - interval '5 minutes' AND s.user_id = auth.uid()
    RETURNING s.user_id INTO v_uid;
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Požadavek na připojení vypršel nebo už byl použit.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.google_connections g WHERE g.google_sub = p_sub AND g.user_id <> v_uid) THEN
        RAISE EXCEPTION 'Tento účet Google je už připojený k jinému účtu ClearSpace.' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_old FROM public.google_connections g WHERE g.user_id = v_uid FOR UPDATE;
    IF p_refresh_token_enc IS NULL AND (v_old.user_id IS NULL OR v_old.google_sub <> p_sub) THEN
        RAISE EXCEPTION 'Google nevrátil trvalé oprávnění. Připojte účet prosím znovu.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.google_connections AS g
        (user_id, google_sub, google_email, scopes, status, refresh_token_enc, access_token_enc, access_expires_at,
         token_version, refresh_lock_until, last_error_code, connected_at, updated_at)
    VALUES (v_uid, p_sub, left(p_email, 320), p_scopes, 'active', p_refresh_token_enc, p_access_token_enc, p_access_expires_at,
            1, NULL, NULL, now(), now())
    ON CONFLICT (user_id) DO UPDATE
       SET google_sub = EXCLUDED.google_sub, google_email = EXCLUDED.google_email, scopes = EXCLUDED.scopes,
           status = 'active',
           refresh_token_enc = coalesce(p_refresh_token_enc, g.refresh_token_enc),
           access_token_enc = EXCLUDED.access_token_enc, access_expires_at = EXCLUDED.access_expires_at,
           token_version = g.token_version + 1, refresh_lock_until = NULL, last_error_code = NULL,
           connected_at = CASE WHEN g.google_sub = EXCLUDED.google_sub THEN g.connected_at ELSE now() END,
           updated_at = now();
    INSERT INTO public.integration_audit (user_id, provider, event)
    VALUES (v_uid, 'google', CASE WHEN v_old.user_id IS NULL THEN 'connected' ELSE 'reconnected' END);
    RETURN (SELECT s.return_to FROM public.google_oauth_states s WHERE s.state_sha256 = p_state_sha256);
END $$;

-- Audit an OAuth outcome that stored nothing (the user unticked the Drive permission).
CREATE OR REPLACE FUNCTION public.google_oauth_audit_denied(p_server_secret TEXT, p_state_sha256 TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    INSERT INTO public.integration_audit (user_id, provider, event)
    SELECT s.user_id, 'google', 'scope_denied' FROM public.google_oauth_states s
    WHERE s.state_sha256 = p_state_sha256 AND s.consumed_at IS NOT NULL AND s.consumed_at > now() - interval '5 minutes'
      AND s.user_id = public.google_require_user();
END $$;

-- The caller's own credentials (server only). Counts one unit of the caller's Google API budget.
CREATE OR REPLACE FUNCTION public.google_credentials_get(p_server_secret TEXT, p_cost INTEGER DEFAULT 1)
RETURNS TABLE (user_id UUID, status TEXT, scopes TEXT[], refresh_token_enc TEXT, access_token_enc TEXT,
               access_expires_at TIMESTAMP WITH TIME ZONE, token_version BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_n INTEGER;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF p_cost IS NULL OR p_cost < 0 OR p_cost > 50 THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    -- 300 Google API calls per user per 10 minutes (bounded refresh/attach; protects the shared project quota)
    UPDATE public.google_connections g
       SET api_window_count = CASE WHEN g.api_window_start < now() - interval '10 minutes' THEN p_cost ELSE g.api_window_count + p_cost END,
           api_window_start = CASE WHEN g.api_window_start < now() - interval '10 minutes' THEN now() ELSE g.api_window_start END
     WHERE g.user_id = v_uid
     RETURNING g.api_window_count INTO v_n;
    IF v_n IS NOT NULL AND v_n > 300 THEN
        RAISE EXCEPTION 'Příliš mnoho požadavků na Google Disk. Zkuste to prosím za několik minut.' USING ERRCODE = 'PT429';
    END IF;
    RETURN QUERY SELECT g.user_id, g.status, g.scopes, g.refresh_token_enc, g.access_token_enc, g.access_expires_at, g.token_version
                 FROM public.google_connections g WHERE g.user_id = v_uid;
END $$;

-- Refresh lease: exactly one request refreshes; the others wait for the new token_version.
CREATE OR REPLACE FUNCTION public.google_refresh_lease(p_server_secret TEXT, p_token_version BIGINT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    UPDATE public.google_connections g SET refresh_lock_until = now() + interval '20 seconds'
    WHERE g.user_id = public.google_require_user() AND g.token_version = p_token_version AND g.status = 'active'
      AND (g.refresh_lock_until IS NULL OR g.refresh_lock_until < now());
    RETURN FOUND;
END $$;

-- Store a refreshed token (only if nobody else stored one meanwhile). NULL refresh = keep the stored one.
CREATE OR REPLACE FUNCTION public.google_refresh_store(
    p_server_secret TEXT, p_token_version BIGINT, p_access_token_enc TEXT, p_access_expires_at TIMESTAMP WITH TIME ZONE,
    p_refresh_token_enc TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    UPDATE public.google_connections g
       SET access_token_enc = p_access_token_enc, access_expires_at = p_access_expires_at,
           refresh_token_enc = coalesce(p_refresh_token_enc, g.refresh_token_enc),
           token_version = g.token_version + 1, refresh_lock_until = NULL, last_error_code = NULL, updated_at = now()
     WHERE g.user_id = public.google_require_user() AND g.token_version = p_token_version;
    RETURN FOUND;
END $$;

-- Provider refused the credentials (invalid_grant = revoked / expired) or a refresh failed. Always releases the
-- refresh lease; audited only when the status changes.
CREATE OR REPLACE FUNCTION public.google_connection_mark(p_server_secret TEXT, p_status TEXT, p_error_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_old TEXT;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF p_status NOT IN ('active', 'revoked', 'error') THEN RAISE EXCEPTION 'Neplatný stav.' USING ERRCODE = '22023'; END IF;
    SELECT g.status INTO v_old FROM public.google_connections g WHERE g.user_id = v_uid FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.google_connections g
       SET status = p_status, last_error_code = left(p_error_code, 64), refresh_lock_until = NULL,
           access_token_enc = CASE WHEN p_status = 'revoked' THEN NULL ELSE g.access_token_enc END,
           access_expires_at = CASE WHEN p_status = 'revoked' THEN NULL ELSE g.access_expires_at END,
           updated_at = now()
     WHERE g.user_id = v_uid;
    IF v_old IS DISTINCT FROM p_status AND p_status <> 'active' THEN
        INSERT INTO public.integration_audit (user_id, provider, event, detail)
        VALUES (v_uid, 'google', CASE p_status WHEN 'revoked' THEN 'revoked_by_provider' ELSE 'refresh_failed' END, left(p_error_code, 120));
    END IF;
END $$;

-- Disconnect: removes the credentials (the server revokes them at Google first, best effort).
-- Links stay: they are project data, and nobody gains or loses Drive access by this.
CREATE OR REPLACE FUNCTION public.google_disconnect(p_server_secret TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    DELETE FROM public.google_connections g WHERE g.user_id = v_uid;
    IF FOUND THEN
        INSERT INTO public.integration_audit (user_id, provider, event) VALUES (v_uid, 'google', 'disconnected');
        RETURN true;
    END IF;
    RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.google_oauth_begin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_oauth_consume(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_oauth_complete(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TIMESTAMP WITH TIME ZONE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_oauth_audit_denied(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_credentials_get(TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_refresh_lease(TEXT, BIGINT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_refresh_store(TEXT, BIGINT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_connection_mark(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_disconnect(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.google_oauth_begin(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;
-- completion runs under the user's ClearSpace session (POST /api/google/oauth/complete), never anonymously
GRANT EXECUTE ON FUNCTION public.google_oauth_consume(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_oauth_complete(TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, TEXT, TIMESTAMP WITH TIME ZONE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_oauth_audit_denied(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_credentials_get(TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_refresh_lease(TEXT, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_refresh_store(TEXT, BIGINT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_connection_mark(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_disconnect(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 2. External resource links (project- or task-level)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.external_resource_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    card_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'google_drive' CHECK (provider IN ('google_drive')),
    external_id TEXT NOT NULL CHECK (external_id ~ '^[A-Za-z0-9_-]{10,200}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300 AND name !~ '[[:cntrl:]]'),
    mime_type TEXT NOT NULL CHECK (char_length(mime_type) <= 200 AND mime_type ~ '^[a-z0-9.+-]+/[A-Za-z0-9.+_-]+$'),
    -- canonical Google URL only (never a client-supplied link): https on drive.google.com / docs.google.com
    web_url TEXT NOT NULL CHECK (char_length(web_url) <= 500 AND web_url ~ '^https://(drive|docs)\.google\.com/[A-Za-z0-9/_?=&.%-]*$'),
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    modified_at TIMESTAMP WITH TIME ZONE,
    provider_state TEXT NOT NULL DEFAULT 'ok' CHECK (provider_state IN ('ok', 'trashed')),
    metadata_checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    linked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    linked_by_name TEXT NOT NULL DEFAULT 'Uživatel' CHECK (char_length(linked_by_name) <= 200),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
-- No duplicate of the same file on the same project / task (a project-level and a task-level link may coexist).
CREATE UNIQUE INDEX IF NOT EXISTS external_resource_links_unique
    ON public.external_resource_links (project_id, coalesce(card_id, ''), provider, external_id);
CREATE INDEX IF NOT EXISTS idx_external_resource_links_card ON public.external_resource_links (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_resource_links_project ON public.external_resource_links (project_id, created_at DESC);

ALTER TABLE public.external_resource_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_resource_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.external_resource_links TO authenticated;  -- INSERT/UPDATE: server RPCs only
GRANT ALL ON public.external_resource_links TO service_role;
DROP POLICY IF EXISTS "external_links_select" ON public.external_resource_links;
CREATE POLICY "external_links_select" ON public.external_resource_links FOR SELECT TO authenticated
    USING (public.is_project_member(project_id));
DROP POLICY IF EXISTS "external_links_delete" ON public.external_resource_links;
CREATE POLICY "external_links_delete" ON public.external_resource_links FOR DELETE TO authenticated
    USING (public.can_edit_project(project_id));

-- Task links: project follows the card (also on a cross-project move).
CREATE OR REPLACE FUNCTION public.external_links_server_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.card_id IS NOT NULL THEN
        NEW.project_id := (SELECT c.project_id FROM public.cards c WHERE c.id = NEW.card_id);
        IF NEW.project_id IS NULL THEN RAISE EXCEPTION 'Úkol nebyl nalezen.' USING ERRCODE = '22023'; END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.external_links_server_fields() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS a_external_links_server_fields ON public.external_resource_links;
CREATE TRIGGER a_external_links_server_fields BEFORE INSERT OR UPDATE ON public.external_resource_links
    FOR EACH ROW EXECUTE FUNCTION public.external_links_server_fields();

CREATE OR REPLACE FUNCTION public.external_links_follow_card()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
        UPDATE public.external_resource_links l SET project_id = NEW.project_id WHERE l.card_id = NEW.id;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_follow_card() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS external_links_follow_card ON public.cards;
CREATE TRIGGER external_links_follow_card AFTER UPDATE OF column_id ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.external_links_follow_card();

-- Viewer read-only (shared guard) + child_rev for task links (task drawer / history refresh).
DROP TRIGGER IF EXISTS b_collab_guard_write ON public.external_resource_links;
CREATE TRIGGER b_collab_guard_write BEFORE INSERT OR UPDATE OR DELETE ON public.external_resource_links
    FOR EACH ROW EXECUTE FUNCTION public.collab_guard_write();
DROP TRIGGER IF EXISTS z_collab_touch_card ON public.external_resource_links;
CREATE TRIGGER z_collab_touch_card AFTER INSERT OR UPDATE OR DELETE ON public.external_resource_links
    FOR EACH ROW EXECUTE FUNCTION public.collab_touch_card();

-- Events (trusted, from the persisted row) + signal-only broadcast (ids, no names or links).
CREATE OR REPLACE FUNCTION public.external_links_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.external_resource_links%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.project_id, 'drive_file_linked', CASE WHEN NEW.card_id IS NULL THEN 'project' ELSE 'task' END,
            NEW.id::text, NEW.card_id, jsonb_build_object(
                'name', NEW.name, 'mime', NEW.mime_type, 'link_id', NEW.id,
                'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id)));
    ELSIF TG_OP = 'DELETE' THEN
        -- the task or project is being deleted with it: the deletion is the event, not N unlinks
        IF (OLD.card_id IS NULL OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id))
           AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
            PERFORM public.collab_emit(OLD.project_id, 'drive_file_unlinked', CASE WHEN OLD.card_id IS NULL THEN 'project' ELSE 'task' END,
                OLD.id::text, OLD.card_id, jsonb_build_object(
                    'name', OLD.name, 'link_id', OLD.id,
                    'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id)));
        END IF;
    END IF;
    -- metadata refreshes (UPDATE) are routine: no event, only the signal
    PERFORM public.collab_send(public.collab_project_topic(v_row.project_id), 'change',
        jsonb_build_object('t', 'links', 'op', lower(TG_OP), 'card', v_row.card_id));
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'links', 'op', 'delete', 'card', OLD.card_id));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_events() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_external_links_events ON public.external_resource_links;
CREATE TRIGGER z_external_links_events AFTER INSERT OR UPDATE OR DELETE ON public.external_resource_links
    FOR EACH ROW EXECUTE FUNCTION public.external_links_events();

-- Attach: server secret (metadata came from the Drive API on the server) + caller may edit the project.
-- Returns the existing row on a duplicate (idempotent double-click / retry), flagged duplicate = true.
CREATE OR REPLACE FUNCTION public.drive_link_add(
    p_server_secret TEXT, p_project_id TEXT, p_card_id TEXT, p_external_id TEXT, p_name TEXT, p_mime_type TEXT,
    p_web_url TEXT, p_size_bytes BIGINT, p_modified_at TIMESTAMP WITH TIME ZONE, p_provider_state TEXT)
RETURNS TABLE (id UUID, duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_pid TEXT := p_project_id;
    v_id UUID;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF p_card_id IS NOT NULL THEN
        SELECT c.project_id INTO v_pid FROM public.cards c WHERE c.id = p_card_id;
        IF v_pid IS NULL OR v_pid IS DISTINCT FROM p_project_id THEN
            RAISE EXCEPTION 'Úkol do tohoto projektu nepatří.' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF NOT public.can_edit_project(v_pid) THEN
        RAISE EXCEPTION 'K tomuto projektu nemáte oprávnění přidávat soubory.' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.external_resource_links l
        WHERE l.linked_by = v_uid AND l.created_at > now() - interval '10 minutes') >= 60 THEN
        RAISE EXCEPTION 'Příliš mnoho přidaných souborů. Zkuste to prosím za několik minut.' USING ERRCODE = 'PT429';
    END IF;
    SELECT l.id INTO v_id FROM public.external_resource_links l
    WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '')
      AND l.provider = 'google_drive' AND l.external_id = p_external_id;
    IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;
    INSERT INTO public.external_resource_links AS l
        (project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, modified_at, provider_state,
         metadata_checked_at, linked_by, linked_by_name)
    VALUES (v_pid, p_card_id, 'google_drive', p_external_id, p_name, p_mime_type, p_web_url, p_size_bytes, p_modified_at,
            coalesce(p_provider_state, 'ok'), now(), v_uid, left(public.collab_actor_name(v_pid, v_uid), 200))
    ON CONFLICT DO NOTHING
    RETURNING l.id INTO v_id;
    IF v_id IS NULL THEN -- lost a race with an identical attach
        SELECT l.id INTO v_id FROM public.external_resource_links l
        WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '')
          AND l.provider = 'google_drive' AND l.external_id = p_external_id;
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;
    RETURN QUERY SELECT v_id, false;
END $$;

-- Metadata refresh by an editor who CAN see the file at Google (the caller's own token). A caller without access
-- never writes: with drive.file Google answers 404 both for "deleted" and "not granted to you", so "I cannot open
-- it" is that user's state, not the file's. Only facts read from an accessible file are stored (name, trashed...).
CREATE OR REPLACE FUNCTION public.drive_link_refresh(
    p_server_secret TEXT, p_link_id UUID, p_name TEXT, p_mime_type TEXT, p_web_url TEXT, p_size_bytes BIGINT,
    p_modified_at TIMESTAMP WITH TIME ZONE, p_provider_state TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pid TEXT;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    SELECT l.project_id INTO v_pid FROM public.external_resource_links l WHERE l.id = p_link_id;
    IF v_pid IS NULL OR NOT public.can_edit_project(v_pid) THEN
        RAISE EXCEPTION 'K tomuto souboru nemáte oprávnění.' USING ERRCODE = '42501';
    END IF;
    UPDATE public.external_resource_links l
       SET name = p_name, mime_type = p_mime_type, web_url = p_web_url, size_bytes = p_size_bytes,
           modified_at = p_modified_at, provider_state = p_provider_state, metadata_checked_at = now()
     WHERE l.id = p_link_id
       AND (l.name, l.mime_type, l.web_url, l.size_bytes, l.modified_at, l.provider_state)
           IS DISTINCT FROM (p_name, p_mime_type, p_web_url, p_size_bytes, p_modified_at, p_provider_state);
    IF NOT FOUND THEN
        -- unchanged: only stamp the check time, without a row change signal storm (no trigger work for no-ops)
        UPDATE public.external_resource_links l SET metadata_checked_at = now()
        WHERE l.id = p_link_id AND l.metadata_checked_at < now() - interval '1 minute';
        RETURN false;
    END IF;
    RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.drive_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.drive_link_refresh(TEXT, UUID, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.drive_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.drive_link_refresh(TEXT, UUID, TEXT, TEXT, TEXT, BIGINT, TIMESTAMP WITH TIME ZONE, TEXT) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261126001200_google_drive')
ON CONFLICT (version) DO NOTHING;
