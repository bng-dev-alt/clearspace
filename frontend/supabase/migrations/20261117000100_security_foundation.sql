-- ============================================================
-- 20261117000100 -- Security foundation
--
-- Apply AFTER the baseline (frontend/supabase_schema.sql), in a transaction
-- (the test runner does `psql --single-transaction`). Idempotent: running it
-- twice is a no-op. NEVER re-run the baseline afterwards (it is guarded).
--
-- What it does
--   1. profiles are no longer world-readable (anon included)
--   2. anon loses all table access (the app never reads data anonymously)
--   3. SECURITY DEFINER helpers: pinned search_path, minimum EXECUTE grants
--   4. a client can no longer link ANOTHER account to a workspace member row
--      or add foreign member rows to a project (forced membership)
--   5. activity_logs.actor_id can no longer be spoofed
--   6. invitations: hashed 256-bit tokens, server-side creation, minimal
--      anonymous preview, e-mail bound + e-mail-verified acceptance
--   7. ai_requests ledger + atomic quota reservation (AI gateway)
--
-- Data impact on an existing database (read before applying anywhere real):
--   * Every still-PENDING invitation is marked 'expired' and its plaintext
--     token is erased: those tokens came from Math.random() and sat in
--     plaintext. Owners must invite again. Accepted/revoked rows are kept.
--   * No rows are deleted. No columns are dropped (invitations.token is
--     kept but NULLed and deprecated).
-- ============================================================

-- ------------------------------------------------------------
-- 0a. Preflight: fail EARLY and CLEARLY (nothing is changed when this raises)
-- ------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT := '';
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['profiles', 'projects', 'columns', 'cards', 'workspace_members',
                             'project_members', 'invitations', 'activity_logs', 'task_resources',
                             'task_checklists', 'task_comments', 'task_activities', 'card_assignees']
    LOOP
        IF to_regclass('public.' || t) IS NULL THEN v_missing := v_missing || ' table:' || t; END IF;
    END LOOP;
    IF to_regprocedure('public.handle_new_user()') IS NULL THEN v_missing := v_missing || ' fn:handle_new_user'; END IF;
    IF to_regprocedure('public.is_project_member(text)') IS NULL THEN v_missing := v_missing || ' fn:is_project_member'; END IF;
    IF to_regprocedure('extensions.digest(text,text)') IS NULL THEN v_missing := v_missing || ' fn:extensions.digest(pgcrypto)'; END IF;
    IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN v_missing := v_missing || ' fn:extensions.gen_random_bytes(pgcrypto)'; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'email_confirmed_at') THEN
        v_missing := v_missing || ' col:auth.users.email_confirmed_at';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'workspace_id') THEN
        v_missing := v_missing || ' col:invitations.workspace_id(v1.3 schema expected)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'token') THEN
        v_missing := v_missing || ' col:invitations.token';
    END IF;
    IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
        v_missing := v_missing || ' roles:anon/authenticated/service_role';
    END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- the database does not match the baseline this migration expects. Missing:%. Apply supabase_schema.sql first / check the extensions schema. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 0. Migration marker (also makes the baseline refuse to be re-run)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clearspace_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.clearspace_migrations ENABLE ROW LEVEL SECURITY;  -- no policies: invisible to clients
REVOKE ALL ON public.clearspace_migrations FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 1. profiles: own row only (was USING (true) for everyone, anon included)
--    Teammates' names/emails are available through workspace_members, which
--    is already scoped by can_view_workspace().
-- ------------------------------------------------------------
-- Drop EVERY existing SELECT policy on profiles (not just the one we know by name): a leftover
-- permissive policy from an older release would silently keep the table open (policies are OR-ed).
DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd IN ('SELECT', 'ALL')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.profiles', p.policyname);
    END LOOP;
END $$;
CREATE POLICY "Users can read their own profile"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (auth.uid() = id);

-- ------------------------------------------------------------
-- 2. anon: no table access at all; functions are opt-in
-- ------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

