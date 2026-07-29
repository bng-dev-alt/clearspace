-- ============================================================
-- Supabase Database Schema -- AI Workspace SaaS (Kanban)
-- Canonical schema, safe to re-run (idempotent).
-- Release 21 (Data Foundation): fixed task_activities policy,
-- added projects.team_members and cards.assignees.
-- ============================================================

-- 1. Profiles Table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read access to profiles" ON public.profiles;
CREATE POLICY "Allow public read access to profiles"
    ON public.profiles FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Allow users to update their own profile" ON public.profiles;
CREATE POLICY "Allow users to update their own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- 2. Trigger for Automatic Profile + Owner Member Creation on User Signup
-- Release 23: the new account is also inserted as its own workspace member
-- with role 'owner', linked back to the profile (profile_id). This unifies
-- the previously disconnected Profile and TeamMember identities.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
    v_display_name TEXT;
    v_initials TEXT;
BEGIN
    v_display_name := coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));

    INSERT INTO public.profiles (id, email, display_name, avatar_url)
    VALUES (new.id, new.email, v_display_name, new.raw_user_meta_data->>'avatar_url');

    -- Odvození iniciál z prvního a posledního slova jména (max 2 znaky)
    v_initials := upper(
        left(split_part(v_display_name, ' ', 1), 1) ||
        CASE
            WHEN position(' ' in v_display_name) > 0
            THEN left(split_part(v_display_name, ' ', array_length(string_to_array(v_display_name, ' '), 1)), 1)
            ELSE ''
        END
    );

    -- Vlastník účtu jako první člen svého workspace (idempotentně)
    INSERT INTO public.workspace_members (id, owner_id, profile_id, full_name, initials, avatar_color, email, workspace_role)
    VALUES ('member-owner-' || new.id, new.id, new.id, v_display_name, v_initials, '#209dd7', new.email, 'owner')
    ON CONFLICT (id) DO NOTHING;

    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Projects Table -- Data Isolation / Multi-tenancy
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.projects
ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Release 21: team members were stored as JSONB on the project (project-only membership).
-- Release 22 keeps this column for backward compatibility / migration, but project
-- membership is now expressed via member_ids referencing workspace_members (see below).
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS team_members JSONB DEFAULT NULL;

-- Release 22: project membership = references to workspace member ids (JSONB array).
-- Identity lives once in workspace_members; projects only select a subset.
ALTER TABLE public.projects
ADD COLUMN IF NOT EXISTS member_ids JSONB DEFAULT NULL;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own projects" ON public.projects;
CREATE POLICY "Users can view their own projects"
    ON public.projects FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own projects" ON public.projects;
CREATE POLICY "Users can insert their own projects"
    ON public.projects FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own projects" ON public.projects;
CREATE POLICY "Users can update their own projects"
    ON public.projects FOR UPDATE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own projects" ON public.projects;
CREATE POLICY "Users can delete their own projects"
    ON public.projects FOR DELETE
    USING (auth.uid() = user_id);

-- 4. Columns and Cards -- RLS through project ownership

ALTER TABLE public.columns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view columns of their projects" ON public.columns;
CREATE POLICY "Users can view columns of their projects"
    ON public.columns FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE public.projects.id = public.columns.project_id
            AND public.projects.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can manage columns of their projects" ON public.columns;
CREATE POLICY "Users can manage columns of their projects"
    ON public.columns FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE public.projects.id = public.columns.project_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- Release 21: multi-assignee list is stored as JSONB on the card.
-- Legacy assignee_name/initials/color columns keep holding the primary
-- assignee for backward compatibility (AI prompts, older data).
ALTER TABLE public.cards
ADD COLUMN IF NOT EXISTS assignees JSONB DEFAULT NULL;

ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view cards of their projects" ON public.cards;
CREATE POLICY "Users can view cards of their projects"
    ON public.cards FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.columns
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.columns.id = public.cards.column_id
            AND public.projects.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can manage cards of their projects" ON public.cards;
