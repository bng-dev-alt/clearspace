'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  X, History, PlusCircle, ArrowRightLeft, Archive, Columns3, UserPlus, Sparkles,
  CheckCircle2, PencilLine, UserCheck, MessageSquare, FolderKanban, HardDrive,
} from 'lucide-react';
import type { ProjectActivityLog } from '../../types/kanban';
import { collaborationService, mapActivityRow } from '../../services/collaborationService';
import { onProjectActivity, onProjectResync, type DbActivityRow } from '../../hooks/useRealtimeBoard';
import CommunicationList from '../hub/CommunicationList';
import { describeActivity, formatRelativeTime, type ActivityKind } from '../../lib/collab/activityText';

interface ActivityFeedDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  /** Opens the task an event refers to (only offered while the task still exists on the board). */
  onOpenCard?: (cardId: string) => void;
  /** Ids of tasks currently on the board. */
  existingCardIds?: Set<string>;
  /** RUN 07: a "Komunikace" tab with the project's recorded chat communication (hub switched on). */
  showCommunication?: boolean;
  memberNames?: Map<string, string>;
}

const ICONS: Record<ActivityKind, React.ComponentType<{ size?: number }>> = {
  create: PlusCircle,
  move: ArrowRightLeft,
  done: CheckCircle2,
  archive: Archive,
  edit: PencilLine,
  assign: UserCheck,
  comment: MessageSquare,
  column: Columns3,
  member: UserPlus,
  project: FolderKanban,
  file: HardDrive,
  other: Sparkles,
};

export default function ActivityFeedDrawer({ isOpen, onClose, projectId, onOpenCard, existingCardIds, showCommunication = false, memberNames }: ActivityFeedDrawerProps) {
  const [tab, setTab] = useState<'activity' | 'communication'>('activity');
  // null = ještě nenačteno (loading); [] = načteno, prázdné.
  const [activities, setActivities] = useState<ProjectActivityLog[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let active = true;
    collaborationService
      .fetchActivities(projectId)
      .then((rows) => { if (active) { setActivities(rows.filter((r) => r.entityType !== 'checklist')); setFailed(false); } })
      .catch(() => { if (active) { setActivities([]); setFailed(true); } });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!isOpen || !projectId) return;
    return load();
  }, [isOpen, projectId, load]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Živě doplňovat nové záznamy, dokud je panel otevřený (deduplikace podle id).
  const handleActivityInsert = useCallback((row: DbActivityRow) => {
    setActivities((prev) => {
      const next = prev ?? [];
      if (next.some((a) => a.id === row.id)) return next;
      if (row.entity_type === 'checklist') return next; // per-task detail, shown in the task history
      return [mapActivityRow(row), ...next];
    });
  }, []);

  // Live events come through the board's private project channel (RUN 01B); no second subscription.
  useEffect(() => {
    if (!isOpen || !projectId) return;
    const off1 = onProjectActivity(projectId, handleActivityInsert);
    const off2 = onProjectResync(projectId, () => { load(); });
    return () => { off1(); off2(); };
  }, [isOpen, projectId, handleActivityInsert, load]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay and panel are siblings (as in the task drawer): nested inside the overlay (z 90) the panel
          sat below the sticky navbar (z 100), which covered its header and close button. */}
      <div className="drawer-overlay" onClick={onClose} data-testid="activity-feed-overlay" />
      <div
        className="drawer-content mode-right"
        role="dialog"
        aria-modal="true"
        aria-label="Aktivita projektu"
        data-testid="activity-feed-drawer"
      >
        <div className="drawer-header">
          <div className="drawer-header-left">
            <History size={18} />
            <span style={{ fontWeight: 700, fontSize: '0.95rem' }}>Aktivita projektu</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zavřít okno"
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}
            data-testid="activity-feed-close-btn"
          >
            <X size={20} />
          </button>
        </div>

        {showCommunication && (
          <div className="hub-tabs" role="tablist" aria-label="Zobrazení">
            <button type="button" role="tab" aria-selected={tab === 'activity'} className={`hub-tab${tab === 'activity' ? ' is-active' : ''}`} onClick={() => setTab('activity')} data-testid="activity-tab-all">Změny</button>
            <button type="button" role="tab" aria-selected={tab === 'communication'} className={`hub-tab${tab === 'communication' ? ' is-active' : ''}`} onClick={() => setTab('communication')} data-testid="activity-tab-communication">Komunikace</button>
          </div>
        )}
        <div className="drawer-scroll-area">
          {showCommunication && tab === 'communication' ? (
            <CommunicationList projectId={projectId} names={memberNames} onOpenCard={onOpenCard ? (id) => { onOpenCard(id); onClose(); } : undefined} />
          ) : activities === null ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)' }}>Načítání…</p>
          ) : failed ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--danger)' }} role="alert">
              Aktivitu se nepodařilo načíst. Zkuste panel otevřít znovu.
            </p>
          ) : activities.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)' }}>
              Zatím žádná aktivita. Události se objeví, jakmile někdo upraví board.
            </p>
          ) : (
            <ol style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', listStyle: 'none', margin: 0, padding: 0 }} data-testid="activity-feed-list">
              {activities.map((log) => {
                const { text, kind } = describeActivity(log);
                const Icon = ICONS[kind];
                const canOpen = Boolean(onOpenCard && log.cardId && (!existingCardIds || existingCardIds.has(log.cardId)));
                return (
                  <li
                    key={log.id}
                    style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }}
                    data-testid={`activity-item-${log.id}`}
                    data-action={log.actionType}
                  >
                    <div
                      aria-hidden
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--surface-2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        color: kind === 'done' ? 'var(--success, var(--blue-primary))' : 'var(--blue-primary)',
                      }}
                    >
                      <Icon size={14} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', minWidth: 0 }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--dark-navy)', overflowWrap: 'anywhere' }}>
                        <strong>{log.actorName}</strong> {text}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <time dateTime={log.createdAt} title={new Date(log.createdAt).toLocaleString('cs-CZ')}>
                          {formatRelativeTime(log.createdAt)}
                        </time>
                        {canOpen && (
                          <button
                            type="button"
                            onClick={() => { onOpenCard!(log.cardId!); onClose(); }}
                            className="cs-link-button"
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontSize: '0.7rem', fontWeight: 600 }}
                            data-testid={`activity-open-card-${log.id}`}
                          >
                            Otevřít úkol
                          </button>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}
