-- ============================================================
-- 20261125001100 -- Collaboration hardening (RUN 01B)
--
-- Apply AFTER 20261124001000, in a transaction. Idempotent. Rollback:
-- supabase/rollback/20261125001100_collab_hardening.down.sql.
-- Functions of 20261124001000 are NOT redefined: changed behaviour gets new functions and the
-- triggers are re-pointed, so the rollback simply points them back.
--
--   1. Contact privacy: collaborators see only the people of projects they share, not the owner's
--      whole address book; e-mails are stripped from the cards.assignees JSON mirror.
--   2. Realtime = server-authorized broadcasts (realtime.send) on PRIVATE topics
--      `project:<id>:<realtime_key>` / `user:<uid>`; clients may only write presence. postgres_changes
--      on collaboration tables is retired (its DELETE events reached every subscriber with the row id).
--      The key is rotated when a member leaves: a non-cooperative removed client stays on a dead topic.
--   3. Cross-project moves: source board gets `removed`, destination `upsert`; assignees who are not
--      members of the destination are dropped; trusted card_moved_out / card_moved_in events.
--   4. Comments: no backdating/impersonation on ordinary inserts; imports (board restore through
--      restore_project_board_v2, admin tooling) are marked origin = 'import'; edit history kept.
--   5. Trusted task history: checklist and comment changes are events; task_activities is legacy
--      (clients may no longer write it except inside a board restore).
--   6. Concurrency: server-assigned card positions (serialized per column), atomic column reorder RPC.
--   7. Invitation e-mail delivery bookkeeping (server-secret RPCs), token re-issue for resend,
--      duplicate-send guard.
-- ============================================================