CREATE POLICY "Users can manage cards of their projects"
    ON public.cards FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.columns
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.columns.id = public.cards.column_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 5. Task Checklists Table
CREATE TABLE IF NOT EXISTS public.task_checklists (
    id TEXT PRIMARY KEY,
    card_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE NOT NULL,
    text TEXT NOT NULL,
    completed BOOLEAN DEFAULT false NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.task_checklists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage checklists of their projects" ON public.task_checklists;
CREATE POLICY "Users can manage checklists of their projects"
    ON public.task_checklists FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.cards.id = public.task_checklists.card_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 6. Task Comments Table
CREATE TABLE IF NOT EXISTS public.task_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage comments of their projects" ON public.task_comments;
CREATE POLICY "Users can manage comments of their projects"
    ON public.task_comments FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.cards.id = public.task_comments.card_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 7. Task Activities Table
-- (Release 21 fix: the original policy was missing a closing
-- parenthesis and the whole script failed to execute.)
CREATE TABLE IF NOT EXISTS public.task_activities (
    id TEXT PRIMARY KEY,
    card_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.task_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage activities of their projects" ON public.task_activities;
CREATE POLICY "Users can manage activities of their projects"
    ON public.task_activities FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.cards.id = public.task_activities.card_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 8. Archived and Timestamp Columns on Cards
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL;
ALTER TABLE public.cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL;

-- 9. Workspace Members (Release 22 - Workspace Collaboration)
-- The single source of member identity for the whole workspace (= the owner's account).
-- One implicit workspace per user for now; owner_id scopes the rows.
-- workspace_role is prepared for future Permissions but is NOT enforced yet.
CREATE TABLE IF NOT EXISTS public.workspace_members (
    id TEXT PRIMARY KEY,
    owner_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    initials TEXT NOT NULL,
    avatar_color TEXT NOT NULL DEFAULT '#209dd7',
    email TEXT,
    workspace_role TEXT NOT NULL DEFAULT 'member' CHECK (workspace_role IN ('owner', 'admin', 'member')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Release 23: link a workspace member to a real account (profile). NULL = placeholder
-- member (a contact who has no account yet -- ready for future Invite Members).
ALTER TABLE public.workspace_members
ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Optional free-text job title / role shown on the Team page.
ALTER TABLE public.workspace_members
ADD COLUMN IF NOT EXISTS job_title TEXT;

CREATE INDEX IF NOT EXISTS idx_workspace_members_owner ON public.workspace_members(owner_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_profile ON public.workspace_members(profile_id);

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own workspace members" ON public.workspace_members;
CREATE POLICY "Users can manage their own workspace members"
    ON public.workspace_members FOR ALL
    USING (auth.uid() = owner_id);

-- 10. Project Members (Release 23) -- relational membership.
-- Replaces the projects.member_ids JSONB array with a proper join table.
CREATE TABLE IF NOT EXISTS public.project_members (
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
    member_id TEXT REFERENCES public.workspace_members(id) ON DELETE CASCADE NOT NULL,
    project_role TEXT NOT NULL DEFAULT 'member' CHECK (project_role IN ('owner', 'member')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    PRIMARY KEY (project_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_project_members_project ON public.project_members(project_id);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage members of their projects" ON public.project_members;
CREATE POLICY "Users can manage members of their projects"
    ON public.project_members FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE public.projects.id = public.project_members.project_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 11. Card Assignees (Release 23) -- relational assignment.
-- Replaces the cards.assignees JSONB array with a proper join table.
CREATE TABLE IF NOT EXISTS public.card_assignees (
    card_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE NOT NULL,
    member_id TEXT REFERENCES public.workspace_members(id) ON DELETE CASCADE NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (card_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_card_assignees_card ON public.card_assignees(card_id);

ALTER TABLE public.card_assignees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage assignees of their projects" ON public.card_assignees;
CREATE POLICY "Users can manage assignees of their projects"
    ON public.card_assignees FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.cards.id = public.card_assignees.card_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 13. Workspace Invitations (Team Collaboration v1.3)
-- Refactored from project-level to workspace-level (v1.2 had project_id).
-- Idempotent: drop old column, add new one. Works safely on repeated runs.
CREATE TABLE IF NOT EXISTS public.invitations (
    id TEXT PRIMARY KEY,
    workspace_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    invited_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- CREATE TABLE IF NOT EXISTS is a no-op when the table already exists from
-- an earlier release (v1.2 had project_id/no workspace_id/no accepted_at) --
-- these columns must be added explicitly, not just declared above.
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- Old (v1.2) policies reference project_id -- must be dropped BEFORE the
-- migration below tries to drop that column, or Postgres refuses (column
-- still depended on by these policy definitions).
DROP POLICY IF EXISTS "Users can view invitations for their email or projects" ON public.invitations;
DROP POLICY IF EXISTS "Project owners can manage invitations" ON public.invitations;

-- Migrate old project_id schema to workspace_id (v1.2 → v1.3).
-- Idempotent: only runs if the column exists.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invitations' AND column_name = 'project_id'
    ) THEN
        -- Backfill workspace_id from projects.user_id for existing rows.
        UPDATE public.invitations inv
        SET workspace_id = p.user_id
        FROM public.projects p
        WHERE inv.project_id = p.id AND inv.workspace_id IS NULL;

        -- Drop the old column.
        ALTER TABLE public.invitations DROP COLUMN project_id;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_invitations_project;
CREATE INDEX IF NOT EXISTS idx_invitations_workspace ON public.invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON public.invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON public.invitations(email);

DROP POLICY IF EXISTS "Users can view invitations for their email or workspace" ON public.invitations;
CREATE POLICY "Users can view invitations for their email or workspace"
    ON public.invitations FOR SELECT
    USING (
        auth.jwt() ->> 'email' = email
        OR public.invitations.workspace_id = auth.uid()
    );

DROP POLICY IF EXISTS "Workspace owners can manage invitations" ON public.invitations;
CREATE POLICY "Workspace owners can manage invitations"
    ON public.invitations FOR ALL
    USING (public.invitations.workspace_id = auth.uid());

-- 14. Activity Logs (Team Collaboration v1.2)
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES public.projects(id) ON DELETE CASCADE NOT NULL,
    card_id TEXT REFERENCES public.cards(id) ON DELETE SET NULL,
    actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_project ON public.activity_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs(created_at DESC);

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view activity logs of their projects" ON public.activity_logs;
CREATE POLICY "Users can view activity logs of their projects"
    ON public.activity_logs FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE public.projects.id = public.activity_logs.project_id
            AND public.projects.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can insert activity logs for their projects" ON public.activity_logs;
CREATE POLICY "Users can insert activity logs for their projects"
    ON public.activity_logs FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.projects
            WHERE public.projects.id = public.activity_logs.project_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 15. Task Resources (Task Resources v1)
CREATE TABLE IF NOT EXISTS public.task_resources (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES public.cards(id) ON DELETE CASCADE NOT NULL,
    storage_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_resources_task ON public.task_resources(task_id);

ALTER TABLE public.task_resources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage task resources of their projects" ON public.task_resources;
CREATE POLICY "Users can manage task resources of their projects"
    ON public.task_resources FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            JOIN public.projects ON public.projects.id = public.columns.project_id
            WHERE public.cards.id = public.task_resources.task_id
            AND public.projects.user_id = auth.uid()
        )
    );

-- 12. One-time backfill migration from JSONB -> relational join tables (idempotent).
-- Safe to run repeatedly; existing rows are skipped via ON CONFLICT.
DO $$
DECLARE
    proj RECORD;
    crd RECORD;
    mid TEXT;
BEGIN
    -- projects.member_ids -> project_members
    FOR proj IN SELECT id, member_ids FROM public.projects WHERE member_ids IS NOT NULL LOOP
        FOR mid IN SELECT jsonb_array_elements_text(proj.member_ids) LOOP
            IF EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.id = mid) THEN
                INSERT INTO public.project_members (project_id, member_id)
                VALUES (proj.id, mid)
                ON CONFLICT (project_id, member_id) DO NOTHING;
            END IF;
        END LOOP;
    END LOOP;

    -- cards.assignees (array of member objects) -> card_assignees
    FOR crd IN SELECT id, assignees FROM public.cards WHERE assignees IS NOT NULL LOOP
        INSERT INTO public.card_assignees (card_id, member_id, position)
        SELECT crd.id, elem->>'id', (ord - 1)
        FROM jsonb_array_elements(crd.assignees) WITH ORDINALITY AS t(elem, ord)
        WHERE EXISTS (SELECT 1 FROM public.workspace_members wm WHERE wm.id = elem->>'id')
        ON CONFLICT (card_id, member_id) DO NOTHING;
    END LOOP;
END $$;

-- ============================================================
-- 16. Membership-aware RLS + Invitation Accept (Team Collaboration v1.3)
-- RLS was owner-only everywhere (see 58_collaboration_analysis_and_plan.md,
-- part 2.1). This section widens read/write access to project members
-- (via project_members -> workspace_members.profile_id) while keeping
-- project deletion/archiving and member/invitation management owner-only.
-- Placed at the end of the file (not inline with each table's original
-- section) because the helper functions below depend on project_members
-- and workspace_members, which are declared later in the file than the
-- earliest policies they need to widen (projects, columns, cards).
-- DROP POLICY + CREATE POLICY is idempotent, so this section supersedes
-- the earlier, narrower policy definitions on every re-run.
-- ============================================================

-- Is the current user the owner of this project?
CREATE OR REPLACE FUNCTION public.is_project_owner(p_project_id TEXT)
RETURNS boolean AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.projects
        WHERE public.projects.id = p_project_id
        AND public.projects.user_id = auth.uid()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Is the current user the owner OR an invited member of this project?
-- SECURITY DEFINER so this bypasses RLS on project_members/workspace_members
-- internally -- calling it FROM a policy on those same tables would
-- otherwise recurse into their own RLS checks.
CREATE OR REPLACE FUNCTION public.is_project_member(p_project_id TEXT)
RETURNS boolean AS $$
    SELECT public.is_project_owner(p_project_id)
    OR EXISTS (
        SELECT 1 FROM public.project_members pm
        JOIN public.workspace_members wm ON wm.id = pm.member_id
        WHERE pm.project_id = p_project_id
        AND wm.profile_id = auth.uid()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Can the current user see this workspace's contact list? True for the
-- workspace owner, and for anyone who collaborates on at least one of
-- that owner's projects (needed so an invited member can resolve/assign
-- teammates on a shared board).
CREATE OR REPLACE FUNCTION public.can_view_workspace(p_owner_id UUID)
RETURNS boolean AS $$
    SELECT p_owner_id = auth.uid()
    OR EXISTS (
        SELECT 1 FROM public.project_members pm
        JOIN public.projects p ON p.id = pm.project_id
        JOIN public.workspace_members me ON me.id = pm.member_id
        WHERE p.user_id = p_owner_id
        AND me.profile_id = auth.uid()
    );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Projects: members can read (not just the owner). Insert/update/delete
-- stay owner-only (untouched) -- archiving/deleting is an owner action.
DROP POLICY IF EXISTS "Users can view their own projects" ON public.projects;
CREATE POLICY "Users can view their own projects"
    ON public.projects FOR SELECT
    USING (public.is_project_member(id));

-- Columns: members can fully collaborate (create/rename/reorder/delete).
DROP POLICY IF EXISTS "Users can view columns of their projects" ON public.columns;
CREATE POLICY "Users can view columns of their projects"
    ON public.columns FOR SELECT
    USING (public.is_project_member(public.columns.project_id));

DROP POLICY IF EXISTS "Users can manage columns of their projects" ON public.columns;
CREATE POLICY "Users can manage columns of their projects"
    ON public.columns FOR ALL
    USING (public.is_project_member(public.columns.project_id));

-- Cards: members can fully collaborate.
DROP POLICY IF EXISTS "Users can view cards of their projects" ON public.cards;
CREATE POLICY "Users can view cards of their projects"
    ON public.cards FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.columns
            WHERE public.columns.id = public.cards.column_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

DROP POLICY IF EXISTS "Users can manage cards of their projects" ON public.cards;
CREATE POLICY "Users can manage cards of their projects"
    ON public.cards FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.columns
            WHERE public.columns.id = public.cards.column_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

-- Checklists / comments / activities / resources: same member-collaborate rule.
DROP POLICY IF EXISTS "Users can manage checklists of their projects" ON public.task_checklists;
CREATE POLICY "Users can manage checklists of their projects"
    ON public.task_checklists FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            WHERE public.cards.id = public.task_checklists.card_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

DROP POLICY IF EXISTS "Users can manage comments of their projects" ON public.task_comments;
CREATE POLICY "Users can manage comments of their projects"
    ON public.task_comments FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            WHERE public.cards.id = public.task_comments.card_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

DROP POLICY IF EXISTS "Users can manage activities of their projects" ON public.task_activities;
CREATE POLICY "Users can manage activities of their projects"
    ON public.task_activities FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            WHERE public.cards.id = public.task_activities.card_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

DROP POLICY IF EXISTS "Users can manage task resources of their projects" ON public.task_resources;
CREATE POLICY "Users can manage task resources of their projects"
    ON public.task_resources FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            WHERE public.cards.id = public.task_resources.task_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

DROP POLICY IF EXISTS "Users can manage assignees of their projects" ON public.card_assignees;
CREATE POLICY "Users can manage assignees of their projects"
    ON public.card_assignees FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.cards
            JOIN public.columns ON public.columns.id = public.cards.column_id
            WHERE public.cards.id = public.card_assignees.card_id
            AND public.is_project_member(public.columns.project_id)
        )
    );

-- Activity logs: members can read and log activity, not just the owner.
DROP POLICY IF EXISTS "Users can view activity logs of their projects" ON public.activity_logs;
CREATE POLICY "Users can view activity logs of their projects"
    ON public.activity_logs FOR SELECT
    USING (public.is_project_member(public.activity_logs.project_id));

DROP POLICY IF EXISTS "Users can insert activity logs for their projects" ON public.activity_logs;
CREATE POLICY "Users can insert activity logs for their projects"
    ON public.activity_logs FOR INSERT
    WITH CHECK (public.is_project_member(public.activity_logs.project_id));

-- Project members: a plain member may SEE the roster (needed for the
-- members list / assignee picker); adding, changing role, or removing
-- members stays owner-only via the original "manage" policy from
-- section 10 (multiple permissive SELECT policies are OR'd together).
DROP POLICY IF EXISTS "Members can view the roster of their projects" ON public.project_members;
CREATE POLICY "Members can view the roster of their projects"
    ON public.project_members FOR SELECT
    USING (public.is_project_member(public.project_members.project_id));

-- Workspace members: a collaborator may see the contact list of any
-- workspace they've been invited into (to resolve/assign teammates),
-- in addition to the owner managing their own list (section 9).
DROP POLICY IF EXISTS "Collaborators can view workspaces they belong to" ON public.workspace_members;
CREATE POLICY "Collaborators can view workspaces they belong to"
    ON public.workspace_members FOR SELECT
    USING (public.can_view_workspace(public.workspace_members.owner_id));

-- Atomically accept a workspace invitation: validates the token, links the
-- calling (just-signed-up) account to the workspace by creating a
-- workspace_members row, and marks the invitation accepted -- all in one
-- transaction. SECURITY DEFINER so it can write to the inviting owner's
-- workspace_members, which the calling user otherwise can't touch (via RLS).
-- Returns the workspace_id (owner_id) for confirmation.
CREATE OR REPLACE FUNCTION public.accept_workspace_invitation(p_token TEXT, p_display_name TEXT)
RETURNS UUID AS $$
DECLARE
    v_inv RECORD;
    v_uid UUID;
    v_email TEXT;
    v_owner_id UUID;
    v_member_id TEXT;
    v_initials TEXT;
BEGIN
    v_uid := auth.uid();
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Musíte být přihlášeni.';
    END IF;

    v_email := auth.jwt() ->> 'email';

    SELECT * INTO v_inv FROM public.invitations WHERE token = p_token FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pozvánka neexistuje.';
    END IF;
    IF v_inv.status <> 'pending' THEN
        RAISE EXCEPTION 'Pozvánka již byla použita nebo zrušena.';
    END IF;
    IF v_inv.expires_at < now() THEN
        UPDATE public.invitations SET status = 'expired' WHERE id = v_inv.id;
        RAISE EXCEPTION 'Platnost pozvánky vypršela.';
    END IF;
    IF v_email IS NULL OR lower(v_inv.email) <> lower(v_email) THEN
        RAISE EXCEPTION 'Pozvánka byla vystavena na jiný e-mail.';
    END IF;

    v_owner_id := v_inv.workspace_id;

    SELECT id INTO v_member_id FROM public.workspace_members
    WHERE owner_id = v_owner_id AND profile_id = v_uid;

    IF v_member_id IS NULL THEN
        v_member_id := 'member-' || replace(v_uid::text, '-', '') || '-' || substr(md5(random()::text), 1, 6);
        v_initials := upper(left(coalesce(NULLIF(trim(p_display_name), ''), v_email, 'U'), 1));

        INSERT INTO public.workspace_members (id, owner_id, profile_id, full_name, initials, avatar_color, email, workspace_role)
        VALUES (v_member_id, v_owner_id, v_uid, coalesce(NULLIF(trim(p_display_name), ''), v_email), v_initials, '#209dd7', v_email, 'member');
    END IF;

    UPDATE public.invitations
    SET status = 'accepted', accepted_at = now()
    WHERE id = v_inv.id;

    RETURN v_owner_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.accept_workspace_invitation(TEXT, TEXT) TO authenticated;

-- ============================================================
-- 17. Realtime (Team Collaboration v1.3, Fáze 6)
-- Publishes columns/cards/activity_logs to Supabase Realtime so
-- collaborators see each other's changes without a page refresh.
-- REPLICA IDENTITY FULL is needed so UPDATE/DELETE payloads carry the
-- full old row (e.g. which column a deleted card belonged to) -- the
-- default (primary key only) isn't enough for the client to merge
-- deletes/moves correctly.
-- ============================================================

ALTER TABLE public.columns REPLICA IDENTITY FULL;
ALTER TABLE public.cards REPLICA IDENTITY FULL;
ALTER TABLE public.activity_logs REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'columns'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.columns;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'cards'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.cards;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'activity_logs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
    END IF;
END $$;

