'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Search, Plus, Users, Mail, Copy, Ban, Check } from 'lucide-react';
import Navbar from '../../components/layout/Navbar';
import MembersTable from '../../components/team/MembersTable';
import MemberFormModal from '../../components/team/MemberFormModal';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { useAuth } from '../../hooks/useAuth';
import { TeamMember, WorkspaceRole, ProjectInvitation } from '../../types/kanban';
import { hasSupabaseConfig } from '../../lib/supabase';
import { collaborationService } from '../../services/collaborationService';
import Button from '../../components/ui/Button';

import UserDetailModal from '../../components/team/UserDetailModal';
import ResetPasswordModal from '../../components/team/ResetPasswordModal';

export default function TeamPage() {
  const { members, projectCounts, isLoading, ownerProfileId, addMember, editMember, deleteMember } = useWorkspaceMembers();
  const { user } = useAuth();

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const [detailMember, setDetailMember] = useState<TeamMember | null>(null);
  const [resetMember, setResetMember] = useState<TeamMember | null>(null);

  // Pozvání e-mailem (Team Collaboration v1.3) -- workspace-level
  const canInvite = Boolean(user?.id && hasSupabaseConfig);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'owner'>('member');
  const [isInviting, setIsInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!canInvite || !user?.id) return;
    collaborationService
      .fetchWorkspaceInvitations(user.id)
      .then((rows) => setInvitations(rows.filter((r) => r.status === 'pending')))
      .catch(() => setInvitations([]));
  }, [canInvite, user?.id]);

  const inviteLink = useCallback((token: string) => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/accept-invite?token=${token}`;
  }, []);

  const handleCopyLink = useCallback(async (invitationId: string, token: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(token));
      setCopiedId(invitationId);
      setTimeout(() => setCopiedId((current) => (current === invitationId ? null : current)), 2000);
    } catch {
      // Clipboard API may be unavailable
    }
  }, [inviteLink]);

  const handleSendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!user?.id) return;
    if (!email || !email.includes('@')) {
      setInviteError('Zadejte platný e-mail.');
      return;
    }
    setIsInviting(true);
    setInviteError(null);
    try {
      const inv = await collaborationService.createWorkspaceInvitation(user.id, email, inviteRole, user.id);
      setInvitations((prev) => [inv, ...prev]);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Pozvánku se nepodařilo vytvořit.');
    } finally {
      setIsInviting(false);
    }
  };

  const handleRevoke = async (invitationId: string) => {
    const ok = await collaborationService.rejectInvitation(invitationId);
    if (ok) {
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.fullName.toLowerCase().includes(q) ||
        (m.email && m.email.toLowerCase().includes(q)) ||
        (m.role && m.role.toLowerCase().includes(q))
    );
  }, [members, search]);

  const handleAdd = () => {
    setFormMode('add');
    setEditing(null);
    setFormOpen(true);
  };

  const handleEdit = (member: TeamMember) => {
    setFormMode('edit');
    setEditing(member);
    setFormOpen(true);
  };

  const handleSave = async (data: {
    fullName: string;
    email?: string;
    initials: string;
    avatarColor: string;
    role?: string;
    workspaceRole?: WorkspaceRole;
  }) => {
    if (formMode === 'edit' && editing) {
      await editMember({ ...editing, ...data });
    } else {
      await addMember(data);
    }
  };

  const handleDelete = async (member: TeamMember) => {
    if (confirm(`Odebrat ${member.fullName} z celého workspace? Bude odstraněn ze všech projektů i přiřazených úkolů.`)) {
      try {
        await deleteMember(member.id);
      } catch {
        alert('Nepodařilo se odstranit člena.');
      }
    }
  };

  const editingIsOwner = !!editing?.profileId && editing.profileId === ownerProfileId;

  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />

      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">WORKSPACE</span>
            <h1 className="hero-title">Tým</h1>
            <p className="hero-desc">Správa všech členů workspace — role, účty a přehled napříč projekty.</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>

      {canInvite && (
        <section
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            padding: '1.25rem',
            margin: '1rem auto',
            maxWidth: '1200px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--surface-2)',
          }}
          data-testid="workspace-invite-section"
        >
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--dark-navy)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <Mail size={14} />
            Pozvat člena e-mailem
          </span>

          <form onSubmit={handleSendInvite} style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              type="email"
              placeholder="kolega@firma.cz"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="cs-input"
              style={{ flex: 1, fontSize: '0.8rem' }}
              data-testid="workspace-invite-email-input"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'member' | 'owner')}
              className="cs-input"
              style={{ fontSize: '0.8rem', width: '110px' }}
              data-testid="workspace-invite-role-select"
            >
              <option value="member">Člen</option>
              <option value="owner">Vlastník</option>
            </select>
            <Button type="submit" variant="primary" size="sm" disabled={isInviting} data-testid="workspace-invite-send-btn">
              {isInviting ? 'Odesílám...' : 'Pozvat'}
            </Button>
          </form>

          {inviteError && (
            <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>{inviteError}</span>
          )}

          {invitations.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }} data-testid="workspace-pending-invitations-list">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    padding: '0.4rem 0.6rem',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--surface-1)',
                    fontSize: '0.75rem',
                  }}
                  data-testid={`pending-workspace-invitation-${inv.id}`}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dark-navy)', fontWeight: 600 }}>
                    {inv.email}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => handleCopyLink(inv.id, inv.token)}
                      title="Kopírovat odkaz na pozvánku"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)', display: 'flex' }}
                      data-testid={`copy-workspace-invite-link-${inv.id}`}
                    >
                      {copiedId === inv.id ? <Check size={14} color="#107c41" /> : <Copy size={14} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv.id)}
                      title="Zrušit pozvánku"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex' }}
                      data-testid={`revoke-workspace-invite-${inv.id}`}
                    >
                      <Ban size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <main className="team-main">
        <div className="team-toolbar">
          <div className="team-toolbar-title">
            <Users size={17} />
            <span>Všichni členové <strong>({members.length})</strong></span>
          </div>
          <div className="team-toolbar-actions">
            <div className="team-search">
              <Search size={15} />
              <input
                type="text"
                placeholder="Hledat člena…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="team-search"
              />
            </div>
            <button type="button" className="cs-btn cs-btn--primary" onClick={handleAdd} data-testid="team-add-member">
              <Plus size={15} />
              Přidat člena
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="team-empty">Načítání členů…</div>
        ) : filtered.length === 0 ? (
          <div className="team-empty">
            {members.length === 0 ? 'Workspace nemá žádné členy. Přidejte prvního!' : 'Žádní členové neodpovídají hledání.'}
          </div>
        ) : (
          <MembersTable
            members={filtered}
            projectCounts={projectCounts}
            ownerProfileId={ownerProfileId}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onViewDetail={(m) => setDetailMember(m)}
            onResetPassword={(m) => setResetMember(m)}
          />
        )}
      </main>

      <MemberFormModal
        isOpen={formOpen}
        mode={formMode}
        member={editing}
        isOwner={editingIsOwner}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
      />

      {detailMember && (
        <UserDetailModal
          isOpen={!!detailMember}
          onClose={() => setDetailMember(null)}
          member={detailMember}
        />
      )}

      {resetMember && (
        <ResetPasswordModal
          isOpen={!!resetMember}
          onClose={() => setResetMember(null)}
          member={resetMember}
        />
      )}
    </div>
  );
}
