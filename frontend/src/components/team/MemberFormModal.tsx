'use client';

import React, { useState, useEffect } from 'react';
import { DialogFocus } from '../ui/useDialogFocus';
import { X, Check } from 'lucide-react';
import { TeamMember, WorkspaceRole } from '../../types/kanban';
import { deriveInitials } from '../../services/workspaceService';

interface MemberFormModalProps {
  isOpen: boolean;
  mode: 'add' | 'edit';
  member: TeamMember | null;
  /** Owner účet -> role je pevně 'owner' a needituje se. */
  isOwner: boolean;
  onClose: () => void;
  onSave: (data: {
    fullName: string;
    email?: string;
    initials: string;
    avatarColor: string;
    role?: string;
    workspaceRole?: WorkspaceRole;
  }) => Promise<void>;
}

const PRESET_COLORS = ['#0f9d6e', '#6366f1', '#e0a80a', '#38bdf8', '#f43f5e', '#f97316'];

export default function MemberFormModal({ isOpen, mode, member, isOwner, onClose, onSave }: MemberFormModalProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [initials, setInitials] = useState('');
  const [avatarColor, setAvatarColor] = useState(PRESET_COLORS[0]);
  const [title, setTitle] = useState('');
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>('member');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Naplnit / vyresetovat formulář při otevření (sync props -> lokální stav formuláře)
  useEffect(() => {
    if (!isOpen) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (mode === 'edit' && member) {
      setFullName(member.fullName);
      setEmail(member.email || '');
      setInitials(member.initials);
      setAvatarColor(member.avatarColor);
      setTitle(member.role || '');
      setWorkspaceRole(member.workspaceRole || 'member');
    } else {
      setFullName('');
      setEmail('');
      setInitials('');
      setAvatarColor(PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)]);
      setTitle('');
      setWorkspaceRole('member');
    }
    setError('');
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isOpen, mode, member]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleNameChange = (val: string) => {
    setFullName(val);
    if (error) setError('');
    setInitials(val.trim() ? deriveInitials(val) : '');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = fullName.trim();
    const cleanInitials = initials.trim().toUpperCase();
    if (!name) return setError('Celé jméno je povinné');
    if (!cleanInitials) return setError('Iniciály jsou povinné');

    setSaving(true);
    try {
      await onSave({
        fullName: name,
        email: email.trim() || undefined,
        initials: cleanInitials,
        avatarColor,
        role: title.trim() || undefined,
        workspaceRole: isOwner ? 'owner' : workspaceRole,
      });
      onClose();
    } catch (err) {
      console.error(err);
      setError('Nepodařilo se uložit člena.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} data-testid="member-form-overlay">
      <div
        className="modal-content"
        style={{ maxWidth: '480px', width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="member-form-modal"
      >
        <DialogFocus />
        <div className="modal-header">
          <h2 className="modal-title">{mode === 'add' ? 'Přidat člena' : 'Upravit člena'}</h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Zavřít okno">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {error && (
              <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600 }}>
                {error}
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Celé jméno *</label>
              <input type="text" className="form-input" placeholder="např. Sarah Chen" value={fullName} onChange={(e) => handleNameChange(e.target.value)} autoFocus data-testid="member-name-input" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">E-mail</label>
                <input type="email" className="form-input" placeholder="jmeno@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Pozice / titul</label>
                <input type="text" className="form-input" placeholder="např. Frontend Developer" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Iniciály *</label>
                <input type="text" className="form-input" maxLength={2} placeholder="SC" value={initials} onChange={(e) => setInitials(e.target.value.toUpperCase())} />
              </div>
              <div className="form-group">
                <label className="form-label">Barva avataru</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', height: '38px' }}>
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setAvatarColor(c)}
                      style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: c, border: avatarColor === c ? '2px solid var(--text)' : '2px solid transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                    >
                      {avatarColor === c && <Check size={12} style={{ color: '#ffffff' }} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Role ve workspace</label>
              {isOwner ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '0.4rem 0' }}>
                  Vlastník účtu (Owner) — role se nemění.
                </div>
              ) : (
                <select className="form-input" value={workspaceRole} onChange={(e) => setWorkspaceRole(e.target.value as WorkspaceRole)}>
                  <option value="member">Member (Člen týmu)</option>
                  <option value="admin">Admin (Správce)</option>
                  <option value="viewer">Viewer (Čtenář)</option>
                  <option value="owner">Owner (Vlastník)</option>
                </select>
              )}
            </div>
          </div>

          <div className="modal-footer" style={{ marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-cancel" onClick={onClose}>Zrušit</button>
            <button type="submit" className="btn btn-submit" disabled={saving} data-testid="member-form-submit">
              {saving ? 'Ukládám…' : 'Uložit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
