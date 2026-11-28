'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfirm } from '../ui/useConfirm';
import { isTopDialog, useDialogFocus } from '../ui/useDialogFocus';
import { X, Users, Mail, Copy, Check, Trash2, UserPlus, Settings2 } from 'lucide-react';
import type { ProjectRole, ProjectRosterEntry, TeamMember } from '../../types/kanban';
import { collaborationService, type InvitationRow, type DeliveryState } from '../../services/collaborationService';
import { workspaceService } from '../../services/workspaceService';
import { Button, Badge, EmptyState } from '../ui';

type AssignableRole = Exclude<ProjectRole, 'owner'>;

export const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: 'Vlastník',
  admin: 'Správce',
  member: 'Editor',
  viewer: 'Čtenář',
};

const ROLE_HINT: Record<AssignableRole, string> = {
  admin: 'upravuje projekt a spravuje členy',
  member: 'upravuje úkoly, komentuje',
  viewer: 'jen čte',
};

interface ProjectTeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectOwnerId?: string;
  myRole: ProjectRole | null;
  myUserId?: string;
  roster: ProjectRosterEntry[];
  /** Re-read roster + role after a change (realtime also delivers it). */
  onChanged: () => void;
  onManageWorkspace: () => void;
}

type InvitationState = 'pending' | 'expired' | 'accepted' | 'revoked';
const STATE_LABEL: Record<InvitationState, string> = { pending: 'čeká na přijetí', expired: 'vypršela', accepted: 'přijata', revoked: 'zrušena' };

function invitationState(inv: InvitationRow): InvitationState {
  if (inv.status === 'accepted') return 'accepted';
  if (inv.status === 'rejected') return 'revoked';
  if (inv.status === 'expired' || new Date(inv.expiresAt).getTime() < Date.now()) return 'expired';
  return 'pending';
}

/** Only what is actually known: SMTP acceptance is not inbox delivery. */
const UNCERTAIN = 'Server nepotvrdil převzetí e-mailu, mohl ale odejít. Než pošlete znovu, ověřte u příjemce, zda pozvánka nedorazila.';

function deliveryLabel(status?: DeliveryState, errorCode?: string): string {
  if (status === 'failed' && errorCode === 'smtp_ambiguous') return UNCERTAIN;
  switch (status) {
    case 'accepted': return 'E-mail předán poštovnímu serveru (doručení do schránky nelze ověřit).';
    case 'failed': return 'Odeslání e-mailu selhalo. Zkuste „Poslat znovu“ nebo předejte odkaz jinak.';
    case 'suppressed': return 'E-mail se neodesílá (testovací adresa nebo vypnuté odesílání). Předejte odkaz jinak.';
    case 'sending': return 'E-mail se odesílá…';
    default: return 'E-mail nebyl odeslán; předejte odkaz jinak.';
  }
}

function deliveryMessage(status: DeliveryState, email: string, errorCode?: string): string {
  if (status === 'failed' && errorCode === 'smtp_ambiguous') return `Pozvánka je vytvořená. ${UNCERTAIN}`;
  switch (status) {
    case 'accepted': return `Pozvánka odeslána na ${email}.`;
    case 'failed': return `Pozvánka je vytvořená, ale e-mail na ${email} se nepodařilo odeslat. Odkaz můžete zkopírovat.`;
    case 'not_configured': return 'Pozvánka je vytvořená. Odesílání e-mailů není nastavené, odkaz prosím předejte sami.';
    default: return `Pozvánka je vytvořená, e-mail na ${email} se neodesílá (testovací adresa). Odkaz můžete zkopírovat.`;
  }
}

/** Roles a manager may hand out: the owner everything below owner, an admin only editor/viewer. */
function grantable(myRole: ProjectRole | null): AssignableRole[] {
  if (myRole === 'owner') return ['admin', 'member', 'viewer'];
  if (myRole === 'admin') return ['member', 'viewer'];
  return [];
}

/**
 * Project members, roles and invitations (RUN 01). Every action is an RPC the database authorizes
 * (owner/admin, no escalation); the UI only hides what the caller could not do anyway.
 */
