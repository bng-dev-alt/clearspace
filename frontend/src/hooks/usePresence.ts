import { useEffect, useState } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';

export interface PresenceUser {
  userId: string;
  name: string;
  initials: string;
  color: string;
  /** Every tab of this user is in the background. */
  idle: boolean;
  /** Open tabs/sessions of this user on the project. */
  sessions: number;
}

interface PresenceMeta {
  user_id: string;
  name: string;
  initials: string;
  color: string;
  idle: boolean;
}

export interface PresenceIdentity {
  userId: string;
  name: string;
  initials: string;
  color: string;
}

/** Folds Realtime presence state (key = user id, one meta per tab) into one entry per person. */
export function foldPresence(state: Record<string, PresenceMeta[]>, selfId?: string): PresenceUser[] {
  return Object.entries(state)
    .filter(([key, metas]) => key !== selfId && metas.length > 0)
    .map(([key, metas]) => ({
      userId: key,
      name: metas[0].name,
      initials: metas[0].initials,
      color: metas[0].color,
      idle: metas.every((m) => m.idle),
      sessions: metas.length,
    }))
    .sort((a, b) => Number(a.idle) - Number(b.idle) || a.name.localeCompare(b.name, 'cs-CZ'));
}

/**
 * Who else is looking at this project right now (RUN 01). Ephemeral: Realtime Presence only, no
 * database writes. The channel `project:<id>` is PRIVATE: joining is authorized by the
 * realtime.messages policies (project members only), so the list never leaks to outsiders.
 * Disconnected sessions drop out when the socket's heartbeat stops (Realtime server side).
 */
export function usePresence(projectId: string, me: PresenceIdentity | null, enabled: boolean): PresenceUser[] {
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const userId = me?.userId;
  const name = me?.name;
  const initials = me?.initials;
  const color = me?.color;

  useEffect(() => {
    if (!enabled || !hasSupabaseConfig || !projectId || !userId) return;
    const channel = supabase.channel(`project:${projectId}`, {
      config: { private: true, presence: { key: userId } },
    });
    const meta = (): PresenceMeta => ({
      user_id: userId,
      name: name || 'Uživatel',
      initials: initials || '?',
      color: color || '#209dd7',
      idle: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    });
    channel
      .on('presence', { event: 'sync' }, () => {
        setOthers(foldPresence(channel.presenceState<PresenceMeta>() as Record<string, PresenceMeta[]>, userId));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void channel.track(meta());
      });

    const onVisibility = () => { void channel.track(meta()); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      supabase.removeChannel(channel);
      setOthers([]);
    };
  }, [projectId, enabled, userId, name, initials, color]);

  return enabled ? others : [];
}
