-- ============================================================
-- 20261124001000 -- Team collaboration (RUN 01)
--
-- Apply AFTER 20261118000900, in a transaction. Idempotent (re-running is a no-op).
-- Rollback: supabase/rollback/20261124001000_collaboration.down.sql (refuses while it would
-- silently widen access, e.g. while viewer/admin roles exist).
--
-- What it does
--   1. Project roles: owner (projects.user_id) / admin / member (= editor) / viewer.
--      project_role(), can_edit_project(), can_manage_project() are the single authorization source.
--   2. Viewer is read-only EVERYWHERE: a BEFORE trigger on every project content table refuses
--      writes from a viewer, also through SECURITY DEFINER RPCs (RLS alone would not cover those);
--      restrictive storage policies do the same for task files and meeting audio.
--   3. Membership management for owner + admin through RPCs with anti-escalation rules.
--   4. Project-scoped invitations (project + role), accepted by token (existing flow) or, for an
--      already signed-in account with the invited VERIFIED e-mail, from an in-app notification.
--   5. Domain events: activity_logs becomes the project event log, written ONLY by database
--      triggers (clients can no longer insert). Envelope: id, type, workspace, project, entity,
--      actor, time, source, schema version, correlation/idempotency key.
--   6. In-app notifications (mentions, assignments, comments on your task, membership, invitations).
--   7. Comments: verified author (author_id), edit/delete rules, validated @mentions, rate limit.
--   8. Cards: project_id (realtime filter), version (optimistic concurrency), child_rev (realtime
--      signal for checklist/comment/assignee changes).
--   9. Realtime: notifications + project_members published; presence on private `project:<id>`
--      channels authorized by realtime.messages policies (where the Realtime schema exists).
--
-- Data impact: additive. Existing rows are kept; cards.project_id is backfilled; no rows deleted.
-- Behaviour change: clients can no longer INSERT into activity_logs (events come from triggers).
-- ============================================================

-- ------------------------------------------------------------
-- 0. Preflight
-- ------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT := '';
    t TEXT;
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL THEN
        v_missing := v_missing || ' migration:20261118000900_meeting_creator_erasure(apply it first)';
    ELSIF NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261118000900_meeting_creator_erasure') THEN
        v_missing := v_missing || ' migration:20261118000900_meeting_creator_erasure(apply it first)';
    END IF;
    FOREACH t IN ARRAY ARRAY['projects', 'columns', 'cards', 'project_members', 'workspace_members', 'activity_logs',
                             'task_comments', 'task_checklists', 'task_activities', 'card_assignees', 'task_resources',
                             'invitations', 'meetings', 'meeting_transcripts', 'intelligence_items']
    LOOP
        IF to_regclass('public.' || t) IS NULL THEN v_missing := v_missing || ' table:' || t; END IF;
    END LOOP;
    IF to_regprocedure('public.is_project_member(text)') IS NULL THEN v_missing := v_missing || ' fn:is_project_member'; END IF;
    IF v_missing <> '' THEN
        RAISE EXCEPTION 'Preflight failed -- collaboration cannot be installed. Missing:%. Nothing was changed.', v_missing;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Roles
-- ------------------------------------------------------------
-- 'member' is the editor role (kept as the stored value so existing rows and the default stay valid).
ALTER TABLE public.project_members DROP CONSTRAINT IF EXISTS project_members_project_role_check;
ALTER TABLE public.project_members
    ADD CONSTRAINT project_members_project_role_check CHECK (project_role IN ('owner', 'admin', 'member', 'viewer'));
CREATE INDEX IF NOT EXISTS idx_project_members_member ON public.project_members (member_id);