DO $$
BEGIN
    IF to_regclass('public.clearspace_migrations') IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.clearspace_migrations WHERE version = '20261124001000_collaboration') THEN
        RAISE EXCEPTION 'Preflight failed -- apply 20261124001000_collaboration first. Nothing was changed.';
    END IF;
    IF to_regprocedure('public.require_server_secret(text,text)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed -- fn:require_server_secret (20261118000800) missing. Nothing was changed.';
    END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Contact privacy
-- ------------------------------------------------------------
-- Can the caller see this workspace member? Only when they share a project with that person.
CREATE OR REPLACE FUNCTION public.collab_can_see_member(p_member_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.project_members pm
        WHERE pm.member_id = p_member_id AND public.is_project_member(pm.project_id))
    -- the owner of a shared project is a member through projects.user_id (no project_members row needed)
    OR EXISTS (
        SELECT 1 FROM public.workspace_members wm
        JOIN public.projects p ON p.user_id = wm.profile_id AND wm.owner_id = wm.profile_id
        WHERE wm.id = p_member_id AND public.is_project_member(p.id))
$$;
REVOKE ALL ON FUNCTION public.collab_can_see_member(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collab_can_see_member(TEXT) TO authenticated, service_role;

-- Replaces "Collaborators can view workspaces they belong to" (the whole address book of every owner
-- whose project you joined). The owner keeps full access through "Users can manage their own workspace members".
DROP POLICY IF EXISTS "Collaborators can view workspaces they belong to" ON public.workspace_members;
DROP POLICY IF EXISTS "Collaborators see people they share a project with" ON public.workspace_members;
CREATE POLICY "Collaborators see people they share a project with" ON public.workspace_members FOR SELECT TO authenticated
    USING (profile_id = auth.uid() OR public.collab_can_see_member(id));

CREATE OR REPLACE FUNCTION public.collab_sanitize_card()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- The JSON mirror of assignees is read by every project member: keep display fields only.
    IF NEW.assignees IS NOT NULL AND jsonb_typeof(NEW.assignees) = 'array' THEN
        NEW.assignees := (SELECT coalesce(jsonb_agg(e - 'email' - 'profileId' - 'permissions' - 'status'), '[]'::jsonb)
                          FROM jsonb_array_elements(NEW.assignees) e);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_sanitize_card() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS a_cards_sanitize ON public.cards;
CREATE TRIGGER a_cards_sanitize BEFORE INSERT OR UPDATE OF assignees ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.collab_sanitize_card();
UPDATE public.cards SET assignees = (SELECT coalesce(jsonb_agg(e - 'email' - 'profileId' - 'permissions' - 'status'), '[]'::jsonb)
                                     FROM jsonb_array_elements(assignees) e)
WHERE assignees IS NOT NULL AND jsonb_typeof(assignees) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(assignees) e WHERE e ? 'email' OR e ? 'profileId');

-- ------------------------------------------------------------
-- 2. Realtime: keys, authorized topics, broadcasts
-- ------------------------------------------------------------
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS realtime_key UUID NOT NULL DEFAULT gen_random_uuid();

-- Topic authorization (used by the realtime.messages policies).
CREATE OR REPLACE FUNCTION public.collab_topic_allowed(p_topic TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    m TEXT[];
BEGIN
    IF auth.uid() IS NULL OR p_topic IS NULL THEN RETURN false; END IF;
    m := regexp_match(p_topic, '^project:(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
    IF m IS NOT NULL THEN
        RETURN EXISTS (SELECT 1 FROM public.projects p WHERE p.id = m[1] AND p.realtime_key = m[2]::uuid)
               AND public.is_project_member(m[1]);
    END IF;
    RETURN p_topic = 'user:' || auth.uid()::text;
END $$;
REVOKE ALL ON FUNCTION public.collab_topic_allowed(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collab_topic_allowed(TEXT) TO authenticated;

DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NOT NULL AND to_regprocedure('realtime.topic()') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_read" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_write" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_topic_read" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_topic_presence_write" ON realtime.messages';
        -- receive broadcasts and presence on topics the caller may use
        EXECUTE $p$CREATE POLICY "clearspace_topic_read" ON realtime.messages FOR SELECT TO authenticated
            USING (realtime.messages.extension IN ('presence', 'broadcast')
                   AND public.collab_topic_allowed((SELECT realtime.topic())))$p$;
        -- clients may only TRACK PRESENCE; broadcasts come from the database (no forged events)
        EXECUTE $p$CREATE POLICY "clearspace_topic_presence_write" ON realtime.messages FOR INSERT TO authenticated
            WITH CHECK (realtime.messages.extension = 'presence'
                        AND (SELECT realtime.topic()) LIKE 'project:%'
                        AND public.collab_topic_allowed((SELECT realtime.topic())))$p$;
    END IF;
END $$;

-- One broadcast helper: no-op where the Realtime schema is absent (plain Postgres test harness).
CREATE OR REPLACE FUNCTION public.collab_send(p_topic TEXT, p_event TEXT, p_payload JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_topic IS NULL OR to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL THEN RETURN; END IF;
    EXECUTE 'SELECT realtime.send($1, $2, $3, true)' USING p_payload, p_event, p_topic;
END $$;
REVOKE ALL ON FUNCTION public.collab_send(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_project_topic(p_project_id TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT 'project:' || p.id || ':' || p.realtime_key::text FROM public.projects p WHERE p.id = p_project_id $$;
REVOKE ALL ON FUNCTION public.collab_project_topic(TEXT) FROM PUBLIC, anon, authenticated;

-- Cards: signal only (id, version, child revision); the client re-reads under its own RLS.
CREATE OR REPLACE FUNCTION public.collab_broadcast_card()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'card', 'op', 'removed', 'id', OLD.id));
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.project_id IS DISTINCT FROM NEW.project_id THEN
        -- moved to another project: the source board learns only that it is gone
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'card', 'op', 'removed', 'id', OLD.id));
    END IF;
    PERFORM public.collab_send(public.collab_project_topic(NEW.project_id), 'change',
        jsonb_build_object('t', 'card', 'op', 'upsert', 'id', NEW.id, 'v', NEW.version, 'r', NEW.child_rev));
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_broadcast_card() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_collab_broadcast_card ON public.cards;
CREATE TRIGGER z_collab_broadcast_card AFTER INSERT OR UPDATE OR DELETE ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.collab_broadcast_card();

CREATE OR REPLACE FUNCTION public.collab_broadcast_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM public.collab_send(public.collab_project_topic(OLD.project_id), 'change',
            jsonb_build_object('t', 'column', 'op', 'removed', 'id', OLD.id));
    ELSE
        PERFORM public.collab_send(public.collab_project_topic(NEW.project_id), 'change',
            jsonb_build_object('t', 'column', 'op', 'upsert', 'id', NEW.id, 'name', NEW.name, 'position', NEW.position, 'role', NEW.role));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_broadcast_column() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_collab_broadcast_column ON public.columns;
CREATE TRIGGER z_collab_broadcast_column AFTER INSERT OR UPDATE OR DELETE ON public.columns
    FOR EACH ROW EXECUTE FUNCTION public.collab_broadcast_column();

CREATE OR REPLACE FUNCTION public.collab_broadcast_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.collab_send(public.collab_project_topic(NEW.project_id), 'activity', to_jsonb(NEW) - 'idempotency_key');
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_broadcast_activity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_collab_broadcast_activity ON public.activity_logs;
CREATE TRIGGER z_collab_broadcast_activity AFTER INSERT ON public.activity_logs
    FOR EACH ROW EXECUTE FUNCTION public.collab_broadcast_activity();

-- Membership: tell the (old) topic; a departure rotates the key, so whoever left -- including a client
-- that ignores the signal and keeps its socket -- is stranded on a topic nobody uses any more.
CREATE OR REPLACE FUNCTION public.collab_broadcast_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pid TEXT := coalesce(NEW.project_id, OLD.project_id);
BEGIN
    PERFORM public.collab_send(public.collab_project_topic(v_pid), 'change',
        jsonb_build_object('t', 'membership', 'op', lower(TG_OP)));
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.member_id IS DISTINCT FROM OLD.member_id) THEN
        UPDATE public.projects SET realtime_key = gen_random_uuid() WHERE id = v_pid;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_broadcast_membership() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_collab_broadcast_membership ON public.project_members;
CREATE TRIGGER z_collab_broadcast_membership AFTER INSERT OR UPDATE OR DELETE ON public.project_members
    FOR EACH ROW EXECUTE FUNCTION public.collab_broadcast_membership();

CREATE OR REPLACE FUNCTION public.collab_broadcast_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_to UUID := coalesce(NEW.recipient_id, OLD.recipient_id);
BEGIN
    PERFORM public.collab_send('user:' || v_to::text, 'notification', jsonb_build_object('op', lower(TG_OP)));
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_broadcast_notification() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS z_collab_broadcast_notification ON public.notifications;
CREATE TRIGGER z_collab_broadcast_notification AFTER INSERT OR UPDATE OR DELETE ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.collab_broadcast_notification();

-- Retire postgres_changes for collaboration tables (no more unfiltered DELETE payloads).
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['cards', 'columns', 'activity_logs', 'notifications', 'project_members'] LOOP
            IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
            END IF;
        END LOOP;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Cross-project moves
-- ------------------------------------------------------------
-- SECURITY INVOKER on purpose: `current_user` must be the caller's role (client writes vs. definer RPCs
-- and tooling, which keep their explicit positions); its reads are inside the caller's own RLS.
CREATE OR REPLACE FUNCTION public.collab_card_move_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- runs after a_cards_server_fields (alphabetical), so NEW.project_id is the destination
    IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.assignees IS NOT NULL
       AND jsonb_typeof(NEW.assignees) = 'array' THEN
        NEW.assignees := (SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(NEW.assignees) e
                          WHERE EXISTS (SELECT 1 FROM public.project_members pm
                                        WHERE pm.project_id = NEW.project_id AND pm.member_id = e ->> 'id'));
    END IF;
    -- positions are assigned by the server for client writes: append, serialized per column
    IF current_user IN ('authenticated', 'anon')
       AND (TG_OP = 'INSERT' OR NEW.column_id IS DISTINCT FROM OLD.column_id) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('cards_position:' || NEW.column_id, 0));
        NEW.position := coalesce((SELECT max(c.position) + 1 FROM public.cards c
                                  WHERE c.column_id = NEW.column_id AND c.id <> NEW.id), 0);
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_card_move_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS a_cards_zmove ON public.cards;
CREATE TRIGGER a_cards_zmove BEFORE INSERT OR UPDATE ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.collab_card_move_guard();

