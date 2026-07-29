'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { X, History, PlusCircle, ArrowRightLeft, Archive, Columns3, Trash2, UserPlus, UserMinus, Sparkles } from 'lucide-react';
import type { ProjectActivityLog } from '../../types/kanban';
import { collaborationService } from '../../services/collaborationService';
import { useRealtimeBoard } from '../../hooks/useRealtimeBoard';

interface ActivityFeedDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

const ACTION_META: Record<string, { verb: (log: ProjectActivityLog) => string; Icon: React.ComponentType<{ size?: number }> }> = {
  card_created: {
    verb: (log) => `přidal(a) úkol „${log.details?.title ?? ''}"`,
    Icon: PlusCircle,
  },
  card_archived: {
    verb: (log) => `archivoval(a) úkol „${log.details?.title ?? ''}"`,
    Icon: Archive,
  },
  card_moved: {
    verb: (log) => `přesunul(a) úkol „${log.details?.title ?? ''}" z ${log.details?.from ?? '?'} do ${log.details?.to ?? '?'}`,
    Icon: ArrowRightLeft,
  },
  column_created: {
    verb: (log) => `vytvořil(a) sloupec „${log.details?.name ?? ''}"`,
    Icon: Columns3,
  },
  column_deleted: {
    verb: (log) => `smazal(a) sloupec „${log.details?.name ?? ''}"`,
    Icon: Trash2,
  },
  member_added: {
    verb: (log) => `přidal(a) do projektu ${log.details?.name ?? 'člena'}`,
    Icon: UserPlus,
  },
  member_removed: {
    verb: (log) => `odebral(a) z projektu ${log.details?.name ?? 'člena'}`,
    Icon: UserMinus,
  },
};

const DEFAULT_META = { verb: () => 'provedl(a) akci', Icon: Sparkles };

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'právě teď';
  if (diffMin < 60) return `před ${diffMin} min`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `před ${diffHours} h`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return 'včera';
  if (diffDays < 7) return `před ${diffDays} dny`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}

export default function ActivityFeedDrawer({ isOpen, onClose, projectId }: ActivityFeedDrawerProps) {
  // null = ještě nenačteno (loading); [] = načteno, prázdné.
  const [activities, setActivities] = useState<ProjectActivityLog[] | null>(null);

  useEffect(() => {
    if (!isOpen || !projectId) return;
    let active = true;
    collaborationService
      .fetchActivities(projectId)
      .then((rows) => {
        if (active) setActivities(rows);
      })
      .catch(() => {
        if (active) setActivities([]);
      });
    return () => {
      active = false;
    };
  }, [isOpen, projectId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Živě doplňovat nové záznamy, dokud je panel otevřený (Fáze 6).
  const handleActivityInsert = useCallback((row: {
    id: string; project_id: string; card_id: string | null; actor_id: string | null;
    actor_name: string; action_type: string; entity_type: 'task' | 'column' | 'project' | 'member';
    details: Record<string, unknown> | null; created_at: string;
  }) => {
    setActivities((prev) => {
      const next = prev ?? [];
      if (next.some((a) => a.id === row.id)) return next;
      const mapped: ProjectActivityLog = {
        id: row.id,
        projectId: row.project_id,
        cardId: row.card_id ?? undefined,
        actorId: row.actor_id ?? undefined,
        actorName: row.actor_name,
        actionType: row.action_type,
        entityType: row.entity_type,
        details: row.details ?? undefined,
        createdAt: row.created_at,
      };
      return [mapped, ...next];
    });
  }, []);

  useRealtimeBoard({
    projectId,
    enabled: isOpen && Boolean(projectId),
    onCardChange: () => {},
    onColumnChange: () => {},
    onActivityInsert: handleActivityInsert,
  });

  if (!isOpen) return null;

  return (
    <div className="drawer-overlay" onClick={onClose} data-testid="activity-feed-overlay">
      <div
        className="drawer-content mode-right"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
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

        <div className="drawer-scroll-area">
          {activities === null ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)' }}>Načítání…</p>
          ) : activities.length === 0 ? (
            <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)' }}>
              Zatím žádná aktivita. Události se objeví, jakmile někdo upraví board.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} data-testid="activity-feed-list">
              {activities.map((log) => {
                const meta = ACTION_META[log.actionType] || DEFAULT_META;
                const { Icon } = meta;
                return (
                  <div
                    key={log.id}
                    style={{ display: 'flex', gap: '0.65rem', alignItems: 'flex-start' }}
                    data-testid={`activity-item-${log.id}`}
                  >
                    <div
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--surface-2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        color: 'var(--blue-primary)',
                      }}
                    >
                      <Icon size={14} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
                        <strong>{log.actorName}</strong> {meta.verb(log)}
                      </span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>
                        {formatRelativeTime(log.createdAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
