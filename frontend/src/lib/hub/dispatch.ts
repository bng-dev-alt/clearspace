import { clean, czechDate, pragueDate } from '../notify/message';
import { hubProviderEnabled, type HubConfig, type HubProvider } from './config';
import { slackPost, telegramPost, type HubOutcome, type Sent } from './providers';
import { openRef, type SlackChannelRef, type SlackInstallSecret, type TelegramChatRef } from './server';

/**
 * Outbound project messages (RUN 07, D10). Plain text, Czech. A notification carries ONLY the event, task title, project, column and a link
 * -- never descriptions, files or other integrations' data. Comment sync carries the comment (the destination's members chose to link
 * that task conversation). Several notifications for one destination in one run become ONE digest (max 10 lines).
 */
export type HubKind = 'task_created' | 'task_completed' | 'status_changed' | 'due_soon' | 'comment_sync' | 'test';
export interface HubItem {
  id: string; destinationId: string; provider: HubProvider; extRef: string; installationId: string | null; installation: string | null;
  kind: HubKind; attempt: number; cardId: string | null; title: string | null; projectId: string | null; projectName: string | null;
  column: string | null; actor: string | null; comment: string | null; commentAuthor: string | null; threadRef: string | null; dueDate: string | null;
}
export interface HubResult { id: string; outcome: HubOutcome['outcome'] | 'release' | 'cancelled'; code?: string; retryAfter?: number }

export const DIGEST_MAX_LINES = 10;
export const MIN_GAP_MS = 1100;
export const RUN_BUDGET_MS = 45_000;

export const taskHref = (base: string, projectId: string, cardId?: string | null) =>
  `${base}/projects/${encodeURIComponent(projectId)}${cardId ? `?task=${encodeURIComponent(cardId)}` : ''}`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** One line for a notification item (no project header, no link). */
export function line(it: HubItem, now: Date): string {
  const title = `„${clean(it.title, 150)}"`, actor = clean(it.actor, 80) || 'Někdo', col = clean(it.column, 60);
  switch (it.kind) {
    case 'task_created': return `${actor} vytvořil(a) úkol ${title}.`;
    case 'task_completed': return `${actor} dokončil(a) úkol ${title}.`;
    case 'status_changed': return col ? `${actor} přesunul(a) úkol ${title} do „${col}".` : `${actor} změnil(a) stav úkolu ${title}.`;
    case 'due_soon': {
      const today = pragueDate(now);
      const when = it.dueDate === today ? 'Dnes' : it.dueDate === addDays(today, 1) ? 'Zítra' : 'Brzy';
      return `${when} (${czechDate(it.dueDate ?? '')}) je termín úkolu ${title}.`;
    }
    default: return '';
  }
}

export const TEST_TEXT = (project: string) => `ClearSpace · ${clean(project, 120)}\nZkušební zpráva – oznámení projektu budou chodit sem.`;

/** One message per item group: a single notification, a digest, a comment into a thread, or the test message. */
export function render(items: HubItem[], base: string, now: Date): string {
  const first = items[0];
  const project = clean(first.projectName, 120);
  if (first.kind === 'test') return TEST_TEXT(project);
  if (first.kind === 'comment_sync') {
    return `Komentář v ClearSpace – ${clean(first.commentAuthor, 80) || 'člen projektu'}:\n${clean(first.comment, 1500)}\nÚkol: ${taskHref(base, first.projectId ?? '', first.cardId)}`;
  }
  if (items.length === 1) return `ClearSpace · ${project}\n${line(first, now)}\nOtevřít: ${taskHref(base, first.projectId ?? '', first.cardId)}`;
  const shown = items.slice(0, DIGEST_MAX_LINES).map((i) => `• ${line(i, now)}`);
  const more = items.length - shown.length;
  return [`ClearSpace · ${project} – ${items.length} změn`, ...shown, ...(more > 0 ? [`… a ${more} dalších`] : []), `Projekt: ${taskHref(base, first.projectId ?? '')}`].join('\n');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set<HubKind>(['task_created', 'task_completed', 'status_changed', 'due_soon', 'comment_sync', 'test']);
const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);

