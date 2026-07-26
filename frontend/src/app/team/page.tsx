'use client';

import React, { useState, useMemo } from 'react';
import { Search, Plus, Users } from 'lucide-react';
import Navbar from '../../components/layout/Navbar';
import MembersTable from '../../components/team/MembersTable';
import MemberFormModal from '../../components/team/MemberFormModal';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { TeamMember, WorkspaceRole } from '../../types/kanban';

import UserDetailModal from '../../components/team/UserDetailModal';
import ResetPasswordModal from '../../components/team/ResetPasswordModal';

export default function TeamPage() {
  const { members, projectCounts, isLoading, ownerProfileId, addMember, editMember, deleteMember } = useWorkspaceMembers();

  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add');
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const [detailMember, setDetailMember] = useState<TeamMember | null>(null);
  const [resetMember, setResetMember] = useState<TeamMember | null>(null);

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
