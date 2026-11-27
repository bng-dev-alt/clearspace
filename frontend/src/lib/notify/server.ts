import { createHash, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateCaller, HttpError } from '../collab/invitationServer';
import { open } from '../google/crypto';
import { anyNotifyEnabled, channelAad, notifyPilotAllows, notifyConfig, providerEnabled, type NotifyConfig, type NotifyProvider, type SlackConfig, type TelegramConfig } from './config';
import { renderMessage, type DeliveryItem } from './message';
import { slackSend, telegramSend, type Outcome } from './providers';

/** Shared server plumbing for /api/notify/* (RUN 05). Route handlers only. */
export const MSG = {
  disabled: 'Oznámení mimo aplikaci nejsou na tomto serveru zapnutá.',
  slack_disabled: 'Propojení se Slackem není na serveru zapnuté.',
  telegram_disabled: 'Propojení s Telegramem není na serveru zapnuté.',
  not_configured: 'Oznámení mimo aplikaci nejsou na serveru nastavená.',
  unavailable: 'Služba je dočasně nedostupná. Zkuste to prosím později.',
  not_connected: 'Kanál není připojený.',
  invalid: 'Neplatný požadavek.',
  pilot: 'Oznámení do Slacku a Telegramu jsou zatím v pilotním provozu jen pro vybrané účty.',
} as const;

/** The signed-in caller of a user-facing notify route; outside the pilot allowlist (NOTIFY_PILOT_USER_IDS) -> 403. */
export async function notifyCaller(authorization: string | null) {
  const c = await authenticateCaller(authorization, 'Oznámení vyžadují připojenou databázi.');
  if (!notifyPilotAllows(c.userId)) throw new HttpError(403, MSG.pilot, 'forbidden');
  return c;
}

/** Structured log: whitelisted fields only (phases, codes, counts). Never tokens, chat/user/team ids, message texts or provider bodies. */
type LogValue = string | number | boolean | null | undefined;
export function notifyLog(phase: string, fields: Record<string, LogValue> = {}): void {
  const safe: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && (v.length > 64 || !/^[A-Za-z0-9_.:-]*$/.test(v))) continue;
    safe[k] = v;
  }
  console.info(JSON.stringify({ evt: 'notify', phase, ...safe }));
}

/** At least one provider switched on AND the shared configuration valid. The switch is checked FIRST (production: both off). */
export function requireNotify(): NotifyConfig {
  if (!anyNotifyEnabled()) throw new HttpError(503, MSG.disabled, 'notify_disabled');
  const cfg = notifyConfig();
  if ('error' in cfg) {
    notifyLog('config_invalid');
    throw new HttpError(503, MSG.not_configured, 'not_configured');
  }
  return cfg;
}
export function requireSlack(): { cfg: NotifyConfig; slack: SlackConfig } {
  if (!providerEnabled('slack')) throw new HttpError(503, MSG.slack_disabled, 'slack_disabled');
  const cfg = requireNotify();
  if ('error' in cfg.slack) throw new HttpError(503, cfg.slack.error, 'slack_not_configured');
  return { cfg, slack: cfg.slack };
}
export function requireTelegram(): { cfg: NotifyConfig; telegram: TelegramConfig } {
  if (!providerEnabled('telegram')) throw new HttpError(503, MSG.telegram_disabled, 'telegram_disabled');
  const cfg = requireNotify();
  if ('error' in cfg.telegram) throw new HttpError(503, cfg.telegram.error, 'telegram_not_configured');
  return { cfg, telegram: cfg.telegram };
}
export const parseProvider = (v: unknown): NotifyProvider => {
  if (v === 'slack' || v === 'telegram') return v;
  throw new HttpError(400, MSG.invalid, 'invalid');
};

/** One RPC row (or null). */
export async function rpcRow<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return ((Array.isArray(data) ? data[0] : data) as T | undefined) ?? null;
}

// ------------------------------------------------------------------ credentials
interface SlackSecret { botToken: string; userId: string }
interface TelegramSecret { chatId: number }
export function openSecret(cfg: NotifyConfig, provider: 'slack', channelId: string, env: string): SlackSecret;
export function openSecret(cfg: NotifyConfig, provider: 'telegram', channelId: string, env: string): TelegramSecret;
export function openSecret(cfg: NotifyConfig, provider: NotifyProvider, channelId: string, env: string): SlackSecret | TelegramSecret;
export function openSecret(cfg: NotifyConfig, provider: NotifyProvider, channelId: string, env: string): SlackSecret | TelegramSecret {
  const v = JSON.parse(open(cfg.keys, env, channelAad(provider, channelId))) as SlackSecret & TelegramSecret;
  if (provider === 'slack' ? !(typeof v.botToken === 'string' && typeof v.userId === 'string') : typeof v.chatId !== 'number') throw new Error('bad_secret');
  return v;
}

