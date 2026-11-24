import { supabase, hasSupabaseConfig } from '../lib/supabase';
import type {
  AppNotification,
  NotificationType,
  ProjectActivityLog,
  ProjectInvitation,
  ProjectRole,
  ProjectRosterEntry,
} from '../types/kanban';
import type { DbWorkspaceMemberLite } from './boardMapping';

/**
 * Collaboration seam (RUN 01). Authorization, events and notifications are decided by the
 * database (migration 20261124001000): this module only calls it. In demo mode (no Supabase)
 * collaboration is a single-user no-op and every function degrades gracefully.
 */

interface DbActivityRow {
  id: string;
  project_id: string;
  card_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action_type: string;
  entity_type: string;
  entity_id?: string | null;
  source?: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export function mapActivityRow(row: DbActivityRow): ProjectActivityLog {
  return {
    id: row.id,
    projectId: row.project_id,
    cardId: row.card_id ?? undefined,
    actorId: row.actor_id ?? undefined,
    actorName: row.actor_name,
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id ?? undefined,
    source: row.source ?? undefined,
    details: row.details ?? undefined,
    createdAt: row.created_at,
  };
}

interface DbNotificationRow {
  id: string;
  type: NotificationType;
  project_id: string | null;
  card_id: string | null;
  entity_id: string | null;
  actor_name: string;
  title: string;
  read_at: string | null;
  created_at: string;
}

export function mapNotificationRow(row: DbNotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type,
    projectId: row.project_id ?? undefined,
    cardId: row.card_id ?? undefined,
    entityId: row.entity_id ?? undefined,
    actorName: row.actor_name,
    title: row.title,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
  };
}

function rpcError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message || fallback);
}

const INVITATION_COLUMNS = 'id, workspace_id, email, role, status, invited_by, expires_at, accepted_at, created_at, project_id, project_role';

interface DbInvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: 'owner' | 'member';
  status: ProjectInvitation['status'];
  invited_by: string | null;
  expires_at: string;
  created_at: string;
  project_id?: string | null;
  project_role?: ProjectInvitation['projectRole'] | null;
}

function mapInvitationRow(row: DbInvitationRow): ProjectInvitation {
  return {
    id: row.id,
    projectId: row.workspace_id,
    email: row.email,
    token: '', // the link is shown only once, at creation; the database keeps just its hash
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    targetProjectId: row.project_id ?? undefined,
    projectRole: row.project_role ?? undefined,
  };
}

