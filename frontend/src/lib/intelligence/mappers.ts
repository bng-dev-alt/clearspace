import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectActivityLog } from '../../types/kanban';
import type { ProjectItemLite } from './facts';

/** Čisté (browser-safe) mapování řádků DB. Sdílí je server (Context Engine) i klient (podpis čerstvosti). */

interface DbActivityRow {
  id?: unknown;
  card_id?: unknown;
  actor_id?: unknown;
  actor_name?: unknown;
  action_type?: unknown;
  entity_type?: unknown;
  details?: unknown;
  created_at?: unknown;
}

/** Tolerantní mapování řádku activity_logs; neúplný řádek se přeskočí. */
export function mapActivityRows(rows: unknown, projectId: string): ProjectActivityLog[] {
  if (!Array.isArray(rows)) return [];
  const out: ProjectActivityLog[] = [];
  for (const r of rows as DbActivityRow[]) {
    if (typeof r?.id !== 'string' || typeof r.action_type !== 'string' || typeof r.created_at !== 'string') continue;
    out.push({
      id: r.id,
      projectId,
      cardId: typeof r.card_id === 'string' ? r.card_id : undefined,
      actorId: typeof r.actor_id === 'string' ? r.actor_id : undefined,
      actorName: typeof r.actor_name === 'string' ? r.actor_name : '',
      actionType: r.action_type,
      entityType: (['task', 'column', 'project', 'member'] as const).includes(r.entity_type as never)
        ? (r.entity_type as ProjectActivityLog['entityType'])
        : 'task',
      details: r.details && typeof r.details === 'object' && !Array.isArray(r.details) ? (r.details as Record<string, unknown>) : undefined,
      createdAt: r.created_at,
    });
  }
  return out;
}

const ITEM_KINDS = ['decision', 'action_item', 'follow_up', 'risk', 'blocker', 'open_question'];
const ITEM_STATES = ['proposed', 'accepted', 'applied'];

/** Tolerantní mapování řádku intelligence_items; neúplný řádek se přeskočí. */
export function mapItemRows(rows: unknown): ProjectItemLite[] {
  if (!Array.isArray(rows)) return [];
  const out: ProjectItemLite[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (typeof r?.id !== 'string' || typeof r.text !== 'string' || typeof r.created_at !== 'string') continue;
    if (!ITEM_KINDS.includes(r.kind as string) || !ITEM_STATES.includes(r.review_state as string)) continue;
    out.push({
      id: r.id,
      meetingId: typeof r.meeting_id === 'string' ? r.meeting_id : null,
      kind: r.kind as string,
      text: r.text,
      reviewState: r.review_state as ProjectItemLite['reviewState'],
      decidedAt: typeof r.decided_at === 'string' ? r.decided_at : null,
      createdAt: r.created_at,
      appliedCardId: typeof r.applied_card_id === 'string' ? r.applied_card_id : null,
    });
  }
  return out;
}


/** Schválené závěry (accepted/applied) a fond návrhů (proposed) mají každý vlastní limit: nové návrhy nevytlačí starší závěry. */
export const APPROVED_ITEM_LIMIT = 200;
export const PROPOSAL_ITEM_LIMIT = 200;
const ITEM_COLUMNS = 'id, meeting_id, kind, text, review_state, decided_at, created_at, applied_card_id';

/**
 * Položky z porad pro kontext AI, podpis čerstvosti i Znalosti: schválené (`accepted`, `applied`; nejnověji rozhodnuté první)
 * a zvlášť fond návrhů (`proposed`; nejnovější první). Sdílí server (Context Engine) i klient, aby podpis vycházel z týchž dat.
 * Chyba dotazu (např. tabulka v starší DB chybí) = žádné položky z daného dotazu, nikdy výjimka.
 */
export async function fetchProjectItems(db: SupabaseClient, projectId: string): Promise<ProjectItemLite[]> {
  const [approved, proposed] = await Promise.all([
    db
      .from('intelligence_items')
      .select(ITEM_COLUMNS)
      .eq('project_id', projectId)
      .in('review_state', ['accepted', 'applied'])
      .order('decided_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(APPROVED_ITEM_LIMIT),
    db
      .from('intelligence_items')
      .select(ITEM_COLUMNS)
      .eq('project_id', projectId)
      .eq('review_state', 'proposed')
      .order('created_at', { ascending: false })
      .limit(PROPOSAL_ITEM_LIMIT),
  ]);
  return [...(approved.error ? [] : mapItemRows(approved.data)), ...(proposed.error ? [] : mapItemRows(proposed.data))];
}