CREATE OR REPLACE FUNCTION public.collab_card_moved_projects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NULL; END IF;
    -- assignees who cannot see the destination project are unassigned (they would point nowhere)
    DELETE FROM public.card_assignees ca
    WHERE ca.card_id = NEW.id
      AND NOT EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = NEW.project_id AND pm.member_id = ca.member_id);
    -- each board gets an event in its own terms; no project names cross the boundary
    PERFORM public.collab_emit(OLD.project_id, 'card_moved_out', 'task', NEW.id, NULL, jsonb_build_object('title', NEW.title));
    PERFORM public.collab_emit(NEW.project_id, 'card_moved_in', 'task', NEW.id, NEW.id,
        jsonb_build_object('title', NEW.title, 'to', (SELECT c.name FROM public.columns c WHERE c.id = NEW.column_id)));
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_card_moved_projects() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS collab_card_moved_projects ON public.cards;
CREATE TRIGGER collab_card_moved_projects AFTER UPDATE OF column_id ON public.cards
    FOR EACH ROW EXECUTE FUNCTION public.collab_card_moved_projects();

-- The generic card events of 20261124001000 stay in-project only: a cross-project move is logged as
-- card_moved_out / card_moved_in above. Same function, two triggers (a WHEN clause cannot reference
-- OLD for INSERT/DELETE).
DROP TRIGGER IF EXISTS collab_card_events ON public.cards;
CREATE CONSTRAINT TRIGGER collab_card_events
    AFTER INSERT OR DELETE ON public.cards
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.collab_card_events();
DROP TRIGGER IF EXISTS collab_card_events_update ON public.cards;
CREATE CONSTRAINT TRIGGER collab_card_events_update
    AFTER UPDATE ON public.cards
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (OLD.project_id IS NOT DISTINCT FROM NEW.project_id)
    EXECUTE FUNCTION public.collab_card_events();

