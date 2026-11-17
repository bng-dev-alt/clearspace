import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { ProjectInvitation, ProjectActivityLog } from '../types/kanban';

export const collaborationService = {
  /**
   * 256-bit token (64 hex chars) from the Web Crypto CSPRNG. Used ONLY by the
   * demo (localStorage) mode; with Supabase the database generates the token
   * and stores just its SHA-256 (create_workspace_invitation RPC).
   */
  generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Create a workspace-level invitation (Team Collaboration v1.3).
   * Invites a person to join the entire workspace by email, not a specific project.
   */
  async createWorkspaceInvitation(
    workspaceOwnerId: string,
    email: string,
    _role: 'owner' | 'member' = 'member',
    invitedBy?: string
  ): Promise<ProjectInvitation> {
    const normalizedEmail = email.toLowerCase().trim();

    if (hasSupabaseConfig && supabase) {
      // Token, expirace i role určuje databáze; token se vrací JEDNOU (v DB je jen jeho hash).
      const { data, error } = await supabase.rpc('create_workspace_invitation', {
        p_email: normalizedEmail,
        p_role: 'member',
      });
      if (error) throw new Error(error.message || 'Pozvánku se nepodařilo vytvořit.');
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

    // Demo režim (bez databáze)
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

  /**
   * Fetch pending workspace invitations for a workspace owner (Team Collaboration v1.3).
   */
  async fetchWorkspaceInvitations(workspaceOwnerId: string): Promise<ProjectInvitation[]> {
    if (hasSupabaseConfig && supabase) {
      const { data, error } = await supabase
        .from('invitations')
        // Explicitní sloupce: token_hash klient číst nesmí (sloupcová oprávnění).
        .select('id, workspace_id, email, role, status, invited_by, expires_at, accepted_at, created_at')
        .eq('workspace_id', workspaceOwnerId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []).map((row) => ({
        id: row.id,
        projectId: row.workspace_id,
        email: row.email,
        token: '', // odkaz se zobrazí jen při vytvoření; v DB zůstává pouze hash
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
   * Přijetí pozvánky (workspace-level). Databázová funkce
   * accept_workspace_invitation (SECURITY DEFINER) ověří token, expiraci,
   * jedno použití a že VERIFIKOVANÝ e-mail účtu odpovídá pozvánce.
   *
   * - Přihlášený uživatel: rovnou zavolá RPC.
   * - Nepřihlášený: založí účet s e-mailem, který zadal. Pokud projekt vyžaduje
   *   potvrzení e-mailu, session vznikne až po potvrzení -- vrací se
   *   `needsEmailConfirmation` a pozvánku pak uživatel přijme na stejném odkazu.
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
