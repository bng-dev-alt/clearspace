import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../collab/invitationServer';
import { open, seal } from '../google/crypto';
import { hubAad, hubAnyEnabled, hubConfig, hubKey, hubProviderEnabled, type HubConfig, type HubProvider, type HubSlack, type HubTelegram } from './config';

/** Shared server plumbing for /api/hub/* (RUN 07). Route handlers only. */
export const HUB_MSG = {
  disabled: 'Propojení projektů s komunikačními nástroji není na tomto serveru zapnuté.',
  slack_disabled: 'Slack pro projekty není na serveru zapnutý.',
  telegram_disabled: 'Telegram pro projekty není na serveru zapnutý.',
  not_configured: 'Propojení projektů s komunikačními nástroji není na serveru nastavené.',
  invalid: 'Neplatný požadavek.',
  unavailable: 'Služba je dočasně nedostupná. Zkuste to prosím později.',
} as const;

/** Whitelisted structured log: phases, codes, counts. Never tokens, ids, message texts, names or payloads. */
type LogValue = string | number | boolean | null | undefined;
export function hubLog(phase: string, fields: Record<string, LogValue> = {}): void {
  const safe: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && (v.length > 48 || !/^[A-Za-z0-9_.:-]*$/.test(v))) continue;
    safe[k] = v;
  }
  console.info(JSON.stringify({ evt: 'hub', phase, ...safe }));
}

export function requireHub(): HubConfig {
  if (!hubAnyEnabled()) throw new HttpError(503, HUB_MSG.disabled, 'hub_disabled');
  const cfg = hubConfig();
  if ('error' in cfg) { hubLog('config_invalid'); throw new HttpError(503, HUB_MSG.not_configured, 'not_configured'); }
  return cfg;
}
export function requireHubSlack(): { cfg: HubConfig; slack: HubSlack } {
  if (!hubProviderEnabled('slack')) throw new HttpError(503, HUB_MSG.slack_disabled, 'hub_slack_disabled');
  const cfg = requireHub();
  if ('error' in cfg.slack) throw new HttpError(503, cfg.slack.error, 'hub_slack_not_configured');
  return { cfg, slack: cfg.slack };
}
export function requireHubTelegram(): { cfg: HubConfig; telegram: HubTelegram } {
  if (!hubProviderEnabled('telegram')) throw new HttpError(503, HUB_MSG.telegram_disabled, 'hub_telegram_disabled');
  const cfg = requireHub();
  if ('error' in cfg.telegram) throw new HttpError(503, cfg.telegram.error, 'hub_telegram_not_configured');
  return { cfg, telegram: cfg.telegram };
}
export const parseHubProvider = (v: unknown): HubProvider => {
  if (v === 'slack' || v === 'telegram') return v;
  throw new HttpError(400, HUB_MSG.invalid, 'invalid');
};
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ------------------------------------------------------------------ credentials (sealed references)
export interface SlackChannelRef { teamId: string; channelId: string }
export interface TelegramChatRef { chatId: number }
export interface SlackInstallSecret { botToken: string; botUserId: string; appId: string }
export const sealRef = (cfg: Pick<HubConfig, 'keys'>, purpose: 'destination' | 'installation', id: string, value: unknown) => seal(cfg.keys, JSON.stringify(value), hubAad(purpose, id));
export function openRef<T>(cfg: Pick<HubConfig, 'keys'>, purpose: 'destination' | 'installation', id: string, env: string): T {
  return JSON.parse(open(cfg.keys, env, hubAad(purpose, id))) as T;
}

// ------------------------------------------------------------------ service principal (webhooks have no user session)
let cached: { token: string; exp: number; email: string } | null = null;
/**
 * Signs in as the dedicated service principal (password grant) and caches the session in this warm instance. The database refuses every
 * hub_svc_* call unless the caller IS the registered principal AND presents the server secret (D4); the principal has no project rights.
 */