export const collaborationService = {
  /**
   * 256-bit token (64 hex chars) from the Web Crypto CSPRNG. Used ONLY by the
   * demo (localStorage) mode; with Supabase the database generates the token
   * and stores just its SHA-256 (create_*_invitation RPCs).
   */
  generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },

  /** Workspace-level invitation (Team page). */
  async createWorkspaceInvitation(
    workspaceOwnerId: string,
    email: string,
    _role: 'owner' | 'member' = 'member',
    invitedBy?: string
  ): Promise<ProjectInvitation> {
    const normalizedEmail = email.toLowerCase().trim();

    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase.rpc('create_workspace_invitation', {
        p_email: normalizedEmail,
        p_role: 'member',
      });
      if (error) throw rpcError(error, 'Pozvánku se nepodařilo vytvořit.');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('Pozvánku se nepodařilo vytvořit.');
      return {
        id: row.id,
        projectId: workspaceOwnerId,
        email: normalizedEmail,
        token: row.token,
        role: 'member',
        status: 'pending',
        invitedBy,
        expiresAt: row.expires_at,
        createdAt: new Date().toISOString(),
      };
    }

    return {
      id: `inv-${this.generateToken().slice(0, 16)}`,
      projectId: workspaceOwnerId,
      email: normalizedEmail,
      token: this.generateToken(),
      role: 'member',
      status: 'pending',
      invitedBy,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
  },

  /** Project invitation: on acceptance the invitee joins the project with `role`. Owner/admin only. */
  async createProjectInvitation(
    projectId: string,
    email: string,
    role: Exclude<ProjectRole, 'owner'>
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    if (!hasSupabaseConfig) throw new Error('Pozvánky vyžadují připojenou databázi.');
    const { data, error } = await supabase.rpc('create_project_invitation', {
      p_project_id: projectId,
      p_email: email.toLowerCase().trim(),
      p_role: role,
    });
    if (error) throw rpcError(error, 'Pozvánku se nepodařilo vytvořit.');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('Pozvánku se nepodařilo vytvořit.');
    return { id: row.id, token: row.token, expiresAt: row.expires_at };
  },

  async fetchWorkspaceInvitations(workspaceOwnerId: string): Promise<ProjectInvitation[]> {
    if (!hasSupabaseConfig) return [];
    const { data, error } = await supabase
      .from('invitations')
      .select(INVITATION_COLUMNS)
      .eq('workspace_id', workspaceOwnerId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return ((data ?? []) as DbInvitationRow[]).map(mapInvitationRow);
  },

  async fetchProjectInvitations(projectId: string): Promise<ProjectInvitation[]> {
    if (!hasSupabaseConfig) return [];
    const { data, error } = await supabase
      .from('invitations')
      .select(INVITATION_COLUMNS)
      .eq('project_id', projectId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) return [];
    return ((data ?? []) as DbInvitationRow[]).map(mapInvitationRow);
  },

  /** Revoke a pending invitation (workspace owner, or owner/admin of the invitation's project). */
  async rejectInvitation(invitationId: string): Promise<boolean> {
    if (!hasSupabaseConfig) return true;
    const { error } = await supabase.rpc('revoke_invitation', { p_invitation_id: invitationId });
    return !error;
  },

  async fetchActivities(projectId: string, limit = 50): Promise<ProjectActivityLog[]> {
    if (!hasSupabaseConfig) return [];
    const { data, error } = await supabase
      .from('activity_logs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('Failed to fetch activity logs:', error.message);
      return [];
    }
    return ((data ?? []) as DbActivityRow[]).map(mapActivityRow);
  },

  // --- Membership & roles ---

  /** The caller's role on a project (null = no access). Demo mode: the single local user owns everything. */
  async fetchMyRole(projectId: string): Promise<ProjectRole | null> {
    if (!hasSupabaseConfig) return 'owner';
    const { data, error } = await supabase.rpc('project_role', { p_project_id: projectId });
    if (error) throw rpcError(error, 'Roli v projektu se nepodařilo zjistit.');
    return (data as ProjectRole | null) ?? null;
  },

  /** Project roster with roles. Readable by every project member (RLS). */
  async fetchRoster(projectId: string): Promise<ProjectRosterEntry[]> {
    if (!hasSupabaseConfig) return [];
    const [{ data, error }, { data: project }] = await Promise.all([
      supabase
        .from('project_members')
        .select('project_role, created_at, member:workspace_members(id, full_name, initials, avatar_color, email, profile_id, workspace_role, created_at)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true }),
      supabase.from('projects').select('user_id').eq('id', projectId).maybeSingle(),
    ]);
    if (error) throw error;
    const ownerId = (project as { user_id?: string } | null)?.user_id;
    return ((data ?? []) as unknown as { project_role: ProjectRole; member: DbWorkspaceMemberLite | null }[])
      .filter((r) => r.member)
      .map((r) => {
        const m = r.member!;
        const isOwner = Boolean(ownerId && m.profile_id === ownerId);
        return {
          role: isOwner ? 'owner' : r.project_role === 'owner' ? 'member' : r.project_role,
          member: {
            id: m.id,
            fullName: m.full_name,
            initials: m.initials,
            avatarColor: m.avatar_color,
            email: m.email ?? undefined,
            profileId: m.profile_id ?? undefined,
            workspaceRole: m.workspace_role ?? 'member',
            createdAt: m.created_at,
          },
        };
      });
  },

  async setMemberRole(projectId: string, memberId: string, role: Exclude<ProjectRole, 'owner'>): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.rpc('set_project_member', { p_project_id: projectId, p_member_id: memberId, p_role: role });
    if (error) throw rpcError(error, 'Roli se nepodařilo změnit.');
  },

  async removeMember(projectId: string, memberId: string): Promise<void> {
    if (!hasSupabaseConfig) return;
    const { error } = await supabase.rpc('remove_project_member', { p_project_id: projectId, p_member_id: memberId });
    if (error) throw rpcError(error, 'Člena se nepodařilo odebrat.');
  },

  // --- Notifications ---

  async fetchNotifications(limit = 30): Promise<AppNotification[]> {
    if (!hasSupabaseConfig) return [];
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, project_id, card_id, entity_id, actor_name, title, read_at, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return ((data ?? []) as DbNotificationRow[]).map(mapNotificationRow);
  },

  async markNotificationsRead(ids: string[]): Promise<void> {
    if (!hasSupabaseConfig || ids.length === 0) return;
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids).is('read_at', null);
  },

  async markAllNotificationsRead(): Promise<void> {
    if (!hasSupabaseConfig) return;
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
  },

  /** In-app acceptance of a project invitation addressed to the signed-in account's verified e-mail. */
  async acceptInvitationById(invitationId: string): Promise<string | null> {
    if (!hasSupabaseConfig) return null;
    const { data, error } = await supabase.rpc('accept_invitation_by_id', { p_invitation_id: invitationId });
    if (error) throw rpcError(error, 'Pozvánku se nepodařilo přijmout.');
    return (data as string | null) ?? null;
  },

  /**
   * Anonymní náhled pozvánky (RPC invitation_preview): vrací jen to, co pozvaný
   * potřebuje vidět před registrací -- stav, maskovaný e-mail a jméno zvoucího.
   */
  async previewInvitation(token: string): Promise<{
    state: 'valid' | 'expired' | 'used' | 'invalid';
    maskedEmail?: string;
    inviterName?: string;
  }> {
    if (!hasSupabaseConfig || !supabase) return { state: 'invalid' };
    const { data, error } = await supabase.rpc('invitation_preview', { p_token: token });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) return { state: 'invalid' };
    return {
      state: row.state,
      maskedEmail: row.masked_email ?? undefined,
      inviterName: row.inviter_name ?? undefined,
    };
  },

  /**
   * Přijetí pozvánky odkazem. Databázová funkce accept_workspace_invitation (SECURITY DEFINER)
   * ověří token, expiraci, jedno použití a že VERIFIKOVANÝ e-mail účtu odpovídá pozvánce;
   * projektová pozvánka zároveň přidá účet do projektu s pozvanou rolí.
   */
  async acceptInvitationToken(
    token: string,
    email: string,
    displayName: string,
    password: string
  ): Promise<{ success: boolean; needsEmailConfirmation?: boolean }> {
    if (!hasSupabaseConfig || !supabase) {
      return { success: true };
    }

    const { data: sessionData } = await supabase.auth.getSession();
    let hasSession = Boolean(sessionData.session);

    if (!hasSession) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { display_name: displayName },
          emailRedirectTo: `${window.location.origin}/accept-invite?token=${encodeURIComponent(token)}`,
        },
      });
      if (signUpError) {
        if (signUpError.message?.toLowerCase().includes('already')) {
          throw new Error('Tento e-mail už má založený účet ClearSpace. Přihlaste se prosím a pozvánku otevřete znovu.');
        }
        throw new Error(signUpError.message || 'Registraci se nepodařilo dokončit.');
      }
      hasSession = Boolean(signUpData.session);
      if (!hasSession) return { success: false, needsEmailConfirmation: true };
    }

    return this.acceptInvitationAsSignedInUser(token, displayName);
  },

  async acceptInvitationAsSignedInUser(token: string, displayName: string): Promise<{ success: boolean }> {
    if (!hasSupabaseConfig || !supabase) return { success: true };
    const { error } = await supabase.rpc('accept_workspace_invitation', {
      p_token: token,
      p_display_name: displayName,
    });
    if (error) throw new Error(error.message || 'Pozvánku se nepodařilo přijmout.');
    return { success: true };
  },
};
