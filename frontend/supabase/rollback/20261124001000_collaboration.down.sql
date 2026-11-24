-- ============================================================
-- Rollback of 20261124001000_collaboration -> the 20261118000900 catalog.
--
-- REFUSES (changes nothing) while rolling back would silently WIDEN access or lose a grant:
--   * project members with role admin or viewer exist (the old model knows only owner/member;
--     a viewer would become a full editor),
--   * pending project invitations exist (they would turn into plain workspace invitations).
-- Drops: notifications (derived, per-user inbox), event metadata columns of activity_logs
-- (source, entity_id, ...; the rows themselves are kept), cards.project_id/version/child_rev
-- (derived), task_comments.author_id/updated_at/mentions (author_name stays).
-- Afterwards clients may write activity_logs again (the pre-collaboration contract).
-- Run as one transaction:  psql --single-transaction -f 20261124001000_collaboration.down.sql
-- ============================================================
DO $$
DECLARE v_n BIGINT;
BEGIN
    SELECT count(*) INTO v_n FROM public.project_members WHERE project_role IN ('admin', 'viewer');
    IF v_n > 0 THEN
        RAISE EXCEPTION 'Rollback refused: % project members have role admin/viewer; change them to member or remove them first (a viewer would otherwise become an editor). Nothing was changed.', v_n;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invitations' AND column_name = 'project_id') THEN
        EXECUTE 'SELECT count(*) FROM public.invitations WHERE project_id IS NOT NULL AND status = ''pending''' INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback refused: % pending project invitations exist; revoke them first. Nothing was changed.', v_n;
        END IF;
    END IF;
END $$;

-- policies that depend on the functions below
DROP POLICY IF EXISTS "Project managers can view project invitations" ON public.invitations;
-- realtime + storage policies
DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_read" ON realtime.messages';
        EXECUTE 'DROP POLICY IF EXISTS "clearspace_project_channel_write" ON realtime.messages';
    END IF;
    IF to_regclass('storage.objects') IS NOT NULL THEN
        EXECUTE 'DROP POLICY IF EXISTS "collab_viewer_no_upload" ON storage.objects';
        EXECUTE 'DROP POLICY IF EXISTS "collab_viewer_no_delete" ON storage.objects';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'project_members') THEN
        ALTER PUBLICATION supabase_realtime DROP TABLE public.project_members;
    END IF;
END $$;