-- ------------------------------------------------------------
-- 4. Comments: origin, edit history, no backdating
-- ------------------------------------------------------------
ALTER TABLE public.task_comments ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'app';
ALTER TABLE public.task_comments DROP CONSTRAINT IF EXISTS task_comments_origin_check;
ALTER TABLE public.task_comments ADD CONSTRAINT task_comments_origin_check CHECK (origin IN ('app', 'import', 'legacy'));
UPDATE public.task_comments SET origin = 'legacy' WHERE author_id IS NULL AND origin = 'app';

CREATE TABLE IF NOT EXISTS public.task_comment_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id TEXT NOT NULL REFERENCES public.task_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    edited_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    edited_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comment_revisions_comment ON public.task_comment_revisions (comment_id, edited_at);
ALTER TABLE public.task_comment_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members read comment history" ON public.task_comment_revisions;
CREATE POLICY "Members read comment history" ON public.task_comment_revisions FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.task_comments tc JOIN public.cards c ON c.id = tc.card_id
                   WHERE tc.id = comment_id AND public.is_project_member(c.project_id)));
REVOKE ALL ON public.task_comment_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.task_comment_revisions TO authenticated;
GRANT ALL ON public.task_comment_revisions TO service_role;

-- A board import is (a) restore_project_board_v2 (sets `clearspace.import_context`; clients cannot call
-- set_config), or (b) rows written under a column (re)created in this same transaction -- one PostgREST request
-- is one statement, so only a board-rebuilding RPC (AI-history restore) can do that. Callers additionally
-- require the project OWNER.
CREATE OR REPLACE FUNCTION public.collab_in_board_import(p_card_id TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(current_setting('clearspace.import_context', true), '') = 'board_restore'
        OR (p_card_id IS NOT NULL AND public.collab_column_is_new((SELECT c.column_id FROM public.cards c WHERE c.id = p_card_id)))
$$;
REVOKE ALL ON FUNCTION public.collab_in_board_import(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.collab_comment_rules_v2()
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
    IF v_uid IS NULL THEN
        -- service role / admin tooling (e.g. a demo-data import): kept, but never presented as verified
        IF TG_OP = 'INSERT' THEN
            NEW.author_id := NULL;
            NEW.origin := CASE WHEN NEW.origin = 'legacy' THEN 'legacy' ELSE 'import' END;
            NEW.created_at := least(coalesce(NEW.created_at, now()), now());
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    v_pid := (SELECT c.project_id FROM public.cards c WHERE c.id = coalesce(NEW.card_id, OLD.card_id));
    v_role := public.project_role_of(v_pid, v_uid);

    IF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id) THEN RETURN OLD; END IF;  -- cascade
        IF OLD.author_id IS DISTINCT FROM v_uid AND coalesce(v_role, '') NOT IN ('owner', 'admin') THEN
            RAISE EXCEPTION 'Cizí komentář může smazat jen vlastník nebo správce projektu.' USING ERRCODE = '42501';
        END IF;
        RETURN OLD;
    END IF;

    IF char_length(trim(coalesce(NEW.content, ''))) = 0 OR char_length(NEW.content) > 5000 THEN
        RAISE EXCEPTION 'Komentář musí mít 1 až 5000 znaků.' USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF public.collab_in_board_import(NEW.card_id) AND v_role = 'owner' THEN
            -- AI-history board restore: historical comment copied back, clearly marked, never verified
            NEW.author_id := NULL;
            NEW.author_name := left(coalesce(nullif(trim(NEW.author_name), ''), 'Neznámý autor'), 200);
            NEW.created_at := least(coalesce(NEW.created_at, now()), now());
            NEW.updated_at := NULL;
            NEW.origin := 'import';
            NEW.mentions := '{}';
            RETURN NEW;
        END IF;
        IF (SELECT count(*) FROM public.task_comments tc
            WHERE tc.author_id = v_uid AND tc.created_at > now() - interval '1 minute') >= 20 THEN
            RAISE EXCEPTION 'Příliš mnoho komentářů za krátkou dobu. Zkuste to za chvíli.' USING ERRCODE = 'PT429';
        END IF;
        NEW.author_id := v_uid;
        NEW.author_name := left(public.collab_actor_name(v_pid, v_uid), 200);
        NEW.created_at := now();
        NEW.updated_at := NULL;
        NEW.origin := 'app';
    ELSE
        IF OLD.author_id IS DISTINCT FROM v_uid OR OLD.origin <> 'app' THEN
            RAISE EXCEPTION 'Upravit lze jen vlastní komentář.' USING ERRCODE = '42501';
        END IF;
        NEW.id := OLD.id;
        NEW.card_id := OLD.card_id;
        NEW.author_id := OLD.author_id;
        NEW.author_name := OLD.author_name;
        NEW.created_at := OLD.created_at;
        NEW.origin := OLD.origin;
        NEW.updated_at := CASE WHEN NEW.content IS DISTINCT FROM OLD.content THEN now() ELSE OLD.updated_at END;
    END IF;
    NEW.mentions := public.collab_clean_mentions(v_pid, NEW.mentions, v_uid);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_comment_rules_v2() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS c_collab_comment_rules ON public.task_comments;
CREATE TRIGGER c_collab_comment_rules BEFORE INSERT OR UPDATE OR DELETE ON public.task_comments
    FOR EACH ROW EXECUTE FUNCTION public.collab_comment_rules_v2();

CREATE OR REPLACE FUNCTION public.collab_comment_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_card public.cards%ROWTYPE;
BEGIN
    SELECT * INTO v_card FROM public.cards c WHERE c.id = coalesce(NEW.card_id, OLD.card_id);
    IF NOT FOUND OR public.collab_in_board_import(v_card.id) THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.content IS DISTINCT FROM OLD.content THEN
            INSERT INTO public.task_comment_revisions (comment_id, content, edited_by) VALUES (OLD.id, OLD.content, auth.uid());
            PERFORM public.collab_emit(v_card.project_id, 'comment_edited', 'comment', NEW.id, v_card.id,
                jsonb_build_object('title', v_card.title, 'comment_id', NEW.id));
        END IF;
    ELSIF auth.uid() IS NOT NULL THEN
        PERFORM public.collab_emit(v_card.project_id, 'comment_deleted', 'comment', OLD.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'comment_id', OLD.id, 'author', OLD.author_name));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_comment_history() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS collab_comment_history ON public.task_comments;
