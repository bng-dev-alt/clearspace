import type { Card } from '../../types/kanban';

/**
 * Concurrent-edit rules (RUN 01).
 *
 * Every card row has a server `version`. A save sends the version it is based on; the database
 * applies it only if the row is still at that version. When it is not, the client merges
 * field by field (three-way: base = what the editor started from, mine = my edit, theirs = server):
 *   - a field nobody else touched (theirs == base) -> my value wins automatically, save retried;
 *   - a field somebody else changed to a different value -> a real conflict, shown to the user,
 *     who keeps theirs or overwrites with mine. Nothing is overwritten silently.
 */
export const EDITABLE_FIELDS = ['title', 'details', 'tag', 'priority', 'dueDate', 'assignees'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export function comparable(card: Partial<Card>, field: EditableField): string {
  if (field === 'assignees') {
    return (card.assignees ?? []).map((m) => m.id).filter((id) => id !== 'member-fallback').join(',');
  }
  const value = card[field];
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Fields of `mine` that somebody else changed differently since `base`. */
export function detectConflicts(base: Partial<Card>, mine: Partial<Card>, theirs: Partial<Card>): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => {
    if (!(field in mine)) return false;
    const b = comparable(base, field);
    const t = comparable(theirs, field);
    const m = comparable(mine, field);
    return t !== b && t !== m;
  });
}

/** Only the editable fields present in `updates`, taken from `card` (the base snapshot of an edit). */
export function pickBase(card: Card, updates: Partial<Card>): Partial<Card> {
  const base: Partial<Card> = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in updates) (base as Record<string, unknown>)[field] = card[field];
  }
  return base;
}

/**
 * Should an incoming server copy replace the local one? Never go backwards: an older version (or an
 * older child revision at the same version) is a stale / out-of-order delivery and is dropped.
 */
export function isNewer(local: Pick<Card, 'version' | 'childRev'> | undefined, incoming: Pick<Card, 'version' | 'childRev'>): boolean {
  if (!local || local.version === undefined || incoming.version === undefined) return true;
  if (incoming.version !== local.version) return incoming.version > local.version;
  return (incoming.childRev ?? 0) > (local.childRev ?? 0);
}

export const FIELD_LABELS: Record<EditableField, string> = {
  title: 'název',
  details: 'popis',
  tag: 'štítek',
  priority: 'priorita',
  dueDate: 'termín',
  assignees: 'řešitelé',
};