-- triggers
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['task_checklists', 'task_comments', 'card_assignees', 'task_resources'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS z_collab_touch_card ON public.%I', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['columns', 'cards', 'task_checklists', 'task_comments', 'task_activities', 'card_assignees',
                             'task_resources', 'meetings', 'meeting_transcripts', 'intelligence_items'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS b_collab_guard_write ON public.%I', t);
    END LOOP;
END $$;
DROP TRIGGER IF EXISTS a_cards_server_fields ON public.cards;
DROP TRIGGER IF EXISTS collab_card_events ON public.cards;
DROP TRIGGER IF EXISTS collab_assignee_events ON public.card_assignees;
DROP TRIGGER IF EXISTS collab_column_events ON public.columns;
DROP TRIGGER IF EXISTS collab_project_events ON public.projects;
DROP TRIGGER IF EXISTS collab_member_events ON public.project_members;
DROP TRIGGER IF EXISTS collab_workspace_member_removed ON public.workspace_members;
DROP TRIGGER IF EXISTS c_collab_comment_rules ON public.task_comments;
DROP TRIGGER IF EXISTS collab_comment_events ON public.task_comments;
DROP TRIGGER IF EXISTS collab_invitation_accepted ON public.invitations;
DROP TRIGGER IF EXISTS a_collab_client_event_rules ON public.activity_logs;

-- functions
DROP FUNCTION IF EXISTS public.create_project_invitation(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.revoke_invitation(TEXT);
DROP FUNCTION IF EXISTS public.accept_invitation_by_id(TEXT);
DROP FUNCTION IF EXISTS public.collab_invitation_accepted();
DROP FUNCTION IF EXISTS public.set_project_member(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.remove_project_member(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.collab_assert_can_manage(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.collab_sync_member_mirror(TEXT);
DROP FUNCTION IF EXISTS public.collab_comment_events();
DROP FUNCTION IF EXISTS public.collab_comment_rules();
DROP FUNCTION IF EXISTS public.collab_clean_mentions(TEXT, UUID[], UUID);
DROP FUNCTION IF EXISTS public.collab_workspace_member_removed();
DROP FUNCTION IF EXISTS public.collab_member_events();
DROP FUNCTION IF EXISTS public.collab_project_events();
DROP FUNCTION IF EXISTS public.collab_column_events();
DROP FUNCTION IF EXISTS public.collab_assignee_events();
DROP FUNCTION IF EXISTS public.collab_card_events();
DROP FUNCTION IF EXISTS public.collab_client_event_rules();
DROP FUNCTION IF EXISTS public.collab_notify(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.collab_is_done_column(TEXT);
DROP FUNCTION IF EXISTS public.collab_already_logged(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.collab_column_is_new(TEXT);
DROP FUNCTION IF EXISTS public.collab_emit(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.collab_actor_name(TEXT, UUID);
DROP FUNCTION IF EXISTS public.collab_storage_project(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.collab_guard_write();
DROP FUNCTION IF EXISTS public.collab_project_of(JSONB);
DROP FUNCTION IF EXISTS public.collab_touch_card();
DROP FUNCTION IF EXISTS public.cards_server_fields();
DROP FUNCTION IF EXISTS public.can_manage_project(TEXT);
DROP FUNCTION IF EXISTS public.can_edit_project(TEXT);
DROP FUNCTION IF EXISTS public.project_role(TEXT);
DROP FUNCTION IF EXISTS public.project_role_of(TEXT, UUID);

-- notifications
DROP TABLE IF EXISTS public.notifications;

-- invitations
DROP INDEX IF EXISTS public.idx_invitations_project;
DROP INDEX IF EXISTS public.idx_invitations_inviter;
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_project_role_check;
ALTER TABLE public.invitations DROP COLUMN IF EXISTS project_role;
ALTER TABLE public.invitations DROP COLUMN IF EXISTS project_id;

-- comments
DROP INDEX IF EXISTS public.idx_task_comments_card;
DROP INDEX IF EXISTS public.idx_task_comments_author;
ALTER TABLE public.task_comments DROP COLUMN IF EXISTS mentions;
ALTER TABLE public.task_comments DROP COLUMN IF EXISTS updated_at;
ALTER TABLE public.task_comments DROP COLUMN IF EXISTS author_id;

-- activity_logs: back to client-written events
DROP INDEX IF EXISTS public.activity_logs_idempotency;
DROP INDEX IF EXISTS public.idx_activity_logs_project_created;
DROP INDEX IF EXISTS public.idx_activity_logs_card;
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_source_format;
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_correlation_len;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS schema_version;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS source;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS entity_id;
ALTER TABLE public.activity_logs DROP COLUMN IF EXISTS workspace_id;
GRANT INSERT, UPDATE, DELETE ON public.activity_logs TO authenticated;

-- cards
DROP INDEX IF EXISTS public.idx_cards_project;
ALTER TABLE public.cards DROP COLUMN IF EXISTS child_rev;
ALTER TABLE public.cards DROP COLUMN IF EXISTS version;
ALTER TABLE public.cards DROP COLUMN IF EXISTS project_id;

-- roles
DROP INDEX IF EXISTS public.idx_project_members_member;
ALTER TABLE public.project_members DROP CONSTRAINT IF EXISTS project_members_project_role_check;
ALTER TABLE public.project_members
    ADD CONSTRAINT project_members_project_role_check CHECK (project_role IN ('owner', 'member'));

DELETE FROM public.clearspace_migrations WHERE version = '20261124001000_collaboration';