CREATE TRIGGER collab_comment_history AFTER UPDATE OF content OR DELETE ON public.task_comments
    FOR EACH ROW EXECUTE FUNCTION public.collab_comment_history();

-- ------------------------------------------------------------
-- 5. Trusted task history
-- ------------------------------------------------------------
-- task_activities (client-written text) is legacy: readable, but clients may only write it as part of a
-- board restore. The task history is now the trusted event log (activity_logs.card_id).
CREATE OR REPLACE FUNCTION public.collab_legacy_history_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL THEN RETURN coalesce(NEW, OLD); END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.cards c WHERE c.id = OLD.card_id) THEN RETURN OLD; END IF; -- cascade
    IF TG_OP = 'INSERT' AND public.collab_in_board_import(NEW.card_id)
       AND public.project_role_of((SELECT c.project_id FROM public.cards c WHERE c.id = NEW.card_id), auth.uid()) = 'owner' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Historii úkolu zapisuje server.' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.collab_legacy_history_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS c_collab_legacy_history ON public.task_activities;
CREATE TRIGGER c_collab_legacy_history BEFORE INSERT OR UPDATE OR DELETE ON public.task_activities
    FOR EACH ROW EXECUTE FUNCTION public.collab_legacy_history_guard();

CREATE OR REPLACE FUNCTION public.collab_checklist_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_card public.cards%ROWTYPE;
BEGIN
    SELECT * INTO v_card FROM public.cards c WHERE c.id = coalesce(NEW.card_id, OLD.card_id);
    IF NOT FOUND OR public.collab_in_board_import(v_card.id) THEN RETURN NULL; END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM public.collab_emit(v_card.project_id, 'checklist_item_added', 'checklist', NEW.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'item', left(NEW.text, 200)));
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.collab_emit(v_card.project_id, 'checklist_item_removed', 'checklist', OLD.id, v_card.id,
            jsonb_build_object('title', v_card.title, 'item', left(OLD.text, 200)));
    ELSE
        IF NEW.completed IS DISTINCT FROM OLD.completed THEN
            PERFORM public.collab_emit(v_card.project_id,
                CASE WHEN NEW.completed THEN 'checklist_item_completed' ELSE 'checklist_item_reopened' END,
                'checklist', NEW.id, v_card.id, jsonb_build_object('title', v_card.title, 'item', left(NEW.text, 200)));
        END IF;
        IF NEW.text IS DISTINCT FROM OLD.text THEN
            PERFORM public.collab_emit(v_card.project_id, 'checklist_item_renamed', 'checklist', NEW.id, v_card.id,
                jsonb_build_object('title', v_card.title, 'from', left(OLD.text, 200), 'to', left(NEW.text, 200)));
        END IF;
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.collab_checklist_events() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS collab_checklist_events ON public.task_checklists;
CREATE TRIGGER collab_checklist_events AFTER INSERT OR UPDATE OR DELETE ON public.task_checklists
    FOR EACH ROW EXECUTE FUNCTION public.collab_checklist_events();

