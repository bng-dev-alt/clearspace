'use client';

import React, { useRef, useState } from 'react';
import { DialogFocus } from '../ui/useDialogFocus';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useNotifications } from '../../hooks/useNotifications';
import { useClickOutside } from '../../hooks/useClickOutside';
import { collaborationService } from '../../services/collaborationService';
import { describeNotification, notificationHref } from '../../lib/collab/notificationText';
import { formatRelativeTime } from '../../lib/collab/activityText';
import type { AppNotification } from '../../types/kanban';

/**
 * In-app notifications (RUN 01): bell with unread count, list, mark read, open the entity.
 * Renders nothing without a backend (demo mode has a single user).
 */
export default function NotificationBell() {
  const { user } = useAuth();
  const router = useRouter();
  const { items, unread, enabled, markRead, markAllRead, refresh } = useNotifications(user?.id);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref as React.RefObject<HTMLElement | null>, () => setOpen(false));

  if (!enabled) return null;

  const openItem = (n: AppNotification) => {
    void markRead([n.id]);
    const href = notificationHref(n);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  };

  const accept = async (n: AppNotification) => {
    if (!n.entityId) return;
    setBusyId(n.id);
    setError(null);
    try {
      const projectId = await collaborationService.acceptInvitationById(n.entityId);
      await refresh();
      setOpen(false);
      if (projectId) router.push(`/projects/${encodeURIComponent(projectId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pozvánku se nepodařilo přijmout.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="navbar-notifications" ref={ref}>
      <button
        type="button"
        className="navbar-bell"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Oznámení, nepřečtených: ${unread}` : 'Oznámení'}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="notifications-bell"
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="navbar-bell-count" data-testid="notifications-unread">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notifications-panel" role="dialog" aria-label="Oznámení" data-testid="notifications-panel">
          <DialogFocus />
          <div className="notifications-head">
            <span>Oznámení</span>
            {unread > 0 && (
              <button type="button" className="notifications-mark-all" onClick={() => void markAllRead()} data-testid="notifications-mark-all">
                Označit vše jako přečtené
              </button>
            )}
          </div>
          {error && <p role="alert" className="notifications-error">{error}</p>}
          {items.length === 0 ? (
            <p className="notifications-empty">Žádná oznámení. Ozveme se, když vás někdo zmíní nebo vám přidělí úkol.</p>
          ) : (
            <ul className="notifications-list">
              {items.map((n) => (
                <li key={n.id} className={`notifications-item${n.readAt ? '' : ' is-unread'}`} data-testid={`notification-${n.id}`} data-type={n.type}>
                  <button type="button" className="notifications-item-main" onClick={() => openItem(n)}>
                    <span className="notifications-text">{describeNotification(n)}</span>
                    <time className="notifications-time" dateTime={n.createdAt}>{formatRelativeTime(n.createdAt)}</time>
                  </button>
                  {n.type === 'invitation' && (
                    <button
                      type="button"
                      className="cs-btn cs-btn--primary cs-btn--sm"
                      disabled={busyId !== null}
                      onClick={() => void accept(n)}
                      data-testid={`notification-accept-${n.id}`}
                    >
                      {busyId === n.id ? 'Přijímám…' : 'Přijmout'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
