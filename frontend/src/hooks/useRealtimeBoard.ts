import { useEffect, useRef } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

export type PgEvent = 'INSERT' | 'UPDATE' | 'DELETE';
export type SyncStatus = 'off' | 'connecting' | 'live' | 'reconnecting';

export interface DbCardSignal {
  id: string;
  column_id?: string;
  project_id?: string;
  version?: number;
  child_rev?: number;
}

export interface DbColumnRow {
  id: string;
  name: string;
  project_id: string;
  position: number;
  role?: string | null;
}

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

interface UseRealtimeBoardParams {
  projectId: string;
  enabled: boolean;
  /** Distinguishes several subscribers of the same project in one tab (board vs. activity drawer). */
  channelName?: string;
  onCardChange?: (event: PgEvent, row: DbCardSignal) => void;
  onColumnChange?: (event: PgEvent, newRow: DbColumnRow | null, oldRow: Partial<DbColumnRow> | null) => void;
  onActivityInsert?: (row: DbActivityRow) => void;
  /** Roster / role of somebody changed (or the caller lost access). */
  onMembershipChange?: () => void;
  /** Called after the channel came back from an interruption: re-read the authoritative state. */
  onResync?: () => void;
  onStatus?: (status: SyncStatus) => void;
}

/**
 * Realtime for one project (RUN 01). Realtime is only a SIGNAL: the database stays the source of
 * truth. Every change event names an entity; the caller re-reads it (or merges the row) and drops
 * stale/out-of-order data by `version`. Authorization: postgres_changes are filtered by the table's
 * RLS for each subscriber, so a non-member (or a member who was just removed) receives nothing.
 *
 * Filters: cards / columns / activity_logs / project_members carry project_id, so only this
 * project's rows are evaluated. Exactly one channel per (project, purpose); it is removed on
 * unmount / project switch. After CHANNEL_ERROR / TIMED_OUT / CLOSED the client library rejoins on
 * its own; the next SUBSCRIBED triggers `onResync` so events missed while offline are reconciled.
 */
export function useRealtimeBoard({
  projectId,
  enabled,
  channelName = 'board',
  onCardChange,
  onColumnChange,
  onActivityInsert,
  onMembershipChange,
  onResync,
  onStatus,
}: UseRealtimeBoardParams) {
  const handlers = useRef({ onCardChange, onColumnChange, onActivityInsert, onMembershipChange, onResync, onStatus });
  useEffect(() => {
    handlers.current = { onCardChange, onColumnChange, onActivityInsert, onMembershipChange, onResync, onStatus };
  });

  const wants = useRef({ cards: Boolean(onCardChange), columns: Boolean(onColumnChange), activity: Boolean(onActivityInsert), members: Boolean(onMembershipChange) });

  useEffect(() => {
    if (!enabled || !hasSupabaseConfig || !projectId) {
      handlers.current.onStatus?.('off');
      return;
    }
    const filter = `project_id=eq.${projectId}`;
    let wasLive = false;
    let interrupted = false;
    handlers.current.onStatus?.('connecting');

    let channel = supabase.channel(`${channelName}:${projectId}`);
    if (wants.current.cards) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'cards', filter },
        (payload: RealtimePostgresChangesPayload<DbCardSignal>) => {
          const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as DbCardSignal;
          if (row?.id) handlers.current.onCardChange?.(payload.eventType as PgEvent, row);
        });
    }
    if (wants.current.columns) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'columns', filter },
        (payload: RealtimePostgresChangesPayload<DbColumnRow>) => {
          handlers.current.onColumnChange?.(
            payload.eventType as PgEvent,
            payload.eventType === 'DELETE' ? null : (payload.new as DbColumnRow),
            (payload.old as Partial<DbColumnRow>) ?? null
          );
        });
    }
    if (wants.current.activity) {
      channel = channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs', filter },
        (payload: RealtimePostgresChangesPayload<DbActivityRow>) => {
          if (payload.new) handlers.current.onActivityInsert?.(payload.new as DbActivityRow);
        });
    }
    if (wants.current.members) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'project_members', filter },
        () => handlers.current.onMembershipChange?.());
    }

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        handlers.current.onStatus?.('live');
        if (wasLive && interrupted) handlers.current.onResync?.();
        wasLive = true;
        interrupted = false;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (wasLive) interrupted = true;
        handlers.current.onStatus?.('reconnecting');
      }
    });

    // Returning from sleep / a dead network: the socket may need a while to notice; re-read now.
    const onOnline = () => { if (wasLive) handlers.current.onResync?.(); };
    window.addEventListener('online', onOnline);

    return () => {
      window.removeEventListener('online', onOnline);
      supabase.removeChannel(channel);
    };
  }, [projectId, enabled, channelName]);
}