-- Board restore with the import context (comments/history copied from the snapshot are marked).
CREATE OR REPLACE FUNCTION public.restore_project_board_v2(p_project_id TEXT, p_board JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result JSONB;
BEGIN
    PERFORM set_config('clearspace.import_context', 'board_restore', true);
    v_result := public.restore_project_board(p_project_id, p_board);
    PERFORM set_config('clearspace.import_context', '', true);
    RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.restore_project_board_v2(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_project_board_v2(TEXT, JSONB) TO authenticated;

-- ------------------------------------------------------------
-- 6. Atomic column reorder
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reorder_columns(p_project_id TEXT, p_ordered_ids TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_current TEXT[];
BEGIN
    IF NOT public.can_edit_project(p_project_id) THEN
        RAISE EXCEPTION 'Pořadí sloupců může měnit jen editor projektu.' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('columns_order:' || p_project_id, 0));
    SELECT array_agg(c.id ORDER BY c.id) INTO v_current FROM public.columns c WHERE c.project_id = p_project_id;
    IF v_current IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(p_ordered_ids) x) THEN
        -- PT409: PostgREST answers HTTP 409 and does NOT retry (it retries SQLSTATE 40001 serialization failures)
        RAISE EXCEPTION 'Sloupce se mezitím změnily. Načtěte board znovu a pořadí upravte.' USING ERRCODE = 'PT409';
    END IF;
    UPDATE public.columns c SET position = o.ord - 1
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS o(id, ord)
    WHERE c.id = o.id AND c.project_id = p_project_id AND c.position IS DISTINCT FROM o.ord - 1;
END $$;
REVOKE ALL ON FUNCTION public.reorder_columns(TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_columns(TEXT, TEXT[]) TO authenticated;

-- ------------------------------------------------------------
-- 7. Invitation e-mail delivery
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invitation_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id TEXT NOT NULL REFERENCES public.invitations(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'resend')),
    recipient TEXT NOT NULL CHECK (char_length(recipient) <= 254),
    status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'accepted', 'failed', 'suppressed')),
    transport TEXT CHECK (char_length(transport) <= 32),
    provider_message_id TEXT CHECK (char_length(provider_message_id) <= 200),
    error_code TEXT CHECK (char_length(error_code) <= 64),
    error_detail TEXT CHECK (char_length(error_detail) <= 300),
    requested_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (invitation_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_invitation_deliveries_inv ON public.invitation_deliveries (invitation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invitation_deliveries_requester ON public.invitation_deliveries (requested_by, created_at DESC);
ALTER TABLE public.invitation_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Inviters read delivery state" ON public.invitation_deliveries;
CREATE POLICY "Inviters read delivery state" ON public.invitation_deliveries FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.invitations i WHERE i.id = invitation_id
                   AND (i.workspace_id = auth.uid() OR (i.project_id IS NOT NULL AND public.can_manage_project(i.project_id)))));
