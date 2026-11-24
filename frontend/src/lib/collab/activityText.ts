import type { ProjectActivityLog } from '../../types/kanban';

/**
 * Human-readable Czech text for a project event (RUN 01). Pure: used by the timeline and tests.
 * Unknown types (future integrations: Drive, Gmail, Calendar, Meeting Intelligence...) fall back to
 * a neutral sentence instead of breaking the feed. Values come from the database and are rendered
 * as React text (never HTML).
 */
const PRIORITY: Record<string, string> = { High: 'vysokou', Medium: 'střední', Low: 'nízkou' };
const ROLE: Record<string, string> = { owner: 'vlastník', admin: 'správce', member: 'editor', viewer: 'čtenář' };

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

function formatDue(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('cs-CZ');
}

export type ActivityKind = 'create' | 'move' | 'done' | 'archive' | 'edit' | 'assign' | 'comment' | 'column' | 'member' | 'project' | 'other';

export function describeActivity(log: ProjectActivityLog): { text: string; kind: ActivityKind } {
  const d = log.details ?? {};
  const title = `„${str(d.title, 'úkol')}"`;
  switch (log.actionType) {
    case 'card_created': return { text: `přidal(a) úkol ${title}`, kind: 'create' };
    case 'card_moved':
      return d.completed === true
        ? { text: `dokončil(a) úkol ${title}`, kind: 'done' }
        : { text: `přesunul(a) úkol ${title} z ${str(d.from, '?')} do ${str(d.to, '?')}`, kind: 'move' };
    case 'card_archived': return { text: `archivoval(a) úkol ${title}`, kind: 'archive' };
    case 'card_restored': return { text: `obnovil(a) úkol ${title}`, kind: 'archive' };
    case 'card_deleted': return { text: `smazal(a) úkol ${title}`, kind: 'archive' };
    case 'card_renamed': return { text: `přejmenoval(a) úkol „${str(d.from, '?')}" na „${str(d.to, '?')}"`, kind: 'edit' };
    case 'card_priority_changed':
      return { text: d.to ? `nastavil(a) ${PRIORITY[str(d.to)] ?? str(d.to)} prioritu úkolu ${title}` : `odebral(a) prioritu úkolu ${title}`, kind: 'edit' };
    case 'card_due_changed':
      return { text: d.to ? `změnil(a) termín úkolu ${title} na ${formatDue(d.to)}` : `odebral(a) termín úkolu ${title}`, kind: 'edit' };
    case 'card_tag_changed': return { text: d.to ? `označil(a) úkol ${title} štítkem ${str(d.to)}` : `odebral(a) štítek úkolu ${title}`, kind: 'edit' };
    case 'card_details_changed': return { text: `upravil(a) popis úkolu ${title}`, kind: 'edit' };
    case 'card_assigned': return { text: `přiřadil(a) úkol ${title} uživateli ${str(d.name, 'člen týmu')}`, kind: 'assign' };
    case 'card_unassigned': return { text: `odebral(a) ${str(d.name, 'člena týmu')} z úkolu ${title}`, kind: 'assign' };
    case 'comment_added': return { text: `okomentoval(a) úkol ${title}`, kind: 'comment' };
    case 'comment_edited': return { text: `upravil(a) komentář u úkolu ${title}`, kind: 'comment' };
    case 'comment_deleted': return { text: `smazal(a) komentář u úkolu ${title}`, kind: 'comment' };
    case 'card_moved_out': return { text: `přesunul(a) úkol ${title} do jiného projektu`, kind: 'move' };
    case 'card_moved_in': return { text: `přesunul(a) sem úkol ${title} z jiného projektu${d.to ? ` (sloupec ${str(d.to)})` : ''}`, kind: 'move' };
    case 'checklist_item_added': return { text: `přidal(a) položku checklistu „${str(d.item)}"`, kind: 'edit' };
    case 'checklist_item_completed': return { text: `splnil(a) položku checklistu „${str(d.item)}"`, kind: 'done' };
    case 'checklist_item_reopened': return { text: `znovu otevřel(a) položku checklistu „${str(d.item)}"`, kind: 'edit' };
    case 'checklist_item_renamed': return { text: `přejmenoval(a) položku checklistu „${str(d.from)}" na „${str(d.to)}"`, kind: 'edit' };
    case 'checklist_item_removed': return { text: `odstranil(a) položku checklistu „${str(d.item)}"`, kind: 'edit' };
    case 'column_created': return { text: `vytvořil(a) sloupec „${str(d.name)}"`, kind: 'column' };
    case 'column_renamed': return { text: `přejmenoval(a) sloupec „${str(d.from, '?')}" na „${str(d.to, '?')}"`, kind: 'column' };
    case 'column_deleted': return { text: `smazal(a) sloupec „${str(d.name)}"`, kind: 'column' };
    case 'board_restored': return { text: 'obnovil(a) board ze zálohy', kind: 'project' };
    case 'project_created': return { text: `založil(a) projekt „${str(d.name)}"`, kind: 'project' };
    case 'project_renamed': return { text: `přejmenoval(a) projekt na „${str(d.to)}"`, kind: 'project' };
    case 'member_invited': return { text: `pozval(a) ${str(d.email, 'nového člena')} jako ${ROLE[str(d.role)] ?? 'člena'}`, kind: 'member' };
    case 'member_added':
      return log.actorName && str(d.name) === log.actorName
        ? { text: `se připojil(a) k projektu jako ${ROLE[str(d.role)] ?? 'člen'}`, kind: 'member' }
        : { text: `přidal(a) do projektu ${str(d.name, 'člena')}${d.role ? ` jako ${ROLE[str(d.role)] ?? str(d.role)}` : ''}`, kind: 'member' };
    case 'member_role_changed': return { text: `změnil(a) roli ${str(d.name, 'člena')} na ${ROLE[str(d.to)] ?? str(d.to)}`, kind: 'member' };
    case 'member_removed': return { text: `odebral(a) z projektu ${str(d.name, 'člena')}`, kind: 'member' };
    default: return { text: 'provedl(a) akci', kind: 'other' };
  }
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const diffMin = Math.round((now - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return 'právě teď';
  if (diffMin < 60) return `před ${diffMin} min`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `před ${diffHours} h`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return 'včera';
  if (diffDays < 7) return `před ${diffDays} dny`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}
