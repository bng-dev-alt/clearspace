import { useEffect, useRef } from 'react';
import { supabase, hasSupabaseConfig } from '../lib/supabase';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';

interface DbCardRow {
  id: string;
  column_id: string;
  title: string;
  details: string | null;
  tag: string | null;
  priority: 'Low' | 'Medium' | 'High' | null;
  due_date: string | null;
  position: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

interface DbColumnRow {
  id: string;
  name: string;
  project_id: string;
  position: number;
}

interface DbActivityRow {
  id: string;
  project_id: string;
  card_id: string | null;
  actor_id: string | null;
  actor_name: string;
  action_type: string;
  entity_type: 'task' | 'column' | 'project' | 'member';
  details: Record<string, unknown> | null;
  created_at: string;
}

type PgEvent = 'INSERT' | 'UPDATE' | 'DELETE';

interface UseRealtimeBoardParams {
  projectId: string;
  enabled: boolean;
  onCardChange: (event: PgEvent, newRow: DbCardRow | null, oldRow: DbCardRow | null) => void;
  onColumnChange: (event: PgEvent, newRow: DbColumnRow | null, oldRow: DbColumnRow | null) => void;
  onActivityInsert: (row: DbActivityRow) => void;
}

/**
 * Live sync (Team Collaboration v1.3, Fáze 6): odebírá Supabase Realtime
 * změny na columns/cards/activity_logs a předává je volajícímu přes
 * callbacky. Sama neudržuje žádný stav boardu -- merge do Column[] dělá
 * useKanbanBoard, který má aktuální přehled o vztazích karta -> sloupec.
 *
 * cards nemá project_id sloupec (jen column_id), takže Realtime filtr
 * nejde postavit na projekt přímo -- odebíráme bez filtru a rozhodnutí,
 * zda karta patří do tohoto projektu, dělá volající (zná aktuální sadu
 * column id).
 */
export function useRealtimeBoard({
  projectId,
  enabled,
  onCardChange,
  onColumnChange,
  onActivityInsert,
}: UseRealtimeBoardParams) {
  // Callbacky se mění při každém renderu (nové closures) -- držíme je v refu,
  // aby efekt níže nemusel channel pořád rušit a zakládat znovu.
  const onCardChangeRef = useRef(onCardChange);
  const onColumnChangeRef = useRef(onColumnChange);
  const onActivityInsertRef = useRef(onActivityInsert);
  useEffect(() => {
    onCardChangeRef.current = onCardChange;
    onColumnChangeRef.current = onColumnChange;
    onActivityInsertRef.current = onActivityInsert;
  });

  useEffect(() => {
    if (!enabled || !hasSupabaseConfig || !projectId) return;

    const channel = supabase
      .channel(`board:${projectId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cards' },
        (payload: RealtimePostgresChangesPayload<DbCardRow>) => {
          onCardChangeRef.current(
            payload.eventType as PgEvent,
            (payload.new as DbCardRow) ?? null,
            (payload.old as DbCardRow) ?? null
          );
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'columns', filter: `project_id=eq.${projectId}` },
        (payload: RealtimePostgresChangesPayload<DbColumnRow>) => {
          onColumnChangeRef.current(
            payload.eventType as PgEvent,
            (payload.new as DbColumnRow) ?? null,
            (payload.old as DbColumnRow) ?? null
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'activity_logs', filter: `project_id=eq.${projectId}` },
        (payload: RealtimePostgresChangesPayload<DbActivityRow>) => {
          if (payload.new) onActivityInsertRef.current(payload.new as DbActivityRow);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId, enabled]);
}
