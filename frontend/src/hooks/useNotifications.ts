import { useCallback, useEffect, useState } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { collaborationService } from '../services/collaborationService';
import type { AppNotification } from '../types/kanban';

/**
 * The signed-in user's in-app notifications (RUN 01). Rows are created by the database only
 * (mentions, assignments, membership, invitations) and readable only by their recipient (RLS); the
 * realtime subscription is filtered to the recipient and authorized by the same policy.
 */
export function useNotifications(userId: string | undefined) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const enabled = hasSupabaseConfig && Boolean(userId);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setItems(await collaborationService.fetchNotifications());
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !userId) return;
    let active = true;
    collaborationService.fetchNotifications().then((rows) => { if (active) setItems(rows); });
    let wasLive = false;
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        () => { collaborationService.fetchNotifications().then((rows) => { if (active) setItems(rows); }); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (wasLive) collaborationService.fetchNotifications().then((rows) => { if (active) setItems(rows); });
          wasLive = true;
        }
      });
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [enabled, userId]);

  const markRead = useCallback(async (ids: string[]) => {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: now } : n)));
    await collaborationService.markNotificationsRead(ids);
  }, []);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    await collaborationService.markAllNotificationsRead();
  }, []);

  const visible = enabled ? items : [];
  const unread = visible.filter((n) => !n.readAt).length;
  return { items: visible, unread, enabled, refresh, markRead, markAllRead };
}