-- ------------------------------------------------------------
-- 3. SECURITY DEFINER helpers
-- ------------------------------------------------------------
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;
ALTER FUNCTION public.is_project_owner(TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_project_member(TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.can_view_workspace(UUID) SET search_path = public, pg_temp;

-- Trigger function: never callable as an RPC.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.is_project_owner(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_project_member(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_view_workspace(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_project_owner(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_project_member(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_view_workspace(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Forced membership
--    A real account can only be linked to a workspace member row by
--    accept_workspace_invitation() (SECURITY DEFINER), or by the account
--    itself for its own owner row.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_workspace_member_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Definer RPCs, the signup trigger and admin tooling run as other roles.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.profile_id IS NOT NULL AND NEW.profile_id IS DISTINCT FROM auth.uid() THEN
            RAISE EXCEPTION 'Nelze propojit cizí účet s členem workspace.' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF NEW.profile_id IS DISTINCT FROM OLD.profile_id
           OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
            RAISE EXCEPTION 'Propojení člena s účtem nelze měnit.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_workspace_member_identity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_workspace_member_identity ON public.workspace_members;
CREATE TRIGGER guard_workspace_member_identity
    BEFORE INSERT OR UPDATE ON public.workspace_members
    FOR EACH ROW EXECUTE FUNCTION public.guard_workspace_member_identity();

-- A project owner may only put members of THEIR OWN workspace on a project.
DROP POLICY IF EXISTS "Users can manage members of their projects" ON public.project_members;
CREATE POLICY "Users can manage members of their projects"
    ON public.project_members FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.id = public.project_members.project_id
            AND p.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.projects p
            WHERE p.id = public.project_members.project_id
            AND p.user_id = auth.uid()
        )
        AND EXISTS (
            SELECT 1 FROM public.workspace_members wm
            WHERE wm.id = public.project_members.member_id
            AND wm.owner_id = auth.uid()
        )
    );

-- ------------------------------------------------------------
-- 5. activity_logs: actor_id is the caller or NULL, never someone else
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Users can insert activity logs for their projects" ON public.activity_logs;
CREATE POLICY "Users can insert activity logs for their projects"
    ON public.activity_logs FOR INSERT
    WITH CHECK (
        public.is_project_member(public.activity_logs.project_id)
        AND (public.activity_logs.actor_id IS NULL OR public.activity_logs.actor_id = auth.uid())
    );

-- ------------------------------------------------------------
-- 6. Invitations
-- ------------------------------------------------------------
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- Backfill hashes for every row that still has a plaintext token.
UPDATE public.invitations
SET token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
WHERE token_hash IS NULL AND token IS NOT NULL;

-- Legacy tokens were Math.random() output: invalidate pending ones, then erase
-- every plaintext token.
UPDATE public.invitations SET status = 'expired'
WHERE status = 'pending' AND token IS NOT NULL;
ALTER TABLE public.invitations ALTER COLUMN token DROP NOT NULL;
UPDATE public.invitations SET token = NULL WHERE token IS NOT NULL;
COMMENT ON COLUMN public.invitations.token IS 'DEPRECATED, always NULL. Tokens are stored only as token_hash.';

ALTER TABLE public.invitations ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_token_hash_format;
ALTER TABLE public.invitations
    ADD CONSTRAINT invitations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_key ON public.invitations (token_hash);
-- One live invitation per workspace + e-mail.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_per_email
    ON public.invitations (workspace_id, lower(email)) WHERE status = 'pending';

-- Clients may read invitation metadata of their own workspace and revoke
-- pending ones. They can never read token material nor INSERT directly
-- (creation goes through create_workspace_invitation()).
-- Replace ALL policies on invitations (incl. leftovers of the v1.2 project-level model).
DO $$
DECLARE p RECORD;
BEGIN
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invitations'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.invitations', p.policyname);
    END LOOP;
END $$;

CREATE POLICY "Workspace owners can view invitations"
    ON public.invitations FOR SELECT TO authenticated
    USING (workspace_id = auth.uid());
CREATE POLICY "Workspace owners can revoke pending invitations"
    ON public.invitations FOR UPDATE TO authenticated
    USING (workspace_id = auth.uid() AND status = 'pending')
    WITH CHECK (workspace_id = auth.uid() AND status = 'rejected');
CREATE POLICY "Workspace owners can delete invitations"
    ON public.invitations FOR DELETE TO authenticated
    USING (workspace_id = auth.uid());

REVOKE ALL ON public.invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, workspace_id, email, role, status, invited_by, expires_at, accepted_at, created_at)
    ON public.invitations TO authenticated;
GRANT UPDATE (status) ON public.invitations TO authenticated;
GRANT DELETE ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;

-- Create: server generates a 256-bit token, stores only its SHA-256, returns
-- the plaintext ONCE. Expiry is server-controlled (7 days).
CREATE OR REPLACE FUNCTION public.create_workspace_invitation(p_email TEXT, p_role TEXT DEFAULT 'member')
RETURNS TABLE (id TEXT, token TEXT, expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_email TEXT := lower(trim(coalesce(p_email, '')));
    v_token TEXT;
    v_id TEXT := 'inv-' || replace(gen_random_uuid()::text, '-', '');
    v_expires TIMESTAMP WITH TIME ZONE := now() + interval '7 days';
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Neplatná e-mailová adresa.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(p_role, 'member') <> 'member' THEN
        RAISE EXCEPTION 'Pozvat lze pouze s rolí člen.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.invitations i
        WHERE i.workspace_id = v_uid AND i.status = 'pending') >= 50 THEN
        RAISE EXCEPTION 'Příliš mnoho nevyřízených pozvánek.' USING ERRCODE = '54000';
    END IF;

    -- A newer invitation replaces (revokes) an older pending one to the same e-mail.
    UPDATE public.invitations i SET status = 'rejected'
    WHERE i.workspace_id = v_uid AND lower(i.email) = v_email AND i.status = 'pending';

    v_token := encode(extensions.gen_random_bytes(32), 'hex');

    INSERT INTO public.invitations (id, workspace_id, email, token_hash, role, status, invited_by, expires_at)
    VALUES (v_id, v_uid, v_email, encode(extensions.digest(v_token, 'sha256'), 'hex'),
            'member', 'pending', v_uid, v_expires);

    RETURN QUERY SELECT v_id, v_token, v_expires;
END;
$$;

-- Anonymous preview: the minimum an invitee needs to see before signing up.
CREATE OR REPLACE FUNCTION public.invitation_preview(p_token TEXT)
RETURNS TABLE (state TEXT, masked_email TEXT, inviter_name TEXT, expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv public.invitations%ROWTYPE;
BEGIN
    IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 16 AND 200 THEN
        RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT * INTO v_inv FROM public.invitations
    WHERE token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'invalid'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMP WITH TIME ZONE;
    ELSIF v_inv.status <> 'pending' THEN
        RETURN QUERY SELECT 'used'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMP WITH TIME ZONE;
    ELSIF v_inv.expires_at < now() THEN
        RETURN QUERY SELECT 'expired'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TIMESTAMP WITH TIME ZONE;
    ELSE
        RETURN QUERY
        SELECT 'valid'::TEXT,
               left(split_part(v_inv.email, '@', 1), 1) || '***@' || split_part(v_inv.email, '@', 2),
               (SELECT p.display_name FROM public.profiles p WHERE p.id = v_inv.workspace_id),
               v_inv.expires_at;
    END IF;
END;
$$;

-- Accept: token-bound, single use, expiry-checked, bound to the VERIFIED
-- e-mail of the calling account (auth.users.email_confirmed_at). Links the
-- account to the inviting workspace (claiming a matching placeholder member
-- if the owner created one) and marks the invitation accepted, atomically.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_token TEXT, p_display_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_inv public.invitations%ROWTYPE;
    v_email TEXT;
    v_confirmed TIMESTAMP WITH TIME ZONE;
    v_name TEXT := NULLIF(trim(coalesce(p_display_name, '')), '');
    v_member_id TEXT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_token IS NULL OR char_length(p_token) NOT BETWEEN 16 AND 200 THEN
        RAISE EXCEPTION 'Pozvánka neexistuje.';
    END IF;

    SELECT u.email, u.email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users u WHERE u.id = v_uid;
    IF v_confirmed IS NULL THEN
        RAISE EXCEPTION 'E-mail účtu není ověřen. Potvrďte e-mail a otevřete pozvánku znovu.';
    END IF;

    SELECT * INTO v_inv FROM public.invitations
    WHERE token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pozvánka neexistuje.';
    END IF;
    IF v_inv.status <> 'pending' THEN
        RAISE EXCEPTION 'Pozvánka již byla použita nebo zrušena.';
    END IF;
    IF v_inv.expires_at < now() THEN
        RAISE EXCEPTION 'Platnost pozvánky vypršela.';
    END IF;
    IF lower(v_inv.email) <> lower(v_email) THEN
        RAISE EXCEPTION 'Pozvánka byla vystavena na jiný e-mail.';
    END IF;
    IF v_inv.workspace_id = v_uid THEN
        RAISE EXCEPTION 'Do vlastního workspace se zvát nelze.';
    END IF;

    SELECT wm.id INTO v_member_id FROM public.workspace_members wm
    WHERE wm.owner_id = v_inv.workspace_id AND wm.profile_id = v_uid;

    IF v_member_id IS NULL THEN
        -- Claim a placeholder the owner created for this address, if any.
        UPDATE public.workspace_members wm
        SET profile_id = v_uid, full_name = coalesce(v_name, wm.full_name)
        WHERE wm.owner_id = v_inv.workspace_id AND wm.profile_id IS NULL
          AND lower(wm.email) = lower(v_email)
          AND wm.id = (SELECT w2.id FROM public.workspace_members w2
                       WHERE w2.owner_id = v_inv.workspace_id AND w2.profile_id IS NULL
                         AND lower(w2.email) = lower(v_email)
                       ORDER BY w2.created_at LIMIT 1)
        RETURNING wm.id INTO v_member_id;
    END IF;

    IF v_member_id IS NULL THEN
        v_member_id := 'member-' || replace(v_uid::text, '-', '') || '-'
                       || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
        INSERT INTO public.workspace_members
            (id, owner_id, profile_id, full_name, initials, avatar_color, email, workspace_role)
        VALUES
            (v_member_id, v_inv.workspace_id, v_uid, coalesce(v_name, v_email),
             upper(left(coalesce(v_name, v_email, 'U'), 1)), '#209dd7', v_email, 'member');
    END IF;

    UPDATE public.invitations SET status = 'accepted', accepted_at = now() WHERE id = v_inv.id;

    RETURN v_inv.workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_workspace_invitation(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.invitation_preview(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_workspace_invitation(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_workspace_invitation(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invitation_preview(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 7. AI ledger + atomic quota reservation
--
-- Design notes (what this IS and IS NOT)
--  * ai_reserve() runs BEFORE the provider is called and inserts a
--    'reserved' row under per-user (and global) advisory locks, so parallel
--    requests cannot all pass the same check.
--  * Budget accounting uses max(reserved estimate, reported usage), so a
--    caller who under-reports usage via ai_complete() gains nothing.
--  * It bounds request rate and an ESTIMATED token budget. It is NOT a hard
--    spending cap: estimates are not provider invoices, and a user can open
--    unlimited accounts (the global per-minute limit bounds that rate).
--  * Rows stuck in 'reserved' (server crash) keep counting with their
--    reserved estimate until the window passes, i.e. they fail safe.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES public.projects(id) ON DELETE SET NULL,
    feature TEXT NOT NULL CHECK (char_length(feature) BETWEEN 1 AND 64),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'succeeded', 'failed')),
    model TEXT CHECK (char_length(model) <= 100),
    reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
    completion_tokens INTEGER CHECK (completion_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens >= 0),
    error_code TEXT CHECK (char_length(error_code) <= 64),
    duration_ms INTEGER CHECK (duration_ms >= 0),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    completed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_ai_requests_user_created ON public.ai_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_requests_created ON public.ai_requests (created_at DESC);

ALTER TABLE public.ai_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read their own AI requests" ON public.ai_requests;
CREATE POLICY "Users can read their own AI requests"
    ON public.ai_requests FOR SELECT TO authenticated
    USING (user_id = auth.uid());
REVOKE ALL ON public.ai_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ai_requests TO authenticated;
GRANT ALL ON public.ai_requests TO service_role;

CREATE OR REPLACE FUNCTION public.ai_reserve(
    p_feature TEXT,
    p_project_id TEXT,
    p_reserved_tokens INTEGER,
    p_limit_per_minute INTEGER,
    p_global_limit_per_minute INTEGER,
    p_daily_token_budget INTEGER
)
RETURNS TABLE (allowed BOOLEAN, request_id UUID, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_id UUID;
    v_user_recent INTEGER;
    v_global_recent INTEGER;
    v_used BIGINT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_feature IS NULL OR char_length(p_feature) NOT BETWEEN 1 AND 64
       OR p_reserved_tokens IS NULL OR p_reserved_tokens NOT BETWEEN 0 AND 1000000
       OR p_limit_per_minute IS NULL OR p_limit_per_minute < 1
       OR p_global_limit_per_minute IS NULL OR p_global_limit_per_minute < 1
       OR p_daily_token_budget IS NULL OR p_daily_token_budget < 1 THEN
        RAISE EXCEPTION 'Neplatné parametry AI rezervace.' USING ERRCODE = '22023';
    END IF;

    -- Authorization first: a project id is only honoured for its members.
    IF p_project_id IS NOT NULL AND NOT public.is_project_member(p_project_id) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'forbidden'::TEXT;
        RETURN;
    END IF;

    -- Serialize per user, then globally (fixed order => no deadlock).
    PERFORM pg_advisory_xact_lock(hashtextextended('ai_reserve:user:' || v_uid::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('ai_reserve:global', 0));

    SELECT count(*) INTO v_user_recent FROM public.ai_requests r
    WHERE r.user_id = v_uid AND r.created_at > now() - interval '1 minute';
    IF v_user_recent >= p_limit_per_minute THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'rate_limited'::TEXT;
        RETURN;
    END IF;

    SELECT count(*) INTO v_global_recent FROM public.ai_requests r
    WHERE r.created_at > now() - interval '1 minute';
    IF v_global_recent >= p_global_limit_per_minute THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'global_rate_limited'::TEXT;
        RETURN;
    END IF;

    SELECT coalesce(sum(greatest(r.reserved_tokens, coalesce(r.total_tokens, 0))), 0) INTO v_used
    FROM public.ai_requests r
    WHERE r.user_id = v_uid AND r.created_at > now() - interval '24 hours';
    IF v_used + p_reserved_tokens > p_daily_token_budget THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'budget_exceeded'::TEXT;
        RETURN;
    END IF;

    INSERT INTO public.ai_requests (user_id, project_id, feature, status, reserved_tokens)
    VALUES (v_uid, p_project_id, p_feature, 'reserved', p_reserved_tokens)
    RETURNING public.ai_requests.id INTO v_id;

    RETURN QUERY SELECT TRUE, v_id, NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_complete(
    p_request_id UUID,
    p_status TEXT,
    p_model TEXT,
    p_prompt_tokens INTEGER,
    p_completion_tokens INTEGER,
    p_error_code TEXT,
    p_duration_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000';
    END IF;
    IF p_status NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION 'Neplatný stav AI požadavku.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.ai_requests r
    SET status = p_status,
        model = left(p_model, 100),
        prompt_tokens = greatest(p_prompt_tokens, 0),
        completion_tokens = greatest(p_completion_tokens, 0),
        total_tokens = greatest(coalesce(p_prompt_tokens, 0), 0) + greatest(coalesce(p_completion_tokens, 0), 0),
        error_code = left(p_error_code, 64),
        duration_ms = greatest(p_duration_ms, 0),
        completed_at = now()
    WHERE r.id = p_request_id AND r.user_id = auth.uid() AND r.status = 'reserved';
END;
$$;

REVOKE ALL ON FUNCTION public.ai_reserve(TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_complete(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_reserve(TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ai_complete(UUID, TEXT, TEXT, INTEGER, INTEGER, TEXT, INTEGER) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261117000100_security_foundation')
ON CONFLICT (version) DO NOTHING;
