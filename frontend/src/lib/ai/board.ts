import { SupabaseClient } from '@supabase/supabase-js';
import { Column } from '../../types/kanban';
import { mapDbCard, DbCard } from '../../services/boardMapping';
import { AiGatewayError } from './errors';

/** Board projektu načtený pod identitou volajícího (RLS rozhoduje, co uvidí). */
export async function loadBoard(
  db: SupabaseClient,
  projectId: string
): Promise<{ project: { id: string; name: string }; columns: Column[] }> {
  const { data: project, error: pErr } = await db
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();
  if (pErr || !project) {
    throw new AiGatewayError('forbidden', 'K tomuto projektu nemáte přístup.');
  }

  const readColumns = (fields: string) =>
    db.from('columns').select(fields).eq('project_id', projectId).order('position', { ascending: true }).limit(50);
  let colRes = await readColumns('id, name, position, role');
  // Databáze bez migrace 0600 nemá sloupec `role` (42703): kontext se sestaví bez rolí, AI featury dál fungují.
  if (colRes.error && (colRes.error.code === '42703' || /role/i.test(colRes.error.message ?? ''))) colRes = await readColumns('id, name, position');
  const { data: cols, error: cErr } = colRes as unknown as { data: { id: string; name: string; position: number; role?: string | null }[] | null; error: unknown };
  if (cErr) throw new AiGatewayError('ai_failed', 'Nepodařilo se načíst data projektu.');

  const colIds = (cols ?? []).map((c) => c.id as string);
  let cards: DbCard[] = [];
  if (colIds.length > 0) {
    const { data: cardRows, error: kErr } = await db
      .from('cards')
      .select('*, task_checklists(*), task_comments(*), task_activities(*), card_assignees(position, member:workspace_members(*))')
      .in('column_id', colIds)
      .order('position', { ascending: true })
      .limit(1000);
    if (kErr) throw new AiGatewayError('ai_failed', 'Nepodařilo se načíst data projektu.');
    cards = (cardRows ?? []) as unknown as DbCard[];
  }

  return {
    project: { id: project.id as string, name: project.name as string },
    columns: (cols ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      role: (c.role as Column['role']) ?? null,
      cards: cards.filter((k) => k.column_id === c.id).map(mapDbCard),
    })),
  };
}
