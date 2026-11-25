-- ============================================================
-- 20261127001300 -- Gmail resources on projects and tasks (RUN 03)
--
-- Apply AFTER 20261126001200, in a transaction. Idempotent (re-running is a no-op).
-- Rollback: supabase/rollback/20261127001300_gmail.down.sql (refuses while it would lose data).
--
-- Privacy model (docs/run03/PRIVACY_AND_SECURITY.md):
--   * SHARED with project members (external_resource_links, RLS is_project_member): subject, sender display name (or
--     only the sender's domain), date, message count, attachment COUNT, who linked it and when. Never body, snippet,
--     recipients, addresses, attachment names, labels, nor any Gmail id.
--   * PRIVATE to the person who linked it (gmail_link_sources, no client access at all): the Gmail message/thread id and
--     the Google account (sub) it belongs to. Only that person's server requests can use it, only with THEIR OWN
--     token, only while the same Google account is connected with the Gmail permission.
--   * external_id of a Gmail link is an opaque server HMAC (dedupe per Google account + id); it reveals no Gmail id.
--   * Activity events of Gmail links carry no subject (kind + ids only), so removing a link leaves no subject behind.
--
--   1. integration_audit: + 'service_added', 'service_removed' (Gmail enabled / removed in ClearSpace).
--   2. external_resource_links: providers 'gmail_message' / 'gmail_thread', web_url NULL for Gmail (a Gmail link only
--      opens in the linker's own mailbox: it is built for them on request), provider_state + 'deleted', e-mail columns.
--   3. gmail_link_sources (private) + server-secret RPCs: gmail_link_add / _source / _refresh, gmail_links_purge_mine,
--      google_service_remove, google_service_audit, google_connection_sub.
--
-- Data impact: additive only. Existing Drive rows are unchanged and still satisfy every new constraint.
-- ============================================================

DO $$
DECLARE
    v_missing TEXT := '';
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261126001200_google_drive') THEN
        v_missing := v_missing || ' migration:20261126001200_google_drive(apply it first)';
    END IF;
    IF to_regclass('public.external_resource_links') IS NULL THEN v_missing := v_missing || ' table:external_resource_links'; END IF;
    IF to_regclass('public.google_connections') IS NULL THEN v_missing := v_missing || ' table:google_connections'; END IF;
    IF to_regprocedure('public.google_require_user()') IS NULL THEN v_missing := v_missing || ' fn:google_require_user'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- Gmail integration cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Audit events for per-service changes
-- ------------------------------------------------------------
ALTER TABLE public.integration_audit DROP CONSTRAINT IF EXISTS integration_audit_event_check;
ALTER TABLE public.integration_audit ADD CONSTRAINT integration_audit_event_check CHECK (event IN (
    'connected', 'reconnected', 'disconnected', 'revoked_by_provider', 'refresh_failed', 'scope_denied',
    'service_added', 'service_removed'));

-- ------------------------------------------------------------
-- 2. Shared link rows: Gmail providers
-- ------------------------------------------------------------
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_check
    CHECK (provider IN ('google_drive', 'gmail_message', 'gmail_thread'));
ALTER TABLE public.external_resource_links ALTER COLUMN web_url DROP NOT NULL;
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_web_url_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_web_url_check CHECK (
    (provider = 'google_drive' AND web_url IS NOT NULL AND char_length(web_url) <= 500
        AND web_url ~ '^https://(drive|docs)\.google\.com/[A-Za-z0-9/_?=&.%-]*$')
    OR (provider <> 'google_drive' AND web_url IS NULL));
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_provider_state_check;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_provider_state_check
    CHECK (provider_state IN ('ok', 'trashed', 'deleted'));
ALTER TABLE public.external_resource_links
    ADD COLUMN IF NOT EXISTS email_from TEXT CHECK (email_from IS NULL OR (char_length(email_from) BETWEEN 1 AND 200 AND email_from !~ '[[:cntrl:]]')),
    ADD COLUMN IF NOT EXISTS email_count INTEGER CHECK (email_count IS NULL OR email_count BETWEEN 1 AND 10000),
    ADD COLUMN IF NOT EXISTS email_attachments INTEGER CHECK (email_attachments IS NULL OR email_attachments BETWEEN 0 AND 10000);
ALTER TABLE public.external_resource_links DROP CONSTRAINT IF EXISTS external_resource_links_email_fields;
ALTER TABLE public.external_resource_links ADD CONSTRAINT external_resource_links_email_fields CHECK (
    provider LIKE 'gmail_%' OR (email_from IS NULL AND email_count IS NULL AND email_attachments IS NULL));

-- ------------------------------------------------------------
-- 3. Private source of a Gmail link (server only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gmail_link_sources (
    link_id UUID PRIMARY KEY REFERENCES public.external_resource_links(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    google_sub TEXT NOT NULL CHECK (google_sub ~ '^[A-Za-z0-9_-]{1,64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'thread')),
    gmail_id TEXT NOT NULL CHECK (gmail_id ~ '^[0-9a-f]{6,32}$'),
    thread_id TEXT NOT NULL CHECK (thread_id ~ '^[0-9a-f]{6,32}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gmail_link_sources_owner ON public.gmail_link_sources (owner_user_id);
ALTER TABLE public.gmail_link_sources ENABLE ROW LEVEL SECURITY;   -- no policy: invisible through the API
REVOKE ALL ON public.gmail_link_sources FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.gmail_link_sources TO service_role;

-- ------------------------------------------------------------
-- 4. Events: Gmail links are announced without their subject
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.external_links_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.external_resource_links%ROWTYPE;
    v_mail BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;
    v_mail := v_row.provider LIKE 'gmail_%';
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.project_id, CASE WHEN v_mail THEN 'email_linked' ELSE 'drive_file_linked' END,
            CASE WHEN NEW.card_id IS NULL THEN 'project' ELSE 'task' END, NEW.id::text, NEW.card_id,
            CASE WHEN v_mail
                THEN jsonb_build_object('kind', CASE NEW.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', NEW.id,
                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id))
                ELSE jsonb_build_object('name', NEW.name, 'mime', NEW.mime_type, 'link_id', NEW.id,
                                        'title', (SELECT c.title FROM public.cards c WHERE c.id = NEW.card_id)) END);
    ELSIF TG_OP = 'DELETE' THEN
        -- the task or project is being deleted with it: the deletion is the event, not N unlinks
        IF (OLD.card_id IS NULL OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id))
           AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
            PERFORM public.collab_emit(OLD.project_id, CASE WHEN v_mail THEN 'email_unlinked' ELSE 'drive_file_unlinked' END,
                CASE WHEN OLD.card_id IS NULL THEN 'project' ELSE 'task' END, OLD.id::text, OLD.card_id,
                CASE WHEN v_mail
                    THEN jsonb_build_object('kind', CASE OLD.provider WHEN 'gmail_thread' THEN 'thread' ELSE 'message' END, 'link_id', OLD.id,
                                            'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id))
                    ELSE jsonb_build_object('name', OLD.name, 'link_id', OLD.id,
                                            'title', (SELECT c.title FROM public.cards c WHERE c.id = OLD.card_id)) END);
        END IF;
    END IF;
    -- metadata refreshes (UPDATE) are routine: no event, only the signal (ids only, never names, subjects or links)
    PERFORM public.collab_send(public.collab_project_topic(v_row.project_id), 'change',
        jsonb_build_object('t', 'links', 'op', lower(TG_OP), 'card', v_row.card_id));
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'links', 'op', 'delete', 'card', OLD.card_id));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.external_links_events() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Server RPCs (server secret + the caller's own session; never anonymous)
-- ------------------------------------------------------------
-- The caller's Google account (sub) when it currently holds the Gmail permission in ClearSpace, else NULL.
CREATE OR REPLACE FUNCTION public.gmail_caller_sub()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT g.google_sub FROM public.google_connections g
    WHERE g.user_id = auth.uid() AND g.status = 'active'
      AND 'https://www.googleapis.com/auth/gmail.readonly' = ANY (g.scopes)
$$;
REVOKE ALL ON FUNCTION public.gmail_caller_sub() FROM PUBLIC, anon, authenticated;

-- Incremental consent (RUN 03): the caller's connected Google account, and whether the Google account that just
-- answered is connected to ANY ClearSpace account (then its grant must not be revoked: that would end the other connection).
CREATE OR REPLACE FUNCTION public.google_connection_sub(p_server_secret TEXT, p_candidate_sub TEXT)
RETURNS TABLE (own_sub TEXT, candidate_in_use BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    RETURN QUERY SELECT (SELECT g.google_sub FROM public.google_connections g WHERE g.user_id = auth.uid()),
                        EXISTS (SELECT 1 FROM public.google_connections g WHERE g.google_sub = p_candidate_sub);
END $$;

-- Remove one service permission from what ClearSpace uses (the grant itself stays at Google until the whole account is
-- disconnected: Google revokes grants only as a whole). Identity scopes cannot be removed this way.
CREATE OR REPLACE FUNCTION public.google_service_remove(p_server_secret TEXT, p_scope TEXT)
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
    IF p_scope NOT IN ('https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.file') THEN
        RAISE EXCEPTION 'Neplatná služba.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.google_connections g SET scopes = array_remove(g.scopes, p_scope), updated_at = now()
    WHERE g.user_id = v_uid AND p_scope = ANY (g.scopes) AND cardinality(g.scopes) > 1;
    IF NOT FOUND THEN RETURN false; END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail)
    VALUES (v_uid, 'google', 'service_removed', CASE WHEN p_scope LIKE '%gmail%' THEN 'gmail' ELSE 'drive' END);
    RETURN true;
END $$;

-- Audit a per-service outcome of an OAuth round trip (service added, or the user unticked it on Google's screen).
CREATE OR REPLACE FUNCTION public.google_service_audit(p_server_secret TEXT, p_event TEXT, p_service TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    IF p_event NOT IN ('service_added', 'scope_denied') OR p_service NOT IN ('gmail', 'drive') THEN
        RAISE EXCEPTION 'Neplatná událost.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.integration_audit (user_id, provider, event, detail) VALUES (public.google_require_user(), 'google', p_event, p_service);
END $$;

-- Attach a message / thread the caller selected in their own mailbox. The server read the metadata from Gmail with the
-- caller's OWN token; the database re-checks: Gmail permission present, same Google account, edit rights, rate limit.
CREATE OR REPLACE FUNCTION public.gmail_link_add(
    p_server_secret TEXT, p_project_id TEXT, p_card_id TEXT, p_kind TEXT, p_ref TEXT, p_google_sub TEXT,
    p_gmail_id TEXT, p_thread_id TEXT, p_subject TEXT, p_from TEXT, p_date TIMESTAMP WITH TIME ZONE,
    p_count INTEGER, p_attachments INTEGER, p_state TEXT)
RETURNS TABLE (id UUID, duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_pid TEXT := p_project_id;
    v_id UUID;
    v_provider TEXT;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    IF p_kind NOT IN ('message', 'thread') THEN RAISE EXCEPTION 'Neplatný požadavek.' USING ERRCODE = '22023'; END IF;
    v_provider := 'gmail_' || p_kind;
    IF public.gmail_caller_sub() IS DISTINCT FROM p_google_sub THEN
        RAISE EXCEPTION 'Gmail není ve vašem účtu Google připojený.' USING ERRCODE = '42501';
    END IF;
    IF p_card_id IS NOT NULL THEN
        SELECT c.project_id INTO v_pid FROM public.cards c WHERE c.id = p_card_id;
        IF v_pid IS NULL OR v_pid IS DISTINCT FROM p_project_id THEN
            RAISE EXCEPTION 'Úkol do tohoto projektu nepatří.' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF NOT public.can_edit_project(v_pid) THEN
        RAISE EXCEPTION 'K tomuto projektu nemáte oprávnění připojovat e-maily.' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.external_resource_links l
        WHERE l.linked_by = v_uid AND l.created_at > now() - interval '10 minutes') >= 60 THEN
        RAISE EXCEPTION 'Příliš mnoho připojených položek. Zkuste to prosím za několik minut.' USING ERRCODE = 'PT429';
    END IF;
    SELECT l.id INTO v_id FROM public.external_resource_links l
    WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '') AND l.provider = v_provider AND l.external_id = p_ref;
    IF v_id IS NOT NULL THEN RETURN QUERY SELECT v_id, true; RETURN; END IF;
    INSERT INTO public.external_resource_links AS l
        (project_id, card_id, provider, external_id, name, mime_type, web_url, size_bytes, modified_at, provider_state,
         metadata_checked_at, linked_by, linked_by_name, email_from, email_count, email_attachments)
    VALUES (v_pid, p_card_id, v_provider, p_ref, p_subject, 'message/rfc822', NULL, NULL, p_date, coalesce(p_state, 'ok'),
            now(), v_uid, left(public.collab_actor_name(v_pid, v_uid), 200), p_from, p_count, p_attachments)
    ON CONFLICT DO NOTHING
    RETURNING l.id INTO v_id;
    IF v_id IS NULL THEN -- lost a race with an identical attach
        SELECT l.id INTO v_id FROM public.external_resource_links l
        WHERE l.project_id = v_pid AND coalesce(l.card_id, '') = coalesce(p_card_id, '') AND l.provider = v_provider AND l.external_id = p_ref;
        RETURN QUERY SELECT v_id, true;
        RETURN;
    END IF;
    INSERT INTO public.gmail_link_sources (link_id, owner_user_id, google_sub, kind, gmail_id, thread_id)
    VALUES (v_id, v_uid, p_google_sub, p_kind, p_gmail_id, p_thread_id);
    RETURN QUERY SELECT v_id, false;
END $$;

-- The private source of ONE link, for its owner only, and only while the link is visible to them (still a member).
-- same_account = the owner's currently connected Google account (with Gmail) is the one the link came from.
CREATE OR REPLACE FUNCTION public.gmail_link_source(p_server_secret TEXT, p_link_id UUID)
RETURNS TABLE (kind TEXT, gmail_id TEXT, thread_id TEXT, same_account BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    RETURN QUERY
    SELECT s.kind, s.gmail_id, s.thread_id, (s.google_sub = public.gmail_caller_sub()) IS TRUE
    FROM public.gmail_link_sources s JOIN public.external_resource_links l ON l.id = s.link_id
    WHERE s.link_id = p_link_id AND s.owner_user_id = auth.uid() AND public.is_project_member(l.project_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'E-mail může otevřít jen ten, kdo ho připojil, ze svého účtu Gmail.' USING ERRCODE = '42501';
    END IF;
END $$;

-- Metadata refresh by the owner (their own token read it from Gmail): subject, sender label, date, counts, state.
CREATE OR REPLACE FUNCTION public.gmail_link_refresh(
    p_server_secret TEXT, p_link_id UUID, p_subject TEXT, p_from TEXT, p_date TIMESTAMP WITH TIME ZONE,
    p_count INTEGER, p_attachments INTEGER, p_state TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    PERFORM public.google_require_user();
    IF NOT EXISTS (SELECT 1 FROM public.gmail_link_sources s JOIN public.external_resource_links l ON l.id = s.link_id
                   WHERE s.link_id = p_link_id AND s.owner_user_id = auth.uid() AND s.google_sub = public.gmail_caller_sub()
                     AND public.can_edit_project(l.project_id)) THEN
        RAISE EXCEPTION 'Informace o e-mailu může obnovit jen ten, kdo ho připojil.' USING ERRCODE = '42501';
    END IF;
    IF p_state IS NOT NULL AND p_state NOT IN ('ok', 'trashed', 'deleted') THEN RAISE EXCEPTION 'Neplatný stav.' USING ERRCODE = '22023'; END IF;
    UPDATE public.external_resource_links l
       SET name = coalesce(p_subject, l.name), email_from = coalesce(p_from, l.email_from), modified_at = coalesce(p_date, l.modified_at),
           email_count = coalesce(p_count, l.email_count), email_attachments = coalesce(p_attachments, l.email_attachments),
           provider_state = coalesce(p_state, l.provider_state), metadata_checked_at = now()
     WHERE l.id = p_link_id
       AND (l.name, l.email_from, l.modified_at, l.email_count, l.email_attachments, l.provider_state)
           IS DISTINCT FROM (coalesce(p_subject, l.name), coalesce(p_from, l.email_from), coalesce(p_date, l.modified_at),
                             coalesce(p_count, l.email_count), coalesce(p_attachments, l.email_attachments), coalesce(p_state, l.provider_state));
    IF NOT FOUND THEN
        UPDATE public.external_resource_links l SET metadata_checked_at = now()
        WHERE l.id = p_link_id AND l.metadata_checked_at < now() - interval '1 minute';
        RETURN false;
    END IF;
    RETURN true;
END $$;

-- Data deletion on the user's request: remove every Gmail link THIS user created (in every project, also after they left
-- it). Where they are now a read-only Čtenář the viewer guard keeps the row; those are counted as skipped.
CREATE OR REPLACE FUNCTION public.gmail_links_purge_mine(p_server_secret TEXT)
RETURNS TABLE (removed INTEGER, skipped INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID;
    v_link UUID;
    v_removed INTEGER := 0;
    v_skipped INTEGER := 0;
BEGIN
    PERFORM public.require_server_secret('google', p_server_secret);
    v_uid := public.google_require_user();
    FOR v_link IN SELECT s.link_id FROM public.gmail_link_sources s WHERE s.owner_user_id = v_uid LOOP
        BEGIN
            DELETE FROM public.external_resource_links l WHERE l.id = v_link;
            v_removed := v_removed + 1;
        EXCEPTION WHEN insufficient_privilege THEN
            v_skipped := v_skipped + 1;
        END;
    END LOOP;
    RETURN QUERY SELECT v_removed, v_skipped;
END $$;

REVOKE ALL ON FUNCTION public.google_connection_sub(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_service_remove(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.google_service_audit(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gmail_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gmail_link_source(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gmail_link_refresh(TEXT, UUID, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gmail_links_purge_mine(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.google_connection_sub(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_service_remove(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.google_service_audit(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gmail_link_add(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gmail_link_source(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gmail_link_refresh(TEXT, UUID, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gmail_links_purge_mine(TEXT) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261127001300_gmail')
ON CONFLICT (version) DO NOTHING;