-- Role of an arbitrary account (internal: triggers/RPCs). The project owner is projects.user_id;
-- a stored 'owner' on a non-owner row (legacy data) is treated as an editor, never as an owner.
CREATE OR REPLACE FUNCTION public.project_role_of(p_project_id TEXT, p_uid UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_uid IS NULL OR p_project_id IS NULL THEN NULL
        WHEN EXISTS (SELECT 1 FROM public.projects p WHERE p.id = p_project_id AND p.user_id = p_uid) THEN 'owner'
        ELSE (
            SELECT CASE pm.project_role WHEN 'owner' THEN 'member' ELSE pm.project_role END
            FROM public.project_members pm
            JOIN public.workspace_members wm ON wm.id = pm.member_id
            WHERE pm.project_id = p_project_id AND wm.profile_id = p_uid
            ORDER BY array_position(ARRAY['admin', 'member', 'owner', 'viewer'], pm.project_role)
            LIMIT 1)
    END
$$;

CREATE OR REPLACE FUNCTION public.project_role(p_project_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT public.project_role_of(p_project_id, auth.uid()) $$;

CREATE OR REPLACE FUNCTION public.can_edit_project(p_project_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT coalesce(public.project_role(p_project_id) IN ('owner', 'admin', 'member'), false) $$;

CREATE OR REPLACE FUNCTION public.can_manage_project(p_project_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT coalesce(public.project_role(p_project_id) IN ('owner', 'admin'), false) $$;

REVOKE ALL ON FUNCTION public.project_role_of(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_role(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_edit_project(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_manage_project(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_role(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_edit_project(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_project(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.project_role_of(TEXT, UUID) TO service_role;

-- ------------------------------------------------------------
-- 2. Cards: project_id, version, child_rev
-- ------------------------------------------------------------
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS child_rev BIGINT NOT NULL DEFAULT 0;

-- Backfill BEFORE the triggers below exist (so it neither bumps versions nor writes events).
UPDATE public.cards c SET project_id = col.project_id
FROM public.columns col
WHERE col.id = c.column_id AND c.project_id IS DISTINCT FROM col.project_id;

CREATE INDEX IF NOT EXISTS idx_cards_project ON public.cards (project_id);

-- Server-owned fields: project_id always follows the column, version only ever increments.
CREATE OR REPLACE FUNCTION public.cards_server_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.column_id IS DISTINCT FROM OLD.column_id THEN
        NEW.project_id := (SELECT c.project_id FROM public.columns c WHERE c.id = NEW.column_id);
    ELSE
        NEW.project_id := OLD.project_id;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.version := 1;
        NEW.child_rev := 0;
    ELSE
        -- child_rev is only moved by the child-table trigger (definer, not a client role).
        IF current_user IN ('authenticated', 'anon') THEN NEW.child_rev := OLD.child_rev; END IF;
        IF (to_jsonb(NEW) - 'version' - 'child_rev' - 'updated_at') IS DISTINCT FROM
           (to_jsonb(OLD) - 'version' - 'child_rev' - 'updated_at') THEN
            NEW.version := OLD.version + 1;
            -- stamp the change time unless the writer set one itself (existing callers do)
            IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN NEW.updated_at := now(); END IF;
        ELSE
            NEW.version := OLD.version;
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.cards_server_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_cards_server_fields ON public.cards;
CREATE TRIGGER a_cards_server_fields
    BEFORE INSERT OR UPDATE ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.cards_server_fields();

-- Any change under a card (checklist, comment, assignee, file) bumps its child_rev, so one realtime
-- subscription on `cards` (filtered by project_id) tells every client which card to re-read.
CREATE OR REPLACE FUNCTION public.collab_touch_card()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_card TEXT := coalesce(to_jsonb(NEW) ->> 'card_id', to_jsonb(NEW) ->> 'task_id',
                            to_jsonb(OLD) ->> 'card_id', to_jsonb(OLD) ->> 'task_id');
BEGIN
    IF v_card IS NOT NULL THEN
        UPDATE public.cards SET child_rev = child_rev + 1 WHERE id = v_card;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_touch_card() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['task_checklists', 'task_comments', 'card_assignees', 'task_resources'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS z_collab_touch_card ON public.%I', t);
        EXECUTE format('CREATE TRIGGER z_collab_touch_card AFTER INSERT OR UPDATE OR DELETE ON public.%I
                        FOR EACH ROW EXECUTE FUNCTION public.collab_touch_card()', t);
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Viewer = read-only, on every write path
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.collab_project_of(p_row JSONB)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        p_row ->> 'project_id',
        (SELECT c.project_id FROM public.cards c WHERE c.id = coalesce(p_row ->> 'card_id', p_row ->> 'task_id')),
        (SELECT col.project_id FROM public.columns col WHERE col.id = p_row ->> 'column_id'))
$$;
REVOKE ALL ON FUNCTION public.collab_project_of(JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_guard_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
BEGIN
    -- Service role / background jobs carry no user; non-members are already refused by RLS and the RPCs.
    IF v_uid IS NOT NULL THEN
        IF TG_OP <> 'INSERT' AND public.project_role_of(public.collab_project_of(to_jsonb(OLD)), v_uid) = 'viewer' THEN
            RAISE EXCEPTION 'Role Čtenář nemůže projekt upravovat.' USING ERRCODE = '42501';
        END IF;
        IF TG_OP <> 'DELETE' AND public.project_role_of(public.collab_project_of(to_jsonb(NEW)), v_uid) = 'viewer' THEN
            RAISE EXCEPTION 'Role Čtenář nemůže projekt upravovat.' USING ERRCODE = '42501';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_guard_write() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['columns', 'cards', 'task_checklists', 'task_comments', 'task_activities', 'card_assignees',
                             'task_resources', 'meetings', 'meeting_transcripts', 'intelligence_items']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS b_collab_guard_write ON public.%I', t);
        EXECUTE format('CREATE TRIGGER b_collab_guard_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I
                        FOR EACH ROW EXECUTE FUNCTION public.collab_guard_write()', t);
    END LOOP;
END $$;

-- Storage (task files, meeting audio): restrictive = AND-ed with the existing membership policies.
-- Paths: task-resources = tasks/<card id>/..., meeting-audio = <project id>/<meeting id>/...
CREATE OR REPLACE FUNCTION public.collab_storage_project(p_bucket TEXT, p_name TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_bucket
        WHEN 'task-resources' THEN (SELECT c.project_id FROM public.cards c
                                    WHERE c.id = (string_to_array(p_name, '/'))[2])
        WHEN 'meeting-audio' THEN (string_to_array(p_name, '/'))[1]
    END
$$;
REVOKE ALL ON FUNCTION public.collab_storage_project(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collab_storage_project(TEXT, TEXT) TO authenticated;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "collab_viewer_no_upload" ON storage.objects';
        EXECUTE 'DROP POLICY IF EXISTS "collab_viewer_no_delete" ON storage.objects';
        EXECUTE $p$CREATE POLICY "collab_viewer_no_upload" ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
            WITH CHECK (bucket_id NOT IN ('task-resources', 'meeting-audio')
                        OR coalesce(public.project_role(public.collab_storage_project(bucket_id, name)), '') <> 'viewer')$p$;
        EXECUTE $p$CREATE POLICY "collab_viewer_no_delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
            USING (bucket_id NOT IN ('task-resources', 'meeting-audio')
                   OR coalesce(public.project_role(public.collab_storage_project(bucket_id, name)), '') <> 'viewer')$p$;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Domain events (activity_logs) -- written by the database only
-- ------------------------------------------------------------
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS entity_id TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_source_format;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_source_format CHECK (source ~ '^[a-z][a-z0-9_.:-]{0,63}$');
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_correlation_len;
ALTER TABLE public.activity_logs ADD CONSTRAINT activity_logs_correlation_len
    CHECK (char_length(correlation_id) <= 128 AND char_length(idempotency_key) <= 128);
CREATE UNIQUE INDEX IF NOT EXISTS activity_logs_idempotency
    ON public.activity_logs (project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_logs_project_created ON public.activity_logs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_card ON public.activity_logs (card_id);
UPDATE public.activity_logs a SET workspace_id = p.user_id
FROM public.projects p WHERE p.id = a.project_id AND a.workspace_id IS NULL;

-- Clients read events. Writing is (a) the triggers below (trusted, source 'app' or a server-set
-- source) and (b) one narrow, self-attested path kept for the Meeting Intelligence apply/undo RPCs,
-- which run as the caller (SECURITY INVOKER) and record a richer event themselves: only the types in
-- the allowlist, actor/name/time/workspace forced by the server, source = 'client'. Events are
-- immutable (no UPDATE/DELETE for clients). The old free-form client logging is gone.
REVOKE UPDATE, DELETE ON public.activity_logs FROM authenticated, anon;
GRANT SELECT, INSERT ON public.activity_logs TO authenticated;
GRANT ALL ON public.activity_logs TO service_role;

CREATE OR REPLACE FUNCTION public.collab_client_event_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- collab_emit (flag set for its own INSERT only) and callers without a user (service role,
    -- admin tooling) pass through. Clients cannot set this flag: set_config is not an exposed RPC.
    IF current_setting('clearspace.trusted_emit', true) = 'on' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
    IF auth.uid() IS NULL OR NEW.action_type NOT IN ('card_created', 'card_archived') OR NEW.card_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = NEW.card_id AND c.project_id = NEW.project_id)
       OR coalesce(public.project_role_of(NEW.project_id, auth.uid()), 'viewer') = 'viewer' THEN
        RAISE EXCEPTION 'Události projektu zapisuje server.' USING ERRCODE = '42501';
    END IF;
    NEW.actor_id := auth.uid();
    NEW.actor_name := left(public.collab_actor_name(NEW.project_id, auth.uid()), 200);
    NEW.workspace_id := (SELECT p.user_id FROM public.projects p WHERE p.id = NEW.project_id);
    NEW.entity_type := 'task';
    NEW.entity_id := NEW.card_id;
    NEW.source := 'client';
    NEW.schema_version := 1;
    NEW.correlation_id := NULL;
    NEW.idempotency_key := NULL;
    NEW.created_at := now();
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_client_event_rules() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_collab_client_event_rules ON public.activity_logs;
CREATE TRIGGER a_collab_client_event_rules
    BEFORE INSERT ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.collab_client_event_rules();

-- Display name of an account inside a project's workspace (what teammates see on the board).
CREATE OR REPLACE FUNCTION public.collab_actor_name(p_project_id TEXT, p_uid UUID)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_uid IS NULL THEN 'Systém' ELSE coalesce(
        (SELECT wm.full_name FROM public.workspace_members wm JOIN public.projects p ON p.user_id = wm.owner_id
         WHERE p.id = p_project_id AND wm.profile_id = p_uid ORDER BY wm.created_at LIMIT 1),
        (SELECT nullif(trim(pr.display_name), '') FROM public.profiles pr WHERE pr.id = p_uid),
        (SELECT split_part(pr.email, '@', 1) FROM public.profiles pr WHERE pr.id = p_uid),
        'Uživatel') END
$$;
REVOKE ALL ON FUNCTION public.collab_actor_name(TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- The one writer of events. Source / correlation come from transaction-local settings a trusted
-- server path may set (set_config('clearspace.event_source', 'gmail', true)); clients cannot set them.
CREATE OR REPLACE FUNCTION public.collab_emit(
    p_project_id TEXT, p_type TEXT, p_entity_type TEXT, p_entity_id TEXT, p_card_id TEXT, p_details JSONB)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id TEXT := 'evt-' || replace(gen_random_uuid()::text, '-', '');
    v_owner UUID;
    v_uid UUID := auth.uid();
    v_source TEXT := coalesce(nullif(current_setting('clearspace.event_source', true), ''), 'app');
BEGIN
    SELECT p.user_id INTO v_owner FROM public.projects p WHERE p.id = p_project_id;
    IF NOT FOUND THEN RETURN NULL; END IF;   -- project is being deleted
    IF v_source !~ '^[a-z][a-z0-9_.:-]{0,63}$' THEN v_source := 'app'; END IF;
    PERFORM set_config('clearspace.trusted_emit', 'on', true);
    INSERT INTO public.activity_logs
        (id, project_id, card_id, actor_id, actor_name, action_type, entity_type, details,
         workspace_id, entity_id, source, schema_version, correlation_id, created_at)
    VALUES
        (v_id, p_project_id,
         CASE WHEN p_card_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.cards c WHERE c.id = p_card_id) THEN p_card_id END,
         v_uid, public.collab_actor_name(p_project_id, v_uid), p_type, p_entity_type, coalesce(p_details, '{}'::jsonb),
         v_owner, p_entity_id, v_source, 1,
         left(nullif(current_setting('clearspace.correlation_id', true), ''), 128), now());
    PERFORM set_config('clearspace.trusted_emit', '', true);
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.collab_emit(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- Was the row written by THIS transaction? (bulk paths -- new project seed, AI-history restore --
-- (re)create whole boards in one transaction; per-row events would only be noise there.)
CREATE OR REPLACE FUNCTION public.collab_column_is_new(p_column_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT c.xmin::text = (pg_current_xact_id()::xid)::text FROM public.columns c WHERE c.id = p_column_id), true)
$$;
REVOKE ALL ON FUNCTION public.collab_column_is_new(TEXT) FROM PUBLIC, anon, authenticated;

-- An event of this type for this card was already written in this transaction (e.g. by an
-- Intelligence RPC that records richer details itself).
CREATE OR REPLACE FUNCTION public.collab_already_logged(p_card_id TEXT, p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.activity_logs a
                   WHERE (a.card_id = p_card_id OR a.entity_id = p_card_id) AND a.action_type = p_type
                     AND a.created_at IN (now(), timezone('utc', now())::timestamptz))
$$;
REVOKE ALL ON FUNCTION public.collab_already_logged(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_is_done_column(p_column_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT c.role = 'done' OR lower(trim(c.name)) IN ('hotovo', 'done', 'dokončeno')
                     FROM public.columns c WHERE c.id = p_column_id), false)
$$;
REVOKE ALL ON FUNCTION public.collab_is_done_column(TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Notifications
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('mention', 'comment', 'assignment', 'project_added', 'project_role_changed',
                                       'project_removed', 'invitation', 'invitation_accepted')),
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL CHECK (char_length(actor_name) <= 200),
    entity_type TEXT CHECK (char_length(entity_type) <= 32),
    entity_id TEXT CHECK (char_length(entity_id) <= 200),
    card_id TEXT CHECK (char_length(card_id) <= 200),
    title TEXT NOT NULL CHECK (char_length(title) <= 300),
    event_id TEXT,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON public.notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications (recipient_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_project ON public.notifications (project_id);
-- One mention/comment notification per recipient and comment; one invitation notification per invitation.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_once_per_entity
    ON public.notifications (recipient_id, type, entity_id) WHERE type IN ('mention', 'comment', 'invitation');

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Recipients read their notifications" ON public.notifications;
CREATE POLICY "Recipients read their notifications" ON public.notifications FOR SELECT TO authenticated
    USING (recipient_id = auth.uid());
DROP POLICY IF EXISTS "Recipients mark their notifications" ON public.notifications;
CREATE POLICY "Recipients mark their notifications" ON public.notifications FOR UPDATE TO authenticated
    USING (recipient_id = auth.uid()) WITH CHECK (recipient_id = auth.uid());
DROP POLICY IF EXISTS "Recipients dismiss their notifications" ON public.notifications;
CREATE POLICY "Recipients dismiss their notifications" ON public.notifications FOR DELETE TO authenticated
    USING (recipient_id = auth.uid());
REVOKE ALL ON public.notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON public.notifications TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

CREATE OR REPLACE FUNCTION public.collab_notify(
    p_recipient UUID, p_project_id TEXT, p_type TEXT, p_entity_type TEXT, p_entity_id TEXT,
    p_card_id TEXT, p_title TEXT, p_event_id TEXT, p_require_member BOOLEAN DEFAULT true)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_recipient IS NULL OR p_recipient IS NOT DISTINCT FROM auth.uid() THEN RETURN; END IF;
    -- Never notify somebody about a project they cannot read (no cross-project / cross-workspace leak).
    IF p_require_member AND public.project_role_of(p_project_id, p_recipient) IS NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = p_recipient) THEN RETURN; END IF;
    INSERT INTO public.notifications
        (recipient_id, project_id, type, actor_id, actor_name, entity_type, entity_id, card_id, title, event_id)
    VALUES
        (p_recipient,
         CASE WHEN EXISTS (SELECT 1 FROM public.projects p WHERE p.id = p_project_id) THEN p_project_id END,
         p_type, auth.uid(), left(public.collab_actor_name(p_project_id, auth.uid()), 200),
         p_entity_type, p_entity_id, p_card_id, left(coalesce(nullif(trim(p_title), ''), '—'), 300), p_event_id)
    ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.collab_notify(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Event triggers
-- ------------------------------------------------------------
-- Cards (deferred to commit: sees whether an RPC already logged the same thing, and whether the
-- whole board was (re)built in this transaction).
CREATE OR REPLACE FUNCTION public.collab_card_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pid TEXT;
    v_from TEXT;
    v_to TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_pid := coalesce(OLD.project_id, (SELECT c.project_id FROM public.columns c WHERE c.id = OLD.column_id));
        -- column deleted with it / board rebuilt / card re-inserted (restore): no per-card event
        IF public.collab_column_is_new(OLD.column_id) OR EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.id) THEN
            RETURN NULL;
        END IF;
        PERFORM public.collab_emit(v_pid, 'card_deleted', 'task', OLD.id, NULL, jsonb_build_object('title', OLD.title));
        RETURN NULL;
    END IF;

    v_pid := NEW.project_id;
    IF NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = NEW.id) THEN RETURN NULL; END IF;

    IF TG_OP = 'INSERT' THEN
        IF public.collab_column_is_new(NEW.column_id) OR public.collab_already_logged(NEW.id, 'card_created') THEN
            RETURN NULL;
        END IF;
        PERFORM public.collab_emit(v_pid, 'card_created', 'task', NEW.id, NEW.id, jsonb_build_object(
            'title', NEW.title, 'column', (SELECT c.name FROM public.columns c WHERE c.id = NEW.column_id),
            'column_id', NEW.column_id));
        RETURN NULL;
    END IF;

    -- UPDATE
    IF NEW.column_id IS DISTINCT FROM OLD.column_id AND NOT public.collab_already_logged(NEW.id, 'card_moved') THEN
        SELECT c.name INTO v_from FROM public.columns c WHERE c.id = OLD.column_id;
        SELECT c.name INTO v_to FROM public.columns c WHERE c.id = NEW.column_id;
        PERFORM public.collab_emit(v_pid, 'card_moved', 'task', NEW.id, NEW.id, jsonb_build_object(
            'title', NEW.title, 'from', v_from, 'to', v_to, 'from_column_id', OLD.column_id,
            'to_column_id', NEW.column_id, 'completed', public.collab_is_done_column(NEW.column_id)));
    END IF;
    IF NEW.archived IS DISTINCT FROM OLD.archived THEN
        IF NEW.archived AND NOT public.collab_already_logged(NEW.id, 'card_archived') THEN
            PERFORM public.collab_emit(v_pid, 'card_archived', 'task', NEW.id, NEW.id, jsonb_build_object('title', NEW.title));
        ELSIF NOT NEW.archived AND NOT public.collab_already_logged(NEW.id, 'card_restored') THEN
            PERFORM public.collab_emit(v_pid, 'card_restored', 'task', NEW.id, NEW.id, jsonb_build_object('title', NEW.title));
        END IF;
    END IF;
    IF NEW.title IS DISTINCT FROM OLD.title AND NOT public.collab_already_logged(NEW.id, 'card_renamed') THEN
        PERFORM public.collab_emit(v_pid, 'card_renamed', 'task', NEW.id, NEW.id,
            jsonb_build_object('title', NEW.title, 'from', OLD.title, 'to', NEW.title));
    END IF;
    IF NEW.priority IS DISTINCT FROM OLD.priority AND NOT public.collab_already_logged(NEW.id, 'card_priority_changed') THEN
        PERFORM public.collab_emit(v_pid, 'card_priority_changed', 'task', NEW.id, NEW.id,
            jsonb_build_object('title', NEW.title, 'from', OLD.priority, 'to', NEW.priority));
    END IF;
    IF NEW.due_date IS DISTINCT FROM OLD.due_date AND NOT public.collab_already_logged(NEW.id, 'card_due_changed') THEN
        PERFORM public.collab_emit(v_pid, 'card_due_changed', 'task', NEW.id, NEW.id,
            jsonb_build_object('title', NEW.title, 'from', OLD.due_date, 'to', NEW.due_date));
    END IF;
    IF NEW.tag IS DISTINCT FROM OLD.tag AND NOT public.collab_already_logged(NEW.id, 'card_tag_changed') THEN
        PERFORM public.collab_emit(v_pid, 'card_tag_changed', 'task', NEW.id, NEW.id,
            jsonb_build_object('title', NEW.title, 'from', OLD.tag, 'to', NEW.tag));
    END IF;
    -- Description: no content in the log; coalesced per actor + card for 10 minutes (typing sessions).
    IF NEW.details IS DISTINCT FROM OLD.details AND NOT EXISTS (
        SELECT 1 FROM public.activity_logs a
        WHERE a.card_id = NEW.id AND a.action_type = 'card_details_changed'
          AND a.actor_id IS NOT DISTINCT FROM auth.uid() AND a.created_at > now() - interval '10 minutes') THEN
        PERFORM public.collab_emit(v_pid, 'card_details_changed', 'task', NEW.id, NEW.id, jsonb_build_object('title', NEW.title));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_card_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_card_events ON public.cards;
CREATE CONSTRAINT TRIGGER collab_card_events
    AFTER INSERT OR UPDATE OR DELETE ON public.cards
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.collab_card_events();

-- Assignments (deferred: a delete+insert of the same assignee in one transaction is no change).
CREATE OR REPLACE FUNCTION public.collab_assignee_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_card public.cards%ROWTYPE;
    v_member public.workspace_members%ROWTYPE;
    v_event TEXT;
    v_row public.card_assignees%ROWTYPE;
BEGIN
    v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    SELECT * INTO v_card FROM public.cards c WHERE c.id = v_row.card_id;
    IF NOT FOUND OR public.collab_column_is_new(v_card.column_id) THEN RETURN NULL; END IF;
    SELECT * INTO v_member FROM public.workspace_members wm WHERE wm.id = v_row.member_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM public.card_assignees ca WHERE ca.card_id = v_row.card_id AND ca.member_id = v_row.member_id) THEN
            RETURN NULL;
        END IF;
        -- a delete + re-insert of an existing assignment (resync) is not a new assignment
        IF (SELECT a.action_type FROM public.activity_logs a
            WHERE a.card_id = v_card.id AND a.action_type IN ('card_assigned', 'card_unassigned')
              AND a.details ->> 'member_id' = v_member.id
            ORDER BY a.created_at DESC LIMIT 1) = 'card_assigned' THEN
            RETURN NULL;
        END IF;
        v_event := public.collab_emit(v_card.project_id, 'card_assigned', 'task', v_card.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'member_id', v_member.id, 'name', v_member.full_name));
        PERFORM public.collab_notify(v_member.profile_id, v_card.project_id, 'assignment', 'task', v_card.id,
            v_card.id, v_card.title, v_event);
    ELSE
        IF EXISTS (SELECT 1 FROM public.card_assignees ca WHERE ca.card_id = v_row.card_id AND ca.member_id = v_row.member_id) THEN
            RETURN NULL;
        END IF;
        PERFORM public.collab_emit(v_card.project_id, 'card_unassigned', 'task', v_card.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'member_id', v_member.id, 'name', v_member.full_name));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_assignee_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_assignee_events ON public.card_assignees;
CREATE CONSTRAINT TRIGGER collab_assignee_events
    AFTER INSERT OR DELETE ON public.card_assignees
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.collab_assignee_events();

-- Columns
CREATE OR REPLACE FUNCTION public.collab_column_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_all_new BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
            PERFORM public.collab_emit(NEW.project_id, 'column_renamed', 'column', NEW.id, NULL,
                jsonb_build_object('name', NEW.name, 'from', OLD.name, 'to', NEW.name));
        END IF;
        RETURN NULL;
    END IF;
    -- every column of the project (re)written in this transaction => initial seed or a restore
    SELECT bool_and(public.collab_column_is_new(c.id)) INTO v_all_new
    FROM public.columns c WHERE c.project_id = coalesce(NEW.project_id, OLD.project_id);
    IF TG_OP = 'INSERT' THEN
        IF v_all_new OR NOT EXISTS (SELECT 1 FROM public.columns c WHERE c.id = NEW.id) THEN RETURN NULL; END IF;
        PERFORM public.collab_emit(NEW.project_id, 'column_created', 'column', NEW.id, NULL, jsonb_build_object('name', NEW.name));
    ELSE
        IF EXISTS (SELECT 1 FROM public.columns c WHERE c.id = OLD.id) THEN RETURN NULL; END IF;
        IF v_all_new THEN
            -- the board was replaced as a whole (AI History restore): one event, not one per column
            IF NOT EXISTS (SELECT 1 FROM public.activity_logs a WHERE a.project_id = OLD.project_id
                           AND a.action_type = 'board_restored' AND a.created_at >= now()) THEN
                PERFORM public.collab_emit(OLD.project_id, 'board_restored', 'project', OLD.project_id, NULL, '{}'::jsonb);
            END IF;
            RETURN NULL;
        END IF;
        PERFORM public.collab_emit(OLD.project_id, 'column_deleted', 'column', OLD.id, NULL, jsonb_build_object('name', OLD.name));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_column_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_column_events ON public.columns;
CREATE CONSTRAINT TRIGGER collab_column_events
    AFTER INSERT OR UPDATE OR DELETE ON public.columns
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.collab_column_events();

-- Projects
CREATE OR REPLACE FUNCTION public.collab_project_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(NEW.id, 'project_created', 'project', NEW.id, NULL, jsonb_build_object('name', NEW.name));
    ELSIF NEW.name IS DISTINCT FROM OLD.name THEN
        PERFORM public.collab_emit(NEW.id, 'project_renamed', 'project', NEW.id, NULL,
            jsonb_build_object('name', NEW.name, 'from', OLD.name, 'to', NEW.name));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_project_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_project_events ON public.projects;
CREATE TRIGGER collab_project_events
    AFTER INSERT OR UPDATE OF name ON public.projects
    FOR EACH ROW EXECUTE FUNCTION public.collab_project_events();

-- Membership
CREATE OR REPLACE FUNCTION public.collab_member_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_member public.workspace_members%ROWTYPE;
    v_project public.projects%ROWTYPE;
    v_event TEXT;
BEGIN
    SELECT * INTO v_project FROM public.projects p WHERE p.id = coalesce(NEW.project_id, OLD.project_id);
    IF NOT FOUND THEN RETURN NULL; END IF;   -- project deletion cascade
    SELECT * INTO v_member FROM public.workspace_members wm WHERE wm.id = coalesce(NEW.member_id, OLD.member_id);
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF TG_OP = 'INSERT' THEN
        -- the owner's own row (project setup) is not news
        IF v_member.profile_id IS NOT DISTINCT FROM v_project.user_id THEN RETURN NULL; END IF;
        v_event := public.collab_emit(v_project.id, 'member_added', 'member', v_member.id, NULL,
            jsonb_build_object('name', v_member.full_name, 'member_id', v_member.id, 'role', NEW.project_role));
        PERFORM public.collab_notify(v_member.profile_id, v_project.id, 'project_added', 'project', v_project.id,
            NULL, v_project.name, v_event);
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.project_role IS DISTINCT FROM OLD.project_role THEN
            v_event := public.collab_emit(v_project.id, 'member_role_changed', 'member', v_member.id, NULL,
                jsonb_build_object('name', v_member.full_name, 'member_id', v_member.id,
                                   'from', OLD.project_role, 'to', NEW.project_role));
            PERFORM public.collab_notify(v_member.profile_id, v_project.id, 'project_role_changed', 'project',
                v_project.id, NULL, v_project.name, v_event);
        END IF;
    ELSE
        IF v_member.profile_id IS NOT DISTINCT FROM v_project.user_id THEN RETURN NULL; END IF;
        v_event := public.collab_emit(v_project.id, 'member_removed', 'member', v_member.id, NULL,
            jsonb_build_object('name', v_member.full_name, 'member_id', v_member.id));
        IF v_member.profile_id IS NOT NULL AND public.project_role_of(v_project.id, v_member.profile_id) IS NULL THEN
            -- access revoked: earlier notifications must not keep showing this project's content
            DELETE FROM public.notifications n WHERE n.recipient_id = v_member.profile_id AND n.project_id = v_project.id;
            PERFORM public.collab_notify(v_member.profile_id, v_project.id, 'project_removed', 'project', v_project.id,
                NULL, v_project.name, NULL, false);
        END IF;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_member_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_member_events ON public.project_members;
CREATE TRIGGER collab_member_events
    AFTER INSERT OR UPDATE OR DELETE ON public.project_members
    FOR EACH ROW EXECUTE FUNCTION public.collab_member_events();

-- Removing a person from the whole workspace cascades their project rows away before the trigger
-- above can see the member; purge their notifications about the owner's projects here.
CREATE OR REPLACE FUNCTION public.collab_workspace_member_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.profile_id IS NOT NULL AND OLD.profile_id IS DISTINCT FROM OLD.owner_id THEN
        DELETE FROM public.notifications n
        USING public.projects p
        WHERE n.recipient_id = OLD.profile_id AND p.id = n.project_id AND p.user_id = OLD.owner_id
          AND public.project_role_of(p.id, OLD.profile_id) IS NULL;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_workspace_member_removed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_workspace_member_removed ON public.workspace_members;
CREATE TRIGGER collab_workspace_member_removed
    AFTER DELETE ON public.workspace_members
    FOR EACH ROW EXECUTE FUNCTION public.collab_workspace_member_removed();

-- ------------------------------------------------------------
-- 7. Comments
-- ------------------------------------------------------------
ALTER TABLE public.task_comments ADD COLUMN IF NOT EXISTS author_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.task_comments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.task_comments ADD COLUMN IF NOT EXISTS mentions UUID[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_task_comments_card ON public.task_comments (card_id, created_at);
CREATE INDEX IF NOT EXISTS idx_task_comments_author ON public.task_comments (author_id, created_at DESC);

-- Mentions are kept only for accounts that can read the project (max 20, never the author).
CREATE OR REPLACE FUNCTION public.collab_clean_mentions(p_project_id TEXT, p_ids UUID[], p_author UUID)
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(array_agg(u ORDER BY u), '{}'::uuid[]) FROM (
        SELECT DISTINCT u FROM unnest(coalesce(p_ids, '{}'::uuid[])) AS u
        WHERE u IS DISTINCT FROM p_author AND public.project_role_of(p_project_id, u) IS NOT NULL
        LIMIT 20) s
$$;
REVOKE ALL ON FUNCTION public.collab_clean_mentions(TEXT, UUID[], UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_comment_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_pid TEXT;
    v_role TEXT;
BEGIN
    IF v_uid IS NULL THEN   -- service role / admin tooling
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    v_pid := (SELECT c.project_id FROM public.cards c WHERE c.id = coalesce(NEW.card_id, OLD.card_id));
    v_role := public.project_role_of(v_pid, v_uid);

    IF TG_OP = 'DELETE' THEN
        -- cascade from a deleted card/column/project: the card is already gone
        IF NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id) THEN RETURN OLD; END IF;
        IF OLD.author_id IS DISTINCT FROM v_uid AND coalesce(v_role, '') NOT IN ('owner', 'admin') THEN
            RAISE EXCEPTION 'Cizí komentář může smazat jen vlastník nebo správce projektu.' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF char_length(trim(coalesce(NEW.content, ''))) = 0 OR char_length(NEW.content) > 5000 THEN
        RAISE EXCEPTION 'Komentář musí mít 1 až 5000 znaků.' USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- A backdated insert by the project OWNER is a board restore (AI History): keep the recorded
        -- name, but it stays unverified (author_id NULL). Every other insert is authored by the caller.
        IF v_role = 'owner' AND NEW.created_at < now() - interval '5 minutes' AND NEW.author_id IS NULL THEN
            NEW.mentions := '{}';
            RETURN NEW;
        END IF;
        IF (SELECT count(*) FROM public.task_comments tc
            WHERE tc.author_id = v_uid AND tc.created_at > now() - interval '1 minute') >= 20 THEN
            RAISE EXCEPTION 'Příliš mnoho komentářů za krátkou dobu. Zkuste to za chvíli.' USING ERRCODE = '54000';
        END IF;
        NEW.author_id := v_uid;
        NEW.author_name := left(public.collab_actor_name(v_pid, v_uid), 200);
        NEW.created_at := now();
        NEW.updated_at := NULL;
    ELSE
        IF OLD.author_id IS DISTINCT FROM v_uid THEN
            RAISE EXCEPTION 'Upravit lze jen vlastní komentář.' USING ERRCODE = '42501';
        END IF;
        NEW.id := OLD.id;
        NEW.card_id := OLD.card_id;
        NEW.author_id := OLD.author_id;
        NEW.author_name := OLD.author_name;
        NEW.created_at := OLD.created_at;
        NEW.updated_at := CASE WHEN NEW.content IS DISTINCT FROM OLD.content THEN now() ELSE OLD.updated_at END;
    END IF;
    NEW.mentions := public.collab_clean_mentions(v_pid, NEW.mentions, v_uid);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_comment_rules() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS c_collab_comment_rules ON public.task_comments;
CREATE TRIGGER c_collab_comment_rules
    BEFORE INSERT OR UPDATE OR DELETE ON public.task_comments
    FOR EACH ROW EXECUTE FUNCTION public.collab_comment_rules();

CREATE OR REPLACE FUNCTION public.collab_comment_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_card public.cards%ROWTYPE;
    v_event TEXT;
    v_new UUID[];
    u UUID;
BEGIN
    IF auth.uid() IS NULL OR NEW.author_id IS NULL THEN RETURN NULL; END IF;   -- restore / tooling
    SELECT * INTO v_card FROM public.cards c WHERE c.id = NEW.card_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF TG_OP = 'INSERT' THEN
        v_event := public.collab_emit(v_card.project_id, 'comment_added', 'comment', NEW.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'comment_id', NEW.id, 'mentions', cardinality(NEW.mentions)));
        v_new := NEW.mentions;
    ELSE
        v_new := ARRAY(SELECT x FROM unnest(NEW.mentions) x EXCEPT SELECT y FROM unnest(OLD.mentions) y);
    END IF;

    FOREACH u IN ARRAY coalesce(v_new, '{}'::uuid[]) LOOP
        PERFORM public.collab_notify(u, v_card.project_id, 'mention', 'comment', NEW.id, v_card.id, v_card.title, v_event);
    END LOOP;

    -- assignees of the task hear about new comments (unless they were mentioned anyway)
    IF TG_OP = 'INSERT' THEN
        FOR u IN SELECT DISTINCT wm.profile_id FROM public.card_assignees ca
                 JOIN public.workspace_members wm ON wm.id = ca.member_id
                 WHERE ca.card_id = v_card.id AND wm.profile_id IS NOT NULL
                   AND NOT (wm.profile_id = ANY (NEW.mentions))
        LOOP
            PERFORM public.collab_notify(u, v_card.project_id, 'comment', 'comment', NEW.id, v_card.id, v_card.title, v_event);
        END LOOP;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_comment_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_comment_events ON public.task_comments;
CREATE TRIGGER collab_comment_events
    AFTER INSERT OR UPDATE OF mentions ON public.task_comments
    FOR EACH ROW EXECUTE FUNCTION public.collab_comment_events();

-- ------------------------------------------------------------
-- 8. Membership management (owner + admin)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.collab_assert_can_manage(p_project_id TEXT, p_member_id TEXT, p_new_role TEXT)
RETURNS public.workspace_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_actor TEXT;
    v_owner UUID;
    v_member public.workspace_members%ROWTYPE;
    v_target_role TEXT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    v_actor := public.project_role_of(p_project_id, v_uid);
    IF coalesce(v_actor, '') NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'Členy projektu spravuje jen vlastník nebo správce.' USING ERRCODE = '42501';
    END IF;
    SELECT p.user_id INTO v_owner FROM public.projects p WHERE p.id = p_project_id;
    SELECT * INTO v_member FROM public.workspace_members wm WHERE wm.id = p_member_id;
    -- only people of the project owner's workspace (no cross-workspace membership)
    IF NOT FOUND OR v_member.owner_id IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'Člen do tohoto workspace nepatří.' USING ERRCODE = '42501';
    END IF;
    IF v_member.profile_id IS NOT DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'Roli vlastníka projektu nelze měnit.' USING ERRCODE = '42501';
    END IF;
    IF v_member.profile_id IS NOT DISTINCT FROM v_uid THEN
        RAISE EXCEPTION 'Vlastní roli nelze měnit.' USING ERRCODE = '42501';
    END IF;
    IF p_new_role IS NOT NULL AND p_new_role NOT IN ('admin', 'member', 'viewer') THEN
        RAISE EXCEPTION 'Neplatná role.' USING ERRCODE = '22023';
    END IF;
    IF v_actor = 'admin' THEN
        SELECT pm.project_role INTO v_target_role FROM public.project_members pm
        WHERE pm.project_id = p_project_id AND pm.member_id = p_member_id;
        IF v_target_role IN ('admin', 'owner') OR p_new_role = 'admin' THEN
            RAISE EXCEPTION 'Správce nemůže přidělovat ani měnit roli správce.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN v_member;
END $$;
REVOKE ALL ON FUNCTION public.collab_assert_can_manage(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_sync_member_mirror(p_project_id TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.projects p
    SET member_ids = coalesce((SELECT jsonb_agg(pm.member_id ORDER BY pm.created_at)
                               FROM public.project_members pm WHERE pm.project_id = p_project_id), '[]'::jsonb)
    WHERE p.id = p_project_id
$$;
REVOKE ALL ON FUNCTION public.collab_sync_member_mirror(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_project_member(p_project_id TEXT, p_member_id TEXT, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_role IS NULL THEN RAISE EXCEPTION 'Neplatná role.' USING ERRCODE = '22023'; END IF;
    PERFORM public.collab_assert_can_manage(p_project_id, p_member_id, p_role);
    INSERT INTO public.project_members (project_id, member_id, project_role)
    VALUES (p_project_id, p_member_id, p_role)
    ON CONFLICT (project_id, member_id) DO UPDATE SET project_role = EXCLUDED.project_role
    WHERE public.project_members.project_role IS DISTINCT FROM EXCLUDED.project_role;
    PERFORM public.collab_sync_member_mirror(p_project_id);
END $$;

CREATE OR REPLACE FUNCTION public.remove_project_member(p_project_id TEXT, p_member_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.collab_assert_can_manage(p_project_id, p_member_id, NULL);
    DELETE FROM public.project_members pm WHERE pm.project_id = p_project_id AND pm.member_id = p_member_id;
    PERFORM public.collab_sync_member_mirror(p_project_id);
END $$;

REVOKE ALL ON FUNCTION public.set_project_member(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_project_member(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_project_member(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_project_member(TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 9. Project invitations
-- ------------------------------------------------------------
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS project_role TEXT;
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_project_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_project_role_check
    CHECK ((project_id IS NULL AND project_role IS NULL)
           OR (project_id IS NOT NULL AND project_role IN ('admin', 'member', 'viewer')));
CREATE INDEX IF NOT EXISTS idx_invitations_project ON public.invitations (project_id);
CREATE INDEX IF NOT EXISTS idx_invitations_inviter ON public.invitations (invited_by, created_at DESC);
GRANT SELECT (project_id, project_role) ON public.invitations TO authenticated;

DROP POLICY IF EXISTS "Project managers can view project invitations" ON public.invitations;
CREATE POLICY "Project managers can view project invitations" ON public.invitations FOR SELECT TO authenticated
    USING (project_id IS NOT NULL AND public.can_manage_project(project_id));

CREATE OR REPLACE FUNCTION public.create_project_invitation(p_project_id TEXT, p_email TEXT, p_role TEXT DEFAULT 'member')
RETURNS TABLE (id TEXT, token TEXT, expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_actor TEXT;
    v_owner UUID;
    v_email TEXT := lower(trim(coalesce(p_email, '')));
    v_token TEXT;
    v_id TEXT := 'inv-' || replace(gen_random_uuid()::text, '-', '');
    v_expires TIMESTAMP WITH TIME ZONE := now() + interval '7 days';
    v_project_name TEXT;
    v_existing UUID;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    v_actor := public.project_role_of(p_project_id, v_uid);
    IF coalesce(v_actor, '') NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'Zvát do projektu může jen vlastník nebo správce.' USING ERRCODE = '42501';
    END IF;
    IF p_role IS NULL OR p_role NOT IN ('admin', 'member', 'viewer') THEN
        RAISE EXCEPTION 'Neplatná role.' USING ERRCODE = '22023';
    END IF;
    IF p_role = 'admin' AND v_actor <> 'owner' THEN
        RAISE EXCEPTION 'Roli správce může přidělit jen vlastník.' USING ERRCODE = '42501';
    END IF;
    IF char_length(v_email) > 254 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Neplatná e-mailová adresa.' USING ERRCODE = '22023';
    END IF;
    SELECT p.user_id, p.name INTO v_owner, v_project_name FROM public.projects p WHERE p.id = p_project_id;
    IF lower(coalesce((SELECT pr.email FROM public.profiles pr WHERE pr.id = v_owner), '')) = v_email THEN
        RAISE EXCEPTION 'Vlastníka projektu nelze pozvat.' USING ERRCODE = '22023';
    END IF;
    -- rate limits: per inviter per hour, and the existing per-workspace pending cap
    PERFORM pg_advisory_xact_lock(hashtextextended('collab_invite:' || v_uid::text, 0));
    IF (SELECT count(*) FROM public.invitations i WHERE i.invited_by = v_uid AND i.created_at > now() - interval '1 hour') >= 20 THEN
        RAISE EXCEPTION 'Příliš mnoho pozvánek za hodinu. Zkuste to později.' USING ERRCODE = '54000';
    END IF;
    IF (SELECT count(*) FROM public.invitations i WHERE i.workspace_id = v_owner AND i.status = 'pending') >= 50 THEN
        RAISE EXCEPTION 'Příliš mnoho nevyřízených pozvánek.' USING ERRCODE = '54000';
    END IF;

    -- one live invitation per workspace + e-mail: a newer one replaces the older
    UPDATE public.invitations i SET status = 'rejected'
    WHERE i.workspace_id = v_owner AND lower(i.email) = v_email AND i.status = 'pending';

    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    INSERT INTO public.invitations
        (id, workspace_id, email, token_hash, role, status, invited_by, expires_at, project_id, project_role)
    VALUES
        (v_id, v_owner, v_email, encode(extensions.digest(v_token, 'sha256'), 'hex'), 'member', 'pending', v_uid,
         v_expires, p_project_id, p_role);

    PERFORM public.collab_emit(p_project_id, 'member_invited', 'invitation', v_id, NULL, jsonb_build_object(
        'email', left(split_part(v_email, '@', 1), 1) || '***@' || split_part(v_email, '@', 2), 'role', p_role));

    -- an existing account with this VERIFIED e-mail also gets an in-app invitation
    SELECT u.id INTO v_existing FROM auth.users u
    WHERE lower(u.email) = v_email AND u.email_confirmed_at IS NOT NULL LIMIT 1;
    IF v_existing IS NOT NULL THEN
        PERFORM public.collab_notify(v_existing, p_project_id, 'invitation', 'invitation', v_id, NULL,
            v_project_name, NULL, false);
    END IF;

    RETURN QUERY SELECT v_id, v_token, v_expires;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_invitation(p_invitation_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv public.invitations%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    SELECT * INTO v_inv FROM public.invitations i WHERE i.id = p_invitation_id FOR UPDATE;
    IF NOT FOUND OR NOT (v_inv.workspace_id = auth.uid()
                         OR (v_inv.project_id IS NOT NULL AND public.can_manage_project(v_inv.project_id))) THEN
        RAISE EXCEPTION 'Pozvánku nelze zrušit.' USING ERRCODE = '42501';
    END IF;
    IF v_inv.status = 'pending' THEN
        UPDATE public.invitations i SET status = 'rejected' WHERE i.id = v_inv.id;
        DELETE FROM public.notifications n WHERE n.type = 'invitation' AND n.entity_id = v_inv.id;
    END IF;
END $$;

-- In-app acceptance for an already signed-in account whose VERIFIED e-mail is the invited one.
-- (Proof of the address is the verified account e-mail instead of possession of the link.)
CREATE OR REPLACE FUNCTION public.accept_invitation_by_id(p_invitation_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_inv public.invitations%ROWTYPE;
    v_email TEXT;
    v_confirmed TIMESTAMP WITH TIME ZONE;
    v_name TEXT;
    v_member_id TEXT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    SELECT u.email, u.email_confirmed_at INTO v_email, v_confirmed FROM auth.users u WHERE u.id = v_uid;
    IF v_confirmed IS NULL THEN
        RAISE EXCEPTION 'E-mail účtu není ověřen.' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_inv FROM public.invitations i WHERE i.id = p_invitation_id FOR UPDATE;
    IF NOT FOUND OR lower(v_inv.email) <> lower(v_email) THEN
        RAISE EXCEPTION 'Pozvánka neexistuje.' USING ERRCODE = '42501';
    END IF;
    IF v_inv.status <> 'pending' THEN RAISE EXCEPTION 'Pozvánka již byla použita nebo zrušena.' USING ERRCODE = '22023'; END IF;
    IF v_inv.expires_at < now() THEN RAISE EXCEPTION 'Platnost pozvánky vypršela.' USING ERRCODE = '22023'; END IF;
    IF v_inv.workspace_id = v_uid THEN RAISE EXCEPTION 'Do vlastního workspace se zvát nelze.' USING ERRCODE = '22023'; END IF;

    SELECT nullif(trim(pr.display_name), '') INTO v_name FROM public.profiles pr WHERE pr.id = v_uid;
    SELECT wm.id INTO v_member_id FROM public.workspace_members wm
    WHERE wm.owner_id = v_inv.workspace_id AND wm.profile_id = v_uid;
    IF v_member_id IS NULL THEN
        UPDATE public.workspace_members wm SET profile_id = v_uid, full_name = coalesce(v_name, wm.full_name)
        WHERE wm.id = (SELECT w2.id FROM public.workspace_members w2
                       WHERE w2.owner_id = v_inv.workspace_id AND w2.profile_id IS NULL AND lower(w2.email) = lower(v_email)
                       ORDER BY w2.created_at LIMIT 1)
        RETURNING wm.id INTO v_member_id;
    END IF;
    IF v_member_id IS NULL THEN
        v_member_id := 'member-' || replace(v_uid::text, '-', '') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
        INSERT INTO public.workspace_members (id, owner_id, profile_id, full_name, initials, avatar_color, email, workspace_role)
        VALUES (v_member_id, v_inv.workspace_id, v_uid, coalesce(v_name, v_email),
                upper(left(coalesce(v_name, v_email, 'U'), 1)), '#209dd7', v_email, 'member');
    END IF;
    UPDATE public.invitations i SET status = 'accepted', accepted_at = now() WHERE i.id = v_inv.id;
    RETURN v_inv.project_id;
END $$;

REVOKE ALL ON FUNCTION public.create_project_invitation(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_invitation(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_invitation_by_id(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_project_invitation(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation_by_id(TEXT) TO authenticated;

-- Acceptance (token flow from 20261117000100 or the in-app flow above) of a PROJECT invitation also
-- grants the project role. A trigger, so the existing accept function is not redefined.
CREATE OR REPLACE FUNCTION public.collab_invitation_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_member_id TEXT;
    v_uid UUID := auth.uid();
BEGIN
    IF NOT (OLD.status = 'pending' AND NEW.status = 'accepted') THEN RETURN NULL; END IF;
    DELETE FROM public.notifications n WHERE n.type = 'invitation' AND n.entity_id = NEW.id;
    IF NEW.project_id IS NOT NULL AND v_uid IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND p.user_id = NEW.workspace_id) THEN
        SELECT wm.id INTO v_member_id FROM public.workspace_members wm
        WHERE wm.owner_id = NEW.workspace_id AND wm.profile_id = v_uid ORDER BY wm.created_at LIMIT 1;
        IF v_member_id IS NOT NULL THEN
            INSERT INTO public.project_members (project_id, member_id, project_role)
            VALUES (NEW.project_id, v_member_id, NEW.project_role)
            ON CONFLICT (project_id, member_id) DO UPDATE SET project_role = EXCLUDED.project_role;
            PERFORM public.collab_sync_member_mirror(NEW.project_id);
        END IF;
        PERFORM public.collab_notify(NEW.invited_by, NEW.project_id, 'invitation_accepted', 'project', NEW.project_id,
            NULL, (SELECT p.name FROM public.projects p WHERE p.id = NEW.project_id), NULL);
    ELSIF NEW.project_id IS NULL THEN
        PERFORM public.collab_notify(NEW.invited_by, NULL, 'invitation_accepted', 'workspace', NEW.workspace_id::text,
            NULL, 'Workspace', NULL, false);
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_invitation_accepted() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS collab_invitation_accepted ON public.invitations;
CREATE TRIGGER collab_invitation_accepted
    AFTER UPDATE OF status ON public.invitations
    FOR EACH ROW EXECUTE FUNCTION public.collab_invitation_accepted();

-- ------------------------------------------------------------
-- 10. Least-privilege for the new functions (definer helpers are never RPCs)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.collab_card_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.collab_assignee_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.collab_column_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.collab_project_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.collab_member_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.collab_comment_events() FROM PUBLIC;

-- ------------------------------------------------------------
-- 11. Realtime
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['columns', 'cards', 'activity_logs', 'notifications', 'project_members'] LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                           WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            END IF;
        END LOOP;
    END IF;
END $$;

-- Presence / broadcast on private channels named `project:<project id>`: members only.
DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NOT NULL AND to_regprocedure('realtime.topic()') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_read" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_write" ON realtime.messages';
        EXECUTE $p$CREATE POLICY "clearspace_project_channel_read" ON realtime.messages FOR SELECT TO authenticated
            USING (realtime.messages.extension IN ('presence', 'broadcast')
                   AND (SELECT realtime.topic()) LIKE 'project:%'
                   AND public.is_project_member(substr((SELECT realtime.topic()), 9)))$p$;
        EXECUTE $p$CREATE POLICY "clearspace_project_channel_write" ON realtime.messages FOR INSERT TO authenticated
            WITH CHECK (realtime.messages.extension IN ('presence', 'broadcast')
                        AND (SELECT realtime.topic()) LIKE 'project:%'
                        AND public.is_project_member(substr((SELECT realtime.topic()), 9)))$p$;
    END IF;
END $$;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261124001000_collaboration')
ON CONFLICT (version) DO NOTHING;