/** Shape check of one scheduler item (the database already re-checked state, capability and loops). */
export function parseHubItem(raw: unknown): HubItem | null {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || !UUID.test(String(o.id)) || !UUID.test(String(o.destinationId))) return null;
  if ((o.provider !== 'slack' && o.provider !== 'telegram') || !KINDS.has(o.kind as HubKind) || !s(o.extRef, 4096)) return null;
  return {
    id: o.id as string, destinationId: o.destinationId as string, provider: o.provider, extRef: o.extRef as string,
    installationId: typeof o.installationId === 'string' && UUID.test(o.installationId) ? o.installationId : null, installation: s(o.installation, 4096),
    kind: o.kind as HubKind, attempt: typeof o.attempt === 'number' ? o.attempt : 1, cardId: s(o.cardId, 200), title: s(o.title, 1000),
    projectId: s(o.projectId, 200), projectName: s(o.projectName, 1000), column: s(o.column, 300), actor: s(o.actor, 300), comment: s(o.comment, 4000),
    commentAuthor: s(o.commentAuthor, 300), threadRef: typeof o.threadRef === 'string' && /^[0-9.]{1,40}$/.test(o.threadRef) ? o.threadRef : null,
    dueDate: typeof o.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate) ? o.dueDate : null,
  };
}

/** Send one text to a destination (decrypting its sealed reference; Slack also the workspace token). */
export async function sendTo(cfg: HubConfig, it: Pick<HubItem, 'provider' | 'destinationId' | 'extRef' | 'installationId' | 'installation'>, text: string, threadRef?: string | null): Promise<Sent> {
  try {
    if (it.provider === 'slack') {
      if ('error' in cfg.slack) return { result: { outcome: 'retry', code: 'slack_not_configured' } };
      if (!it.installation || !it.installationId) return { result: { outcome: 'reconnect', code: 'slack_not_installed' } };
      const ref = openRef<SlackChannelRef>(cfg, 'destination', it.destinationId, it.extRef);
      const sec = openRef<SlackInstallSecret>(cfg, 'installation', it.installationId, it.installation);
      return await slackPost(cfg.slack, sec.botToken, ref.channelId, text, threadRef ?? undefined);
    }
    if ('error' in cfg.telegram) return { result: { outcome: 'retry', code: 'telegram_not_configured' } };
    const ref = openRef<TelegramChatRef>(cfg, 'destination', it.destinationId, it.extRef);
    return await telegramPost(cfg.telegram, ref.chatId, text, threadRef ? Number(threadRef) : undefined);
  } catch {
    return { result: { outcome: 'reconnect', code: 'undecryptable' } };
  }
}

/**
 * Send one scheduler batch. Notifications are grouped per destination into one digest; comments and tests go one by one (threaded).
 * At least MIN_GAP_MS between two messages to the same destination; a destination that answered 429 / removed / revoked gets nothing more.
 */
export async function sendHubBatch(cfg: HubConfig, items: HubItem[], now: Date, opts: { sleep?: (ms: number) => Promise<void>; clock?: () => number } = {}): Promise<HubResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const groups: HubItem[][] = [];
  const digest = new Map<string, HubItem[]>();
  for (const it of items) {
    if (it.kind === 'comment_sync' || it.kind === 'test') { groups.push([it]); continue; }
    const g = digest.get(it.destinationId);
    if (g) g.push(it); else { const n = [it]; digest.set(it.destinationId, n); groups.push(n); }
  }
  const last = new Map<string, number>();
  const stopped = new Map<string, { retryAfter?: number; dead?: boolean }>();
  const results: HubResult[] = [];
  const all = (g: HubItem[], r: Omit<HubResult, 'id'>) => g.forEach((i) => results.push({ id: i.id, ...r }));
  for (const g of groups) {
    const d = g[0].destinationId;
    if (!hubProviderEnabled(g[0].provider)) { all(g, { outcome: 'cancelled', code: 'provider_disabled' }); continue; }
    const stop = stopped.get(d);
    if (stop?.dead) { all(g, { outcome: 'cancelled', code: 'destination_inactive' }); continue; }
    if (stop) { all(g, { outcome: 'release', code: 'rate_limited', retryAfter: stop.retryAfter }); continue; }
    if (clock() - started > RUN_BUDGET_MS) { all(g, { outcome: 'release', code: 'run_budget' }); continue; }
    const prev = last.get(d);
    if (prev !== undefined && clock() - prev < MIN_GAP_MS) await sleep(MIN_GAP_MS - (clock() - prev));
    const { result } = await sendTo(cfg, g[0], render(g, cfg.appBaseUrl, now), g[0].kind === 'comment_sync' ? g[0].threadRef : null);
    last.set(d, clock());
    if (result.outcome === 'sent') { all(g, { outcome: 'sent' }); continue; }
    all(g, { outcome: result.outcome, code: result.code, retryAfter: 'retryAfter' in result ? result.retryAfter : undefined });
    if (result.outcome === 'retry' && result.code.endsWith('rate_limited')) stopped.set(d, { retryAfter: result.retryAfter });
    if (['reconnect', 'removed_bot', 'archived', 'blocked'].includes(result.outcome)) stopped.set(d, { dead: true });
  }
  return results;
}