export async function serviceDb(cfg: HubConfig): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new HttpError(503, HUB_MSG.not_configured, 'not_configured');
  if (!cached || cached.email !== cfg.serviceEmail || cached.exp < Date.now() + 120_000) {
    const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await auth.auth.signInWithPassword({ email: cfg.serviceEmail, password: cfg.servicePassword });
    if (error || !data.session) { hubLog('service_signin_failed'); throw new HttpError(503, HUB_MSG.unavailable, 'service_unavailable'); }
    cached = { token: data.session.access_token, exp: (data.session.expires_at ?? 0) * 1000, email: cfg.serviceEmail };
  }
  return createClient(url, anon, { global: { headers: { Authorization: `Bearer ${cached.token}` } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
export async function svc<T = unknown>(db: SupabaseClient, cfg: HubConfig, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, { p_server_secret: cfg.serverSecret, ...args });
  if (error?.code === 'PT429') throw new HttpError(429, error.message, 'rate_limited');
  if (error) { hubLog('svc_error', { fn, code: error.code }); throw new HttpError(503, HUB_MSG.unavailable, 'db'); }
  return data as T;
}

// ------------------------------------------------------------------ request authenticity
const safeEq = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest(), y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};
/** Slack: v0=HMAC-SHA256(signing secret, "v0:{ts}:{raw body}") over the RAW body, timestamp within 5 minutes (replay window). */
export function verifySlack(signingSecret: string, headers: Headers, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const ts = headers.get('x-slack-request-timestamp') ?? '', sig = headers.get('x-slack-signature') ?? '';
  if (!/^[0-9]{9,11}$/.test(ts) || !/^v0=[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(nowSec - Number(ts)) > 300) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
  return safeEq(expected, sig);
}
export const verifyTelegram = (webhookSecret: string, headers: Headers) => {
  const h = headers.get('x-telegram-bot-api-secret-token') ?? '';
  return h.length > 0 && safeEq(h, webhookSecret);
};
export const verifyScheduler = (secret: string, headers: Headers) => {
  const h = headers.get('x-hub-secret') ?? '';
  return h.length > 0 && safeEq(h, secret);
};
export const MAX_INBOUND_BYTES = 256 * 1024;
/** Raw body with a hard BYTE cap: Content-Length is refused before reading; the stream is cut off past the cap (no unbounded buffering). */
export async function readRaw(req: Request): Promise<string> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_INBOUND_BYTES) throw new HttpError(413, 'Požadavek je příliš velký.', 'too_large');
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INBOUND_BYTES) { await reader.cancel().catch(() => undefined); throw new HttpError(413, 'Požadavek je příliš velký.', 'too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ------------------------------------------------------------------ opaque routing keys (HMAC; never raw provider ids in the database)
export const keys = (secret: string) => ({
  slackTeam: (team: string) => hubKey(secret, 'slack', 'team', team),
  slackChannel: (team: string, ch: string) => hubKey(secret, 'slack', 'channel', team, ch),
  slackUser: (team: string, user: string) => hubKey(secret, 'slack', 'user', team, user),
  slackMsg: (team: string, ch: string, ts: string) => hubKey(secret, 'slack', 'msg', team, ch, ts),
  slackThread: (team: string, ch: string, ts: string) => hubKey(secret, 'slack', 'thread', team, ch, ts),
  tgChat: (chat: number) => hubKey(secret, 'telegram', 'chat', chat),
  tgUser: (user: number) => hubKey(secret, 'telegram', 'user', user),
  tgMsg: (chat: number, msg: number) => hubKey(secret, 'telegram', 'msg', chat, msg),
  tgThread: (chat: number, msg: number) => hubKey(secret, 'telegram', 'thread', chat, msg),
});

export interface ResolvedDestination {
  id: string; projectId: string; projectName: string; status: string; label: string; notify: boolean; interactive: boolean; intelligence: boolean; fullIngest: boolean;
  extRefEnc: string; installationId: string | null;
}
/** Linking codes are typed by hand: case and spaces do not matter. */
export const normCode = (raw: string) => raw.replace(/[\s-]/g, '').toUpperCase();
export const LINK_REASON: Record<string, string> = {
  code_invalid: 'Kód je neplatný, vypršel nebo už byl použit. Vytvořte v ClearSpace nový (Projekt → Integrace).',
  issuer_not_manager: 'Kód vydal někdo, kdo už projekt nespravuje. Vytvořte nový kód.',
  already_linked_here: 'Tento kanál / skupina už je s projektem propojená.',
  linked_elsewhere: 'Tento kanál / skupina už je propojená s jiným projektem. Jeden kanál může patřit jen jednomu projektu.',
};
export const TASK_REASON: Record<string, string> = {
  identity_unlinked: 'Nejdřív propojte svůj účet: v ClearSpace → Nastavení → Slack a Telegram pro projekty si vytvořte kód a pošlete ho odsud (Slack: /clearspace ucet KÓD, Telegram: odkaz z Nastavení).',
  card_moved: 'Úkol z této zprávy už existuje, ale byl přesunut do jiného projektu.',
  no_edit_right: 'V tomto projektu nemáte právo vytvářet úkoly.',
  destination_inactive: 'Kanál není s projektem aktivně propojený (čeká na potvrzení, nebo byl odpojen).',
  interactive_off: 'Vytváření úkolů z chatu je pro tento kanál vypnuté (Projekt → Integrace → Interaktivní).',
  invalid_input: 'Název úkolu je prázdný nebo příliš dlouhý (max. 200 znaků).',
  no_column: 'Projekt nemá žádný sloupec.',
};
/** 10 characters from an unambiguous alphabet (~50 bits): typed by hand, single use, 10 minutes, rate-limited. */
export function humanCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
}
