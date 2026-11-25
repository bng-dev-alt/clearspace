import { useEffect, useRef, useState } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { foldPresence, type PresenceIdentity, type PresenceUser, type PresenceMeta } from './usePresence';

export type PgEvent = 'INSERT' | 'UPDATE' | 'DELETE';
export type SyncStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

/** Server broadcast on the project topic (RUN 01B): a signal, never the authoritative data. */
export type ChangeSignal =
  | { t: 'card'; op: 'upsert'; id: string; v?: number; r?: number }
  | { t: 'card'; op: 'removed'; id: string }
  | { t: 'column'; op: 'upsert'; id: string; name: string; position: number; role?: string | null }
  | { t: 'column'; op: 'removed'; id: string }
  | { t: 'membership'; op: string }
  /** RUN 02: external file links of the project (card = task link, null = project link); ids only. */
  | { t: 'links'; op: string; card: string | null };

export interface DbActivityRow {
  id: string;
  project_id: string;
  card_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action_type: string;
  entity_type: string;
  entity_id?: string | null;
  source?: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

/** In-tab fan-out of project activity to the timeline drawer (one channel per project and tab). */
const activityTarget = typeof window !== 'undefined' ? new EventTarget() : null;
export function onProjectActivity(projectId: string, cb: (row: DbActivityRow) => void): () => void {
  if (!activityTarget) return () => {};
  const h = (e: Event) => { const row = (e as CustomEvent<DbActivityRow>).detail; if (row.project_id === projectId) cb(row); };
  activityTarget.addEventListener('activity', h);
  return () => activityTarget.removeEventListener('activity', h);
}
const resyncTarget = typeof window !== 'undefined' ? new EventTarget() : null;
export function onProjectResync(projectId: string, cb: () => void): () => void {
  if (!resyncTarget) return () => {};
  const h = (e: Event) => { if ((e as CustomEvent<string>).detail === projectId) cb(); };
  resyncTarget.addEventListener('resync', h);
  return () => resyncTarget.removeEventListener('resync', h);
}

export function projectTopic(projectId: string, key: string): string {
  return `project:${projectId}:${key}`;
}

interface UseRealtimeBoardParams {
  projectId: string;
  /** Per-project secret from projects.realtime_key (readable by members only); rotates when a member leaves. */
  realtimeKey: string | null;
  enabled: boolean;
  presence?: PresenceIdentity | null;
  onSignal?: (s: ChangeSignal) => void;
  onResync?: () => void;
  onStatus?: (status: SyncStatus) => void;
}

/**
 * The project's realtime channel (RUN 01B). PRIVATE topic `project:<id>:<key>`: joining is authorized by the
 * realtime.messages policies (current members only, with the current key), the database is the only one who
 * broadcasts (clients may only track presence), and the payloads are signals the client re-reads under its own
 * RLS. One channel per project per tab, removed on unmount/project switch/key rotation. After an interruption the
 * next SUBSCRIBED (and the browser `online` event) triggers `onResync`, which re-reads the board.
 */
export function useRealtimeBoard({ projectId, realtimeKey, enabled, presence, onSignal, onResync, onStatus }: UseRealtimeBoardParams): PresenceUser[] {
  const [others, setOthers] = useState<PresenceUser[]>([]);
  const handlers = useRef({ onSignal, onResync, onStatus });
  useEffect(() => { handlers.current = { onSignal, onResync, onStatus }; });
  const userId = presence?.userId;
  const name = presence?.name;
  const initials = presence?.initials;
  const color = presence?.color;

  useEffect(() => {
    if (!enabled || !hasSupabaseConfig || !projectId || !realtimeKey) {
      handlers.current.onStatus?.('off');
      return;
    }
    let wasLive = false;
    let interrupted = false;
    handlers.current.onStatus?.('connecting');
    const channel = supabase.channel(projectTopic(projectId, realtimeKey), {
      config: { private: true, ...(userId ? { presence: { key: userId } } : {}) },
    });
    const meta = (): PresenceMeta => ({
      user_id: userId ?? '',
      name: name || 'Uživatel',
      initials: initials || '?',
      color: color || '#209dd7',
      idle: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    });
    channel
      .on('broadcast', { event: 'change' }, ({ payload }) => handlers.current.onSignal?.(payload as ChangeSignal))
      .on('broadcast', { event: 'activity' }, ({ payload }) => {
        activityTarget?.dispatchEvent(new CustomEvent('activity', { detail: payload as DbActivityRow }));
      })
      .on('presence', { event: 'sync' }, () => {
        setOthers(foldPresence(channel.presenceState<PresenceMeta>() as Record<string, PresenceMeta[]>, userId));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          handlers.current.onStatus?.('live');
          if (userId) void channel.track(meta());
          if (wasLive && interrupted) {
            handlers.current.onResync?.();
            resyncTarget?.dispatchEvent(new CustomEvent('resync', { detail: projectId }));
          }
          wasLive = true;
          interrupted = false;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (wasLive) interrupted = true;
          handlers.current.onStatus?.('reconnecting');
        }
      });

    const onOnline = () => { if (wasLive) handlers.current.onResync?.(); };
    const onVisibility = () => { if (userId) void channel.track(meta()); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      supabase.removeChannel(channel);
      setOthers([]);
    };
  }, [projectId, realtimeKey, enabled, userId, name, initials, color]);

  return enabled && realtimeKey ? others : [];
}
