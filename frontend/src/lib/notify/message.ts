import type { AppNotification, NotificationType } from '../../types/kanban';
import { describeNotification, notificationHref } from '../collab/notificationText';
import type { NotifyProvider } from './config';

/**
 * Text of an external notification (RUN 05). Pure. Czech, like the rest of the app (no i18n system exists). Contains ONLY: event type,
 * actor name, task + project name, due date and a link into ClearSpace -- never comment text, descriptions, files or data of other
 * integrations. "Hide titles" mode: event type + link only. Plain text for both providers (no markup is ever interpreted).
 */
export type DeliveryKind = 'assignment' | 'mention' | 'comment' | 'project_added' | 'project_role_changed' | 'project_removed'
  | 'task_completed' | 'task_due_changed' | 'due_soon';

export interface DeliveryItem {
  id: string;
  provider: NotifyProvider;
  channelId: string;
  secret: string;
  kind: DeliveryKind;
  attempt: number;
  actor: string | null;
  title: string | null;
  projectName: string | null;
  projectId: string | null;
  cardId: string | null;
  dueDate: string | null;
  newDue: string | null;
  hideTitles: boolean;
}

export const KIND_LABEL: Record<DeliveryKind, string> = {
  assignment: 'Byl vám přiřazen úkol.',
  due_soon: 'Blíží se termín vašeho úkolu.',
  mention: 'Někdo vás zmínil v komentáři.',
  comment: 'U vašeho úkolu je nový komentář.',
  task_completed: 'Váš úkol byl označen jako hotový.',
  task_due_changed: 'Termín vašeho úkolu se změnil.',
  project_added: 'Změnilo se vaše členství v projektu.',
  project_role_changed: 'Změnilo se vaše členství v projektu.',
  project_removed: 'Změnilo se vaše členství v projektu.',
};

/** One line of untrusted text: no control / zero-width / bidi characters, collapsed whitespace, bounded length. */
export function clean(value: string | null | undefined, max = 200): string {
  const s = (value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Slack: the only characters that must be escaped are & < > (no <!channel>, <@U…>, <url|text> can come from a task title). */
export const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** YYYY-MM-DD of `now` in the app's time zone (Europe/Prague). */
export function pragueDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function czechDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : iso;
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function itemHref(item: Pick<DeliveryItem, 'kind' | 'projectId' | 'cardId'>): string | null {
  const n = { type: item.kind as NotificationType, projectId: item.projectId ?? undefined, cardId: item.cardId ?? undefined } as AppNotification;
  return notificationHref(n);
}

/** The sentence (without project line and link). */
export function sentence(item: DeliveryItem, now: Date): string {
  if (item.hideTitles) return KIND_LABEL[item.kind];
  const actor = clean(item.actor, 100) || 'Někdo';
  const title = `„${clean(item.title)}"`;   // same quotes as the in-app texts (notificationText.ts)
  switch (item.kind) {
    case 'due_soon': {
      const today = pragueDate(now);
      const when = item.dueDate === today ? 'Dnes' : item.dueDate === addDays(today, 1) ? 'Zítra' : 'Brzy';
      return `${when} (${czechDate(item.dueDate ?? '')}) je termín úkolu ${title}.`;
    }
    case 'task_completed':
      return `${actor} označil(a) váš úkol ${title} jako hotový.`;
    case 'task_due_changed':
      return item.newDue && /^\d{4}-\d{2}-\d{2}$/.test(item.newDue)
        ? `${actor} změnil(a) termín vašeho úkolu ${title} na ${czechDate(item.newDue)}.`
        : `${actor} odebral(a) termín vašeho úkolu ${title}.`;
    default: {
      // the in-app wording (RUN 01), so the bell and the chat say the same thing
      const n = { id: item.id, type: item.kind as NotificationType, actorName: actor, title: clean(item.title), createdAt: now.toISOString() } as AppNotification;
      return `${describeNotification(n)}.`;
    }
  }
}

/** Full plain-text message. */
export function renderMessage(item: DeliveryItem, appBaseUrl: string, now: Date = new Date()): string {
  // RUN 08: no "ClearSpace" header line -- the sender already is the ClearSpace app / bot; the project name leads the sentence
  const project = clean(item.projectName, 120);
  const membership = item.kind === 'project_added' || item.kind === 'project_role_changed' || item.kind === 'project_removed';
  const first = !item.hideTitles && project && !membership ? `${project}: ${sentence(item, now)}` : sentence(item, now);
  const href = itemHref(item);
  return href ? `${first}\nOtevřít: ${appBaseUrl}${href}` : first;
}

export const TEST_MESSAGE = 'Zkušební zpráva – oznámení z ClearSpace sem budou chodit.';
export const TELEGRAM_CONFIRM_MESSAGE = 'Propojení čeká na potvrzení. Dokončete ho v ClearSpace → Nastavení → Oznámení mimo aplikaci.';
export const TELEGRAM_HELP_MESSAGE = 'Tento bot jen doručuje oznámení z ClearSpace. Propojení začněte v ClearSpace → Nastavení → Oznámení mimo aplikaci.';
export const TELEGRAM_BYE_MESSAGE = 'Oznámení z ClearSpace jsou odpojená. Sem už nic chodit nebude.';