/** Send one text with a channel's own credential. Undecryptable credential = the user must reconnect. */
export async function sendWith(cfg: NotifyConfig, provider: NotifyProvider, channelId: string, secretEnv: string, text: string): Promise<Outcome> {
  let secret: SlackSecret | TelegramSecret;
  try { secret = openSecret(cfg, provider, channelId, secretEnv); } catch { return { outcome: 'reconnect', code: 'undecryptable' }; }
  if (provider === 'slack') {
    if ('error' in cfg.slack) return { outcome: 'retry', code: 'slack_not_configured' };
    return slackSend(cfg.slack, (secret as SlackSecret).botToken, (secret as SlackSecret).userId, text);
  }
  if ('error' in cfg.telegram) return { outcome: 'retry', code: 'telegram_not_configured' };
  return telegramSend(cfg.telegram, (secret as TelegramSecret).chatId, text);
}

// ------------------------------------------------------------------ dispatcher (called by the database scheduler)
/** Constant-time check of the scheduler's x-notify-secret header against NOTIFY_SERVER_SECRET. */
export function schedulerAuthorized(header: string | null, cfg: Pick<NotifyConfig, 'serverSecret'>): boolean {
  if (!header) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(cfg.serverSecret).digest();
  return timingSafeEqual(a, b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = new Set(['assignment', 'mention', 'comment', 'project_added', 'project_role_changed', 'project_removed', 'task_completed', 'task_due_changed', 'due_soon']);
const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);

/** Validate one item of the scheduler's batch (shape only: the database already re-checked access, state and preferences). */
export function parseItem(raw: unknown): DeliveryItem | null {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !UUID.test(o.id) || typeof o.channelId !== 'string' || !UUID.test(o.channelId)) return null;
  if (o.provider !== 'slack' && o.provider !== 'telegram') return null;
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind) || typeof o.secret !== 'string' || o.secret.length > 4096) return null;
  return {
    id: o.id, provider: o.provider, channelId: o.channelId, secret: o.secret, kind: o.kind as DeliveryItem['kind'],
    attempt: typeof o.attempt === 'number' ? o.attempt : 1,
    actor: str(o.actor, 300), title: str(o.title, 1000), projectName: str(o.projectName, 1000),
    projectId: str(o.projectId, 200), cardId: str(o.cardId, 200),
    dueDate: typeof o.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate) ? o.dueDate : null,
    newDue: str(o.newDue, 40), hideTitles: o.hideTitles === true,
  };
}

export interface ItemResult { id: string; outcome: Outcome['outcome'] | 'release' | 'cancelled'; code?: string; retryAfter?: number }

export const MIN_GAP_MS = 1100;            // providers: about one message per second per chat / channel
export const RUN_BUDGET_MS = 45_000;       // the database waits up to 60 s for the answer

/**
 * Send one batch: sequential, at least MIN_GAP_MS between two messages to the same channel, within the time budget. A channel that
 * answered 429 or reconnect/blocked gets no further message in this run (its remaining items are released / cancelled by the DB).
 */
export async function sendBatch(cfg: NotifyConfig, items: DeliveryItem[], now: Date, opts: { sleep?: (ms: number) => Promise<void>; clock?: () => number } = {}): Promise<ItemResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const lastSent = new Map<string, number>();
  const stopped = new Map<string, { retryAfter?: number; dead?: boolean }>();
  const results: ItemResult[] = [];
  for (const item of items) {
    if (!providerEnabled(item.provider)) { results.push({ id: item.id, outcome: 'cancelled', code: 'provider_disabled' }); continue; }
    const stop = stopped.get(item.channelId);
    if (stop?.dead) { results.push({ id: item.id, outcome: 'cancelled', code: 'channel_inactive' }); continue; }
    if (stop) { results.push({ id: item.id, outcome: 'release', code: 'rate_limited', retryAfter: stop.retryAfter }); continue; }
    if (clock() - started > RUN_BUDGET_MS) { results.push({ id: item.id, outcome: 'release', code: 'run_budget' }); continue; }
    const last = lastSent.get(item.channelId);
    if (last !== undefined && clock() - last < MIN_GAP_MS) await sleep(MIN_GAP_MS - (clock() - last));
    const out = await sendWith(cfg, item.provider, item.channelId, item.secret, renderMessage(item, cfg.appBaseUrl, now));
    lastSent.set(item.channelId, clock());
    if (out.outcome === 'sent') results.push({ id: item.id, outcome: 'sent' });
    else {
      results.push({ id: item.id, outcome: out.outcome, code: out.code, retryAfter: 'retryAfter' in out ? out.retryAfter : undefined });
      if (out.outcome === 'retry' && out.code.endsWith('rate_limited')) stopped.set(item.channelId, { retryAfter: out.retryAfter });
      if (out.outcome === 'reconnect' || out.outcome === 'blocked') stopped.set(item.channelId, { dead: true });
    }
  }
  return results;
}