export default function ProjectTeamModal({
  isOpen, onClose, projectId, projectOwnerId, myRole, myUserId, roster, onChanged, onManageWorkspace,
}: ProjectTeamModalProps) {
  const [ask, confirmDialog] = useConfirm();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, isOpen);
  const canManage = myRole === 'owner' || myRole === 'admin';
  const roles = grantable(myRole);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TeamMember[]>([]);
  const [addMemberId, setAddMemberId] = useState('');
  const [addRole, setAddRole] = useState<AssignableRole>('member');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('member');
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [freshLink, setFreshLink] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen && isTopDialog(dialogRef.current)) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const loadManagerData = useCallback(async () => {
    if (!canManage) return;
    const [ws, inv] = await Promise.all([
      projectOwnerId ? workspaceService.fetchMembers(projectOwnerId).catch(() => []) : Promise.resolve([]),
      collaborationService.fetchProjectInvitationList(projectId),
    ]);
    setCandidates(ws);
    setInvitations(inv);
  }, [canManage, projectOwnerId, projectId]);

  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadManagerData();
  }, [isOpen, loadManagerData]);

  const inProject = useMemo(() => new Set(roster.map((r) => r.member.id)), [roster]);
  const addable = candidates.filter((m) => !inProject.has(m.id));

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setInfo(null);
    try {
      await fn();
      onChanged();
      await loadManagerData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Akci se nepodařilo provést.');
    } finally {
      setBusy(null);
    }
  };

  const canEditEntry = (entry: ProjectRosterEntry) =>
    canManage
    && entry.role !== 'owner'
    && entry.member.profileId !== myUserId
    && !(myRole === 'admin' && entry.role === 'admin');

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    void run('invite', async () => {
      const r = await collaborationService.sendProjectInvitation(projectId, email, inviteRole);
      setFreshLink({ id: r.id, url: r.link });
      setCopied(false);
      setInviteEmail('');
      setInfo(deliveryMessage(r.delivery.status, email, r.delivery.errorCode));
    });
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose} data-testid="project-team-overlay">
      {confirmDialog}
      <div
        className="modal-content"
        style={{ maxWidth: '560px', width: '100%' }}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-team-title"
        data-testid="project-team-modal"
      >
        <div className="modal-header">
          <h2 id="project-team-title" className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={18} />
            Členové projektu
          </h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Zavřít okno" data-testid="project-team-close-btn">
            <X size={20} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--danger)', fontWeight: 600 }} data-testid="project-team-error">
              {error}
            </p>
          )}

          {info && (
            <p role="status" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--dark-navy)' }} data-testid="project-team-info">{info}</p>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }} data-testid="project-team-list">
            {roster.length === 0 && (
              <li><EmptyState icon={<Users size={20} />} title="Zatím jen vy" description="Pozvěte kolegy e-mailem níže." /></li>
            )}
            {roster.map((entry) => {
              const m = entry.member;
              const editable = canEditEntry(entry);
              return (
                <li
                  key={m.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius)', border: '1px solid var(--border)', backgroundColor: 'var(--surface-2)' }}
                  data-testid={`project-team-member-${m.id}`}
                  data-role={entry.role}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0 }}>
                    <span aria-hidden style={{ width: '30px', height: '30px', borderRadius: '50%', backgroundColor: m.avatarColor, color: '#fff', fontWeight: 700, fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {m.initials}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: '0.83rem', fontWeight: 700, color: 'var(--dark-navy)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.fullName}{m.profileId && m.profileId === myUserId ? ' (vy)' : ''}
                      </span>
                      <span style={{ fontSize: '0.68rem', color: 'var(--gray-text)' }}>
                        {m.email || ''}{!m.profileId ? ' · bez účtu' : ''}
                      </span>
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexShrink: 0 }}>
                    {editable ? (
                      <>
                        <select
                          className="form-input"
                          style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem', width: 'auto' }}
                          value={entry.role}
                          aria-label={`Role: ${m.fullName}`}
                          disabled={busy !== null}
                          onChange={(e) => void run(`role-${m.id}`, () => collaborationService.setMemberRole(projectId, m.id, e.target.value as AssignableRole))}
                          data-testid={`project-team-role-${m.id}`}
                        >
                          {(roles.includes(entry.role as AssignableRole) ? roles : [entry.role as AssignableRole, ...roles]).map((r) => (
                            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="modal-close-btn"
                          aria-label={`Odebrat ${m.fullName} z projektu`}
                          title="Odebrat z projektu"
                          disabled={busy !== null}
                          onClick={async () => {
                            if (await ask({ title: `Odebrat ${m.fullName} z projektu?`, message: 'Ztratí přístup k projektu okamžitě. Jeho úkoly a komentáře zůstanou.', confirmLabel: 'Odebrat z projektu', danger: true })) {
                              void run(`remove-${m.id}`, () => collaborationService.removeMember(projectId, m.id));
                            }
                          }}
                          data-testid={`project-team-remove-${m.id}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    ) : (
                      <Badge variant={entry.role === 'owner' ? 'accent' : 'default'}>{ROLE_LABEL[entry.role]}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {canManage && addable.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-text)' }}>Přidat z workspace</span>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <select className="form-input" style={{ flex: '1 1 180px', fontSize: '0.8rem' }} value={addMemberId} onChange={(e) => setAddMemberId(e.target.value)} aria-label="Člen workspace" data-testid="project-team-add-select">
                  <option value="">Vyberte člena…</option>
                  {addable.map((m) => (
                    <option key={m.id} value={m.id}>{m.fullName}{m.profileId ? '' : ' (bez účtu)'}</option>
                  ))}
                </select>
                <select className="form-input" style={{ flex: '0 0 auto', width: 'auto', fontSize: '0.8rem' }} value={addRole} onChange={(e) => setAddRole(e.target.value as AssignableRole)} aria-label="Role" data-testid="project-team-add-role">
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!addMemberId || busy !== null}
                  onClick={() => void run('add', async () => { await collaborationService.setMemberRole(projectId, addMemberId, addRole); setAddMemberId(''); })}
                  data-testid="project-team-add-btn"
                >
                  <UserPlus size={13} /> Přidat
                </Button>
              </div>
            </div>
          )}

          {canManage && (
            <form onSubmit={handleInvite} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }} data-testid="project-invite-form">
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-text)' }}>Pozvat e-mailem</span>
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <input
                  type="email"
                  required
                  className="cs-input"
                  placeholder="kolega@firma.cz"
                  style={{ flex: '1 1 180px', fontSize: '0.8rem' }}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  aria-label="E-mail pozvaného"
                  data-testid="project-invite-email"
                />
                <select className="form-input" style={{ flex: '0 0 auto', width: 'auto', fontSize: '0.8rem' }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AssignableRole)} aria-label="Role pozvaného" data-testid="project-invite-role">
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <Button type="submit" variant="primary" size="sm" disabled={busy !== null} data-testid="project-invite-send">
                  <Mail size={13} /> Pozvat
                </Button>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'var(--gray-text)' }}>{ROLE_LABEL[inviteRole]}: {ROLE_HINT[inviteRole]}. Pozvánku pošleme e-mailem; odkaz platí 7 dní a jen pro tento e-mail.</span>
              {freshLink && (
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }} data-testid="project-invite-link-box">
                  <input readOnly className="cs-input" style={{ fontSize: '0.72rem' }} value={freshLink.url} aria-label="Odkaz pozvánky" data-testid="project-invite-link" onFocus={(e) => e.currentTarget.select()} />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => { try { await navigator.clipboard.writeText(freshLink.url); setCopied(true); } catch { /* clipboard blocked: the field is selectable */ } }}
                    data-testid="project-invite-copy"
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Zkopírováno' : 'Kopírovat'}
                  </Button>
                </div>
              )}
            </form>
          )}

          {canManage && invitations.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }} data-testid="project-invite-pending">
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--gray-text)' }}>Pozvánky</span>
              {invitations.map((inv) => {
                const st = invitationState(inv);
                const live = st === 'pending' || st === 'expired';
                return (
                  <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', fontSize: '0.76rem', flexWrap: 'wrap' }}
                    data-testid={`project-invite-${inv.id}`} data-state={st} data-delivery={inv.delivery?.status ?? 'none'}>
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 200px' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {inv.email} · {ROLE_LABEL[inv.projectRole ?? 'member']} · <strong>{STATE_LABEL[st]}</strong>
                        {st === 'pending' ? ` do ${new Date(inv.expiresAt).toLocaleDateString('cs-CZ')}` : ''}
                      </span>
                      {live && <span style={{ color: inv.delivery?.status === 'failed' ? 'var(--danger)' : 'var(--gray-text)', fontSize: '0.7rem' }}>{deliveryLabel(inv.delivery?.status, inv.delivery?.errorCode)}</span>}
                    </span>
                    {live && (
                      <span style={{ display: 'flex', gap: '0.6rem' }}>
                        {freshLink?.id === inv.id && (
                          <button type="button" className="cs-link-button" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}
                            onClick={async () => { try { await navigator.clipboard.writeText(freshLink.url); setCopied(true); } catch { /* clipboard blocked */ } }}
                            data-testid={`project-invite-copy-${inv.id}`}>
                            {copied ? 'Zkopírováno' : 'Kopírovat odkaz'}
                          </button>
                        )}
                        <button type="button" className="cs-link-button" style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}
                          disabled={busy !== null}
                          onClick={() => void run(`resend-${inv.id}`, async () => {
                            const r = await collaborationService.resendInvitation(inv.id);
                            setFreshLink({ id: r.id, url: r.link }); setCopied(false);
                            setInfo(deliveryMessage(r.delivery.status, inv.email, r.delivery.errorCode));
                          })}
                          data-testid={`project-invite-resend-${inv.id}`}>
                          {busy === `resend-${inv.id}` ? 'Odesílám…' : 'Poslat znovu'}
                        </button>
                        {st === 'pending' && (
                          <button type="button" className="cs-link-button" style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}
                            disabled={busy !== null}
                            onClick={() => void run(`revoke-${inv.id}`, async () => { await collaborationService.rejectInvitation(inv.id); if (freshLink?.id === inv.id) setFreshLink(null); })}
                            data-testid={`project-invite-revoke-${inv.id}`}>
                            Zrušit
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!canManage && (
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--gray-text)' }}>
              Členy a role spravuje vlastník nebo správce projektu.
            </p>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between' }}>
          {myRole === 'owner' ? (
            <Button type="button" variant="ghost" size="sm" onClick={onManageWorkspace} data-testid="manage-workspace-link">
              <Settings2 size={13} /> Spravovat Workspace
            </Button>
          ) : <span />}
          <button type="button" className="btn btn-submit" onClick={onClose} data-testid="project-team-done-btn">Hotovo</button>
        </div>
      </div>
    </div>
  );
}
