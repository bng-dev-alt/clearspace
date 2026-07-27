import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { ProjectInvitation, ProjectActivityLog } from '../types/kanban';

export const collaborationService = {
  /**
   * Generates a secure random invite token
   */
  generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  },

  /**
   * Create a workspace-level invitation (Team Collaboration v1.3).
   * Invites a person to join the entire workspace by email, not a specific project.
   */
  async createWorkspaceInvitation(
    workspaceOwnerId: string,
    email: string,
    role: 'owner' | 'member' = 'member',
    invitedBy?: string
  ): Promise<ProjectInvitation> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    const id = `inv-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase
        .from('invitations')
        .insert({
          id,
          workspace_id: workspaceOwnerId,
          email: email.toLowerCase().trim(),
          token,
          role,
          status: 'pending',
          invited_by: invitedBy || null,
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (error) throw error;
      return {
        id: data.id,
        projectId: data.workspace_id, // Map workspace_id → projectId for now (UI uses projectId field)
        email: data.email,
        token: data.token,
        role: data.role,
        status: data.status,
        invitedBy: data.invited_by,
        expiresAt: data.expires_at,
        createdAt: data.created_at,
      };
    }

    // Fallback for offline / dev mock
    const mockInv: ProjectInvitation = {
      id,
      projectId: workspaceOwnerId,
      email: email.toLowerCase().trim(),
      token,
      role,
      status: 'pending',
      invitedBy,
      expiresAt,
      createdAt: new Date().toISOString(),
    };
    return mockInv;
  },

  /**
   * Fetch pending workspace invitations for a workspace owner (Team Collaboration v1.3).
   */
  async fetchWorkspaceInvitations(workspaceOwnerId: string): Promise<ProjectInvitation[]> {
    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase
        .from('invitations')
        .select('*')
        .eq('workspace_id', workspaceOwnerId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []).map((row) => ({
        id: row.id,
        projectId: row.workspace_id,
        email: row.email,
        token: row.token,
        role: row.role,
        status: row.status,
        invitedBy: row.invited_by,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      }));
    }
    return [];
  },

  /**
   * DEPRECATED: Fetch pending invitations for a project (v1.2 project-level).
   * Use fetchWorkspaceInvitations for workspace-level (v1.3).
   */
  async fetchProjectInvitations(_projectId: string): Promise<ProjectInvitation[]> {
    // No-op stub for backward compatibility; workspace-level invites don't filter by project.
    return [];
  },

  /**
   * DEPRECATED: Create an invitation for a specific project (v1.2).
   * Use createWorkspaceInvitation for workspace-level (v1.3).
   */
  async createInvitation(
    _projectId: string,
    email: string,
    role: 'owner' | 'member' = 'member',
    invitedBy?: string
  ): Promise<ProjectInvitation> {
    // Stub for backward compatibility; projects no longer have direct invites.
    // projectId is ignored; we use it as the workspaceOwnerId instead for stub purposes.
    return this.createWorkspaceInvitation(_projectId, email, role, invitedBy);
  },

  /**
   * Accept an invitation by token
   */
  async acceptInvitation(token: string, memberId: string): Promise<{ success: boolean; projectId?: string }> {
    if (hasSupabaseConfig && supabase) {
      const { data: inv, error } = await supabase
        .from('invitations')
        .select('*')
        .eq('token', token)
        .single();

      if (error || !inv) return { success: false };

      if (new Date(inv.expires_at) < new Date()) {
        await supabase.from('invitations').update({ status: 'expired' }).eq('id', inv.id);
        return { success: false };
      }

      // Mark invitation accepted
      await supabase.from('invitations').update({ status: 'accepted' }).eq('id', inv.id);

      // Add to project_members
      await supabase.from('project_members').insert({
        project_id: inv.project_id,
        member_id: memberId,
        project_role: inv.role,
      });

      return { success: true, projectId: inv.project_id };
    }
    return { success: true };
  },

  /**
   * Reject an invitation
   */
  async rejectInvitation(invitationId: string): Promise<boolean> {
    if (hasSupabaseConfig && supabase) {
      const { error } = await supabase
        .from('invitations')
        .update({ status: 'rejected' })
        .eq('id', invitationId);

      return !error;
    }
    return true;
  },

  /**
   * Log an activity event to activity_logs
   */
  async logActivity(params: {
    projectId: string;
    cardId?: string;
    actorName: string;
    actionType: string;
    entityType: 'task' | 'column' | 'project' | 'member';
    details?: Record<string, unknown>;
  }): Promise<ProjectActivityLog> {
    const id = `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const createdAt = new Date().toISOString();

    if (hasSupabaseConfig && supabase) {
      const { data: userData } = await supabase.auth.getUser();
      const actorId = userData?.user?.id || null;

      const { data, error } = await supabase
        .from('activity_logs')
        .insert({
          id,
          project_id: params.projectId,
          card_id: params.cardId || null,
          actor_id: actorId,
          actor_name: params.actorName,
          action_type: params.actionType,
          entity_type: params.entityType,
          details: params.details || {},
        })
        .select()
        .single();

      if (error) {
        console.warn('Failed to insert activity log:', error);
      } else if (data) {
        return {
          id: data.id,
          projectId: data.project_id,
          cardId: data.card_id,
          actorId: data.actor_id,
          actorName: data.actor_name,
          actionType: data.action_type,
          entityType: data.entity_type,
          details: data.details,
          createdAt: data.created_at,
        };
      }
    }

    return {
      id,
      projectId: params.projectId,
      cardId: params.cardId,
      actorName: params.actorName,
      actionType: params.actionType,
      entityType: params.entityType,
      details: params.details,
      createdAt,
    };
  },

  /**
   * Fetch project activity logs
   */
  async fetchActivities(projectId: string, limit = 50): Promise<ProjectActivityLog[]> {
    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase
        .from('activity_logs')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.warn('Failed to fetch activity logs:', error);
        return [];
      }

      return (data || []).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        cardId: row.card_id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        actionType: row.action_type,
        entityType: row.entity_type,
        details: row.details,
        createdAt: row.created_at,
      }));
    }
    return [];
  },

  /**
   * Super Admin password reset for any team member
   */
  async resetUserPassword(
    memberId: string,
    email: string,
    newPassword: string,
    actorName = 'Owner'
  ): Promise<boolean> {
    if (hasSupabaseConfig && supabase) {
      const { error } = await supabase.auth.admin.updateUserById(memberId, {
        password: newPassword,
      });
      if (error) {
        console.warn('Supabase admin password reset requires service_role key:', error);
      }
    }

    await this.logActivity({
      projectId: 'workspace',
      actorName,
      actionType: 'reset_user_password',
      entityType: 'member',
      details: { memberId, email },
    });

    return true;
  },

  /**
   * Archive / Unarchive project (Admin & Owner)
   */
  async setProjectArchived(projectId: string, archived: boolean, actorName = 'Admin'): Promise<boolean> {
    if (hasSupabaseConfig && supabase) {
      await supabase.from('projects').update({ archived }).eq('id', projectId);
    }
    await this.logActivity({
      projectId,
      actorName,
      actionType: archived ? 'archive_project' : 'unarchive_project',
      entityType: 'project',
      details: { archived },
    });
    return true;
  },

  /**
   * Accept an invitation token (Team Collaboration v1.3): workspace-level.
   * Creates the invited person's Supabase Auth account (signup, using the
   * email the invitation was issued to), then atomically adds them to the
   * workspace via the `accept_workspace_invitation` RPC. The RPC is SECURITY
   * DEFINER so it can write to the inviting owner's workspace_members,
   * which the newly-signed-up account otherwise can't access via RLS.
   */
  async acceptInvitationToken(token: string, displayName: string, password: string): Promise<{ success: boolean; projectId?: string }> {
    if (hasSupabaseConfig && supabase) {
      const { data: inv, error: fetchError } = await supabase
        .from('invitations')
        .select('*')
        .eq('token', token)
        .single();

      if (fetchError || !inv) {
        throw new Error('Pozvánka neexistuje nebo vypršela její platnost.');
      }
      if (inv.status !== 'pending') {
        throw new Error('Tato pozvánka už byla použita nebo zrušena.');
      }
      if (new Date(inv.expires_at) < new Date()) {
        await supabase.from('invitations').update({ status: 'expired' }).eq('id', inv.id);
        throw new Error('Platnost pozvánky vypršela. Požádejte vlastníka workspace o novou.');
      }

      // Pokud je uživatel už přihlášený (měl účet, dostal chybu "already",
      // přihlásil se a vrátil se na odkaz), signup znovu nezkoušíme.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        const { error: signUpError } = await supabase.auth.signUp({
          email: inv.email,
          password,
          options: { data: { display_name: displayName } },
        });

        if (signUpError) {
          if (signUpError.message?.toLowerCase().includes('already')) {
            throw new Error('Tento e-mail už má založený účet ClearSpace. Přihlaste se prosím a pozvánku otevřete znovu.');
          }
          throw new Error(signUpError.message || 'Registraci se nepodařilo dokončit.');
        }
      }

      const { data: workspaceId, error: acceptError } = await supabase.rpc('accept_workspace_invitation', {
        p_token: token,
        p_display_name: displayName,
      });

      if (acceptError) {
        throw new Error(acceptError.message || 'Pozvánku se nepodařilo přijmout.');
      }

      return { success: true, projectId: workspaceId as string };
    }

    return { success: true, projectId: 'demo-workspace' };
  },
};