REVOKE ALL ON public.invitation_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invitation_deliveries TO authenticated;
GRANT ALL ON public.invitation_deliveries TO service_role;

-- No second invitation to the same address of the same project within a minute (double clicks,
-- retries of the whole request): the first one -- and its e-mail -- stays valid.
CREATE OR REPLACE FUNCTION public.collab_invitation_duplicate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.project_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.invitations i
        WHERE i.workspace_id = NEW.workspace_id AND lower(i.email) = lower(NEW.email)
          AND i.project_id IS NOT DISTINCT FROM NEW.project_id
          AND i.created_at > now() - interval '60 seconds' AND i.created_at < now()) THEN
        RAISE EXCEPTION 'Pozvánka na tuto adresu byla právě odeslána. Pro nové odeslání použijte „Poslat znovu“.' USING ERRCODE = 'PT429';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collab_invitation_duplicate_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS a_collab_invitation_duplicate ON public.invitations;
CREATE TRIGGER a_collab_invitation_duplicate BEFORE INSERT ON public.invitations
    FOR EACH ROW EXECUTE FUNCTION public.collab_invitation_duplicate_guard();

-- Resend = a NEW token (the previous link stops working) and a fresh 7-day validity. Owner/admin of the
-- project (or the workspace owner); at most 5 per invitation per 24 h, not more often than once a minute.
CREATE OR REPLACE FUNCTION public.reissue_invitation_token(p_invitation_id TEXT)
RETURNS TABLE (id TEXT, token TEXT, expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv public.invitations%ROWTYPE;
    v_token TEXT;
    v_expires TIMESTAMP WITH TIME ZONE := now() + interval '7 days';
    v_recent INTEGER;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    SELECT * INTO v_inv FROM public.invitations i WHERE i.id = p_invitation_id FOR UPDATE;
    IF NOT FOUND OR NOT (v_inv.workspace_id = auth.uid()
                         OR (v_inv.project_id IS NOT NULL AND public.can_manage_project(v_inv.project_id))) THEN
        RAISE EXCEPTION 'Pozvánku nelze znovu odeslat.' USING ERRCODE = '42501';
    END IF;
    IF v_inv.status <> 'pending' THEN
        RAISE EXCEPTION 'Pozvánka už byla přijata nebo zrušena.' USING ERRCODE = '22023';
    END IF;
    IF v_inv.project_role = 'admin' AND NOT public.project_role(v_inv.project_id) = 'owner' THEN
        RAISE EXCEPTION 'Pozvánku správce může znovu odeslat jen vlastník.' USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_recent FROM public.invitation_deliveries d
    WHERE d.invitation_id = v_inv.id AND d.kind = 'resend' AND d.created_at > now() - interval '24 hours';
    IF v_recent >= 5 THEN
        RAISE EXCEPTION 'Tuto pozvánku už nelze dnes znovu odeslat.' USING ERRCODE = 'PT429';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invitation_deliveries d WHERE d.invitation_id = v_inv.id
               AND d.created_at > now() - interval '60 seconds') THEN
        RAISE EXCEPTION 'Pozvánka byla právě odeslána. Zkuste to za minutu.' USING ERRCODE = 'PT429';
    END IF;
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    UPDATE public.invitations i SET token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex'), expires_at = v_expires
    WHERE i.id = v_inv.id;
    RETURN QUERY SELECT v_inv.id, v_token, v_expires;
