import { useCallback, useEffect, useState } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { collaborationService } from '../services/collaborationService';
import type { AppNotification } from '../types/kanban';

/**
 * The signed-in user's in-app notifications. Rows are created by the database only and readable only by their
 * recipient (RLS). Live updates: the database broadcasts a content-free signal on the PRIVATE topic
 * `user:<uid>` (authorized for that user only); the list is then re-read under RLS.
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
    const load = () => collaborationService.fetchNotifications().then((rows) => { if (active) setItems(rows); });
    void load();
    let wasLive = false;
    const channel = supabase
      .channel(`user:${userId}`, { config: { private: true } })
      .on('broadcast', { event: 'notification' }, () => { void load(); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (wasLive) void load();
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
