import type { AppNotification } from '../../types/kanban';

/** Czech sentence for an in-app notification (RUN 01). Pure; values render as React text. */
export function describeNotification(n: AppNotification): string {
  const t = `„${n.title}"`;
  switch (n.type) {
    case 'mention': return `${n.actorName} vás zmínil(a) v komentáři u úkolu ${t}`;
    case 'comment': return `${n.actorName} okomentoval(a) váš úkol ${t}`;
    case 'assignment': return `${n.actorName} vám přiřadil(a) úkol ${t}`;
    case 'project_added': return `${n.actorName} vás přidal(a) do projektu ${t}`;
    case 'project_role_changed': return `${n.actorName} změnil(a) vaši roli v projektu ${t}`;
    case 'project_removed': return `${n.actorName} vás odebral(a) z projektu ${t}`;
    case 'invitation': return `${n.actorName} vás zve do projektu ${t}`;
    case 'invitation_accepted': return `${n.actorName} přijal(a) pozvánku do ${n.projectId ? `projektu ${t}` : 'workspace'}`;
    default: return `${n.actorName}: ${n.title}`;
  }
}

/** Where a notification leads; null = nothing to open (access gone, or an invitation to accept first). */
export function notificationHref(n: AppNotification): string | null {
  if (!n.projectId || n.type === 'project_removed' || n.type === 'invitation') return null;
  const base = `/projects/${encodeURIComponent(n.projectId)}`;
  return n.cardId ? `${base}?task=${encodeURIComponent(n.cardId)}` : base;
}
