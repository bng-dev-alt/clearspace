-- ============================================================
-- Rollback of 20261125001100_collab_hardening -> the 20261124001000 catalog.
--
-- REFUSES (changes nothing) while it would destroy data, unless the operator sets
--   SET clearspace.rollback_allow_data_loss = 'on';   (in the same session, before running this file)
--   * comment edit history exists (task_comment_revisions),
--   * invitation delivery records exist (invitation_deliveries).
-- Re-opens what 0100/1000 allowed: collaborators see the owner's whole address book again, Realtime goes back
-- to postgres_changes (DELETE payloads reach every subscriber), clients may write task_activities again.
-- Run as one transaction: psql --single-transaction -f 20261125001100_collab_hardening.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    IF coalesce(current_setting('clearspace.rollback_allow_data_loss', true), '') <> 'on' THEN
        IF to_regclass('public.task_comment_revisions') IS NOT NULL THEN
            EXECUTE 'SELECT count(*) FROM public.task_comment_revisions' INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'Rollback refused: % comment edit-history rows would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
            END IF;
        END IF;
        IF to_regclass('public.invitation_deliveries') IS NOT NULL THEN
            EXECUTE 'SELECT count(*) FROM public.invitation_deliveries' INTO v_n;
            IF v_n > 0 THEN
                RAISE EXCEPTION 'Rollback refused: % invitation delivery records would be lost (set clearspace.rollback_allow_data_loss = on to accept). Nothing was changed.', v_n;
            END IF;
        END IF;
    END IF;
END $$;

-- 7. invitation delivery
DROP TRIGGER IF EXISTS a_collab_invitation_duplicate ON public.invitations;
DROP FUNCTION IF EXISTS public.collab_invitation_duplicate_guard();
DROP FUNCTION IF EXISTS public.email_delivery_finish(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.email_delivery_start(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.reissue_invitation_token(TEXT);
DROP TABLE IF EXISTS public.invitation_deliveries;

-- 6. reorder
DROP FUNCTION IF EXISTS public.reorder_columns(TEXT, TEXT[]);

-- 5. task history
DROP FUNCTION IF EXISTS public.restore_project_board_v2(TEXT, JSONB);
DROP TRIGGER IF EXISTS collab_checklist_events ON public.task_checklists;
DROP FUNCTION IF EXISTS public.collab_checklist_events();
DROP TRIGGER IF EXISTS c_collab_legacy_history ON public.task_activities;
DROP FUNCTION IF EXISTS public.collab_legacy_history_guard();

-- 4. comments
DROP TRIGGER IF EXISTS collab_comment_history ON public.task_comments;
DROP FUNCTION IF EXISTS public.collab_comment_history();
DROP TRIGGER IF EXISTS c_collab_comment_rules ON public.task_comments;
CREATE TRIGGER c_collab_comment_rules BEFORE INSERT OR UPDATE OR DELETE ON public.task_comments
    FOR EACH ROW EXECUTE FUNCTION public.collab_comment_rules();
DROP FUNCTION IF EXISTS public.collab_comment_rules_v2();
DROP FUNCTION IF EXISTS public.collab_in_board_import(TEXT);
DROP TABLE IF EXISTS public.task_comment_revisions;
ALTER TABLE public.task_comments DROP CONSTRAINT IF EXISTS task_comments_origin_check;
ALTER TABLE public.task_comments DROP COLUMN IF EXISTS origin;

-- 3. cross-project moves / positions
DROP TRIGGER IF EXISTS collab_card_moved_projects ON public.cards;
DROP FUNCTION IF EXISTS public.collab_card_moved_projects();
DROP TRIGGER IF EXISTS a_cards_zmove ON public.cards;
DROP FUNCTION IF EXISTS public.collab_card_move_guard();
DROP TRIGGER IF EXISTS collab_card_events_update ON public.cards;
DROP TRIGGER IF EXISTS collab_card_events ON public.cards;
CREATE CONSTRAINT TRIGGER collab_card_events
    AFTER INSERT OR UPDATE OR DELETE ON public.cards
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.collab_card_events();

-- 2. realtime
DROP TRIGGER IF EXISTS z_collab_broadcast_card ON public.cards;
DROP TRIGGER IF EXISTS z_collab_broadcast_column ON public.columns;
DROP TRIGGER IF EXISTS z_collab_broadcast_activity ON public.activity_logs;
DROP TRIGGER IF EXISTS z_collab_broadcast_membership ON public.project_members;
DROP TRIGGER IF EXISTS z_collab_broadcast_notification ON public.notifications;
DROP FUNCTION IF EXISTS public.collab_broadcast_card();
DROP FUNCTION IF EXISTS public.collab_broadcast_column();
DROP FUNCTION IF EXISTS public.collab_broadcast_activity();
DROP FUNCTION IF EXISTS public.collab_broadcast_membership();
DROP FUNCTION IF EXISTS public.collab_broadcast_notification();
DROP FUNCTION IF EXISTS public.collab_project_topic(TEXT);
DROP FUNCTION IF EXISTS public.collab_send(TEXT, TEXT, JSONB);
DO $$
DECLARE t TEXT;
BEGIN
    IF to_regclass('realtime.messages') IS NOT NULL AND to_regprocedure('realtime.topic()') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_topic_read" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_topic_presence_write" ON realtime.messages';
        EXECUTE $p$CREATE POLICY "clearspace_project_channel_read" ON realtime.messages FOR SELECT TO authenticated
            USING (realtime.messages.extension IN ('presence', 'broadcast')
                   AND (SELECT realtime.topic()) LIKE 'project:%'
                   AND public.is_project_member(substr((SELECT realtime.topic()), 9)))$p$;
        EXECUTE $p$CREATE POLICY "clearspace_project_channel_write" ON realtime.messages FOR INSERT TO authenticated
            WITH CHECK (realtime.messages.extension IN ('presence', 'broadcast')
                        AND (SELECT realtime.topic()) LIKE 'project:%'
                        AND public.is_project_member(substr((SELECT realtime.topic()), 9)))$p$;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['columns', 'cards', 'activity_logs', 'notifications', 'project_members'] LOOP
            IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            END IF;
        END LOOP;
    END IF;
END $$;
DROP FUNCTION IF EXISTS public.collab_topic_allowed(TEXT);
ALTER TABLE public.projects DROP COLUMN IF EXISTS realtime_key;

-- 1. contact privacy
DROP TRIGGER IF EXISTS a_cards_sanitize ON public.cards;
DROP FUNCTION IF EXISTS public.collab_sanitize_card();
DROP POLICY IF EXISTS "Collaborators see people they share a project with" ON public.workspace_members;
DROP POLICY IF EXISTS "Collaborators can view workspaces they belong to" ON public.workspace_members;
CREATE POLICY "Collaborators can view workspaces they belong to"
    ON public.workspace_members FOR SELECT
    USING (public.can_view_workspace(public.workspace_members.owner_id));
DROP FUNCTION IF EXISTS public.collab_can_see_member(TEXT);

DELETE FROM public.clearspace_migrations WHERE version = '20261125001100_collab_hardening';