END $$;
REVOKE ALL ON FUNCTION public.reissue_invitation_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reissue_invitation_token(TEXT) TO authenticated;

-- Server-only bookkeeping (EMAIL_SERVER_SECRET, registered as server_trust purpose 'email'): the caller is
-- the inviting user (auth.uid()), the secret proves the request comes from the ClearSpace server.
CREATE OR REPLACE FUNCTION public.email_delivery_start(p_server_secret TEXT, p_invitation_id TEXT, p_kind TEXT)
RETURNS TABLE (delivery_id UUID, recipient TEXT, project_name TEXT, inviter_name TEXT, project_role TEXT,
               expires_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_inv public.invitations%ROWTYPE;
    v_id UUID;
    v_attempt INTEGER;
BEGIN
    PERFORM public.require_server_secret('email', p_server_secret);
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Musíte být přihlášeni.' USING ERRCODE = '28000'; END IF;
    IF p_kind NOT IN ('invite', 'resend') THEN RAISE EXCEPTION 'Neplatný druh odeslání.' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_inv FROM public.invitations i WHERE i.id = p_invitation_id FOR UPDATE;
    IF NOT FOUND OR NOT (v_inv.workspace_id = auth.uid()
                         OR (v_inv.project_id IS NOT NULL AND public.can_manage_project(v_inv.project_id))) THEN
        RAISE EXCEPTION 'Pozvánku nelze odeslat.' USING ERRCODE = '42501';
    END IF;
    IF v_inv.status <> 'pending' OR v_inv.expires_at < now() THEN
        RAISE EXCEPTION 'Pozvánka už není platná.' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.invitation_deliveries d
        WHERE d.requested_by = auth.uid() AND d.created_at > now() - interval '1 hour') >= 30 THEN
        RAISE EXCEPTION 'Příliš mnoho odeslaných pozvánek za hodinu.' USING ERRCODE = 'PT429';
    END IF;
    SELECT coalesce(max(d.attempt_no), 0) + 1 INTO v_attempt FROM public.invitation_deliveries d WHERE d.invitation_id = v_inv.id;
    INSERT INTO public.invitation_deliveries (invitation_id, project_id, attempt_no, kind, recipient, requested_by)
    VALUES (v_inv.id, v_inv.project_id, v_attempt, p_kind, v_inv.email, auth.uid())
    RETURNING public.invitation_deliveries.id INTO v_id;
    RETURN QUERY SELECT v_id, v_inv.email,
        coalesce((SELECT p.name FROM public.projects p WHERE p.id = v_inv.project_id), 'ClearSpace'),
        public.collab_actor_name(v_inv.project_id, auth.uid()),
        v_inv.project_role, v_inv.expires_at;
END $$;

CREATE OR REPLACE FUNCTION public.email_delivery_finish(
    p_server_secret TEXT, p_delivery_id UUID, p_status TEXT, p_transport TEXT,
    p_provider_message_id TEXT, p_error_code TEXT, p_error_detail TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.require_server_secret('email', p_server_secret);
    IF p_status NOT IN ('accepted', 'failed', 'suppressed') THEN
        RAISE EXCEPTION 'Neplatný stav doručení.' USING ERRCODE = '22023';
    END IF;
    UPDATE public.invitation_deliveries d
    SET status = p_status, transport = left(p_transport, 32), provider_message_id = left(p_provider_message_id, 200),
        error_code = left(p_error_code, 64), error_detail = left(p_error_detail, 300), updated_at = now()
    WHERE d.id = p_delivery_id AND d.requested_by = auth.uid() AND d.status = 'sending';
END $$;

REVOKE ALL ON FUNCTION public.email_delivery_start(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.email_delivery_finish(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.email_delivery_start(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.email_delivery_finish(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

INSERT INTO public.clearspace_migrations (version) VALUES ('20261125001100_collab_hardening')
ON CONFLICT (version) DO NOTHING;
