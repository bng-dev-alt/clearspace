import type { SlackConfig, TelegramConfig } from './config';
import { slackEscape } from './message';

/**
 * Slack Web API + Telegram Bot API over fetch (RUN 05; no SDK, no new dependency). Every function returns a CLASSIFIED outcome with a
 * short code; provider response bodies, tokens and URLs (the Telegram URL contains the bot token) are never logged or returned.
 *
 *   sent       -- accepted by the provider
 *   retry      -- certainly not delivered, try later (5xx, 429 with Retry-After, connection refused / DNS, server-side config)
 *   failed     -- give up for this message (bad request, or AMBIGUOUS: a timeout after the request left -> at most once)
 *   reconnect  -- the channel credential is unusable (revoked, uninstalled, cannot DM) -> the user must reconnect
 *   blocked    -- the user blocked the Telegram bot
 */
export type Outcome =
  | { outcome: 'sent' }
  | { outcome: 'retry'; code: string; retryAfter?: number }
  | { outcome: 'failed'; code: string }
  | { outcome: 'reconnect'; code: string }
  | { outcome: 'blocked'; code: string };

export const TIMEOUT_MS = 10_000;
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

type Http = { ok: true; res: Response } | { ok: false; outcome: Outcome };

/** fetch with a hard timeout. A timeout = the request may have arrived -> ambiguous (failed). Refused / DNS = certainly not sent (retry). */
export async function http(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Http> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return { ok: true, res: await fetch(url, { ...init, signal: ctl.signal, redirect: 'error', cache: 'no-store' }) };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, outcome: { outcome: 'failed', code: 'ambiguous_timeout' } };
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code && NOT_SENT_CODES.has(code)) return { ok: false, outcome: { outcome: 'retry', code: 'network' } };
    return { ok: false, outcome: { outcome: 'failed', code: 'ambiguous_network' } };
  } finally {
    clearTimeout(t);
  }
}

const retryAfter = (raw: string | null | undefined): number | undefined => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 86_400) : undefined;
};
const code = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) : 'unknown') || 'unknown';

// ------------------------------------------------------------------ Slack
const SLACK_RECONNECT = new Set(['invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'not_authed', 'channel_not_found',
  'user_not_found', 'missing_scope', 'no_permission', 'team_access_not_granted', 'org_login_required', 'ekm_access_denied', 'not_allowed_token_type']);
const SLACK_RETRY = new Set(['ratelimited', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

export function classifySlack(status: number, body: { ok?: boolean; error?: string } | null, retryAfterHeader: string | null): Outcome {
  if (status === 429) return { outcome: 'retry', code: 'slack_rate_limited', retryAfter: retryAfter(retryAfterHeader) ?? 30 };
  if (status >= 500) return { outcome: 'retry', code: `slack_http_${status}` };
  if (body?.ok === true) return { outcome: 'sent' };
  const e = code(body?.error);
  if (SLACK_RETRY.has(e)) return { outcome: 'retry', code: `slack_${e}`, retryAfter: retryAfter(retryAfterHeader) };
  if (SLACK_RECONNECT.has(e)) return { outcome: 'reconnect', code: `slack_${e}` };
  return { outcome: 'failed', code: `slack_${e}` };
}

async function slackJson(res: Response): Promise<{ ok?: boolean; error?: string; [k: string]: unknown } | null> {
  try { return await res.json() as { ok?: boolean; error?: string }; } catch { return null; }
}

/** A direct message to the user who connected: chat.postMessage to the user id (the app's Messages tab; Slack opens the DM). */
export async function slackSend(cfg: Pick<SlackConfig, 'api'>, botToken: string, userId: string, text: string): Promise<Outcome> {
  const r = await http(`${cfg.api}/chat.postMessage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: userId, text: slackEscape(text), mrkdwn: false, unfurl_links: false, unfurl_media: false }),
  });
  if (!r.ok) return r.outcome;
  return classifySlack(r.res.status, await slackJson(r.res), r.res.headers.get('retry-after'));
}

export interface SlackGrant { botToken: string; userId: string; teamId: string; teamName: string; scopes: string[] }

/** oauth.v2.access. Refuses anything but a bot token for one workspace with exactly the scopes asked for (+ nothing user-level). */
export async function slackExchange(cfg: SlackConfig, code: string): Promise<{ ok: true; grant: SlackGrant } | { ok: false; reason: string }> {
  const r = await http(`${cfg.api}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ code, redirect_uri: cfg.redirectUri }).toString(),
  });
  if (!r.ok) return { ok: false, reason: 'unavailable' };
  if (r.res.status >= 500 || r.res.status === 429) return { ok: false, reason: 'unavailable' };
  const b = await slackJson(r.res) as { ok?: boolean; error?: string; token_type?: string; access_token?: string; scope?: string;
    is_enterprise_install?: boolean; team?: { id?: string; name?: string } | null; authed_user?: { id?: string; access_token?: string } } | null;
  if (!b?.ok) return { ok: false, reason: b?.error === 'invalid_code' || b?.error === 'code_already_used' ? 'expired' : 'error' };
  const scopes = (b.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (b.token_type !== 'bot' || !/^xoxb-[A-Za-z0-9-]{10,250}$/.test(b.access_token ?? '')) return { ok: false, reason: 'error' };
  if (b.is_enterprise_install || !b.team?.id || !/^T[A-Z0-9]{2,30}$/.test(b.team.id)) return { ok: false, reason: 'unsupported' };
  if (!/^[UW][A-Z0-9]{2,30}$/.test(b.authed_user?.id ?? '')) return { ok: false, reason: 'error' };
  if (b.authed_user?.access_token) return { ok: false, reason: 'error' };          // we never ask for user scopes
  if (!scopes.includes('chat:write') || scopes.some((s) => s !== 'chat:write')) return { ok: false, reason: 'scope' };
  return { ok: true, grant: { botToken: b.access_token!, userId: b.authed_user!.id!, teamId: b.team.id, teamName: b.team.name ?? 'Slack', scopes } };
}

export async function slackRevoke(cfg: Pick<SlackConfig, 'api'>, botToken: string): Promise<boolean> {
  const r = await http(`${cfg.api}/auth.revoke`, { method: 'POST', headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  if (!r.ok) return false;
  const b = await slackJson(r.res);
  return b?.ok === true || b?.error === 'invalid_auth' || b?.error === 'token_revoked';
}

export function slackAuthorizeUrl(cfg: SlackConfig, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, scope: 'chat:write', redirect_uri: cfg.redirectUri, state });
  return `${cfg.authorize}?${q.toString()}`;
}

// ------------------------------------------------------------------ Telegram
export function classifyTelegram(status: number, body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } | null): Outcome {
  if (body?.ok === true && status === 200) return { outcome: 'sent' };
  if (status === 429) return { outcome: 'retry', code: 'telegram_rate_limited', retryAfter: retryAfter(String(body?.parameters?.retry_after ?? '')) ?? 30 };
  if (status >= 500) return { outcome: 'retry', code: `telegram_http_${status}` };
  if (status === 403) return { outcome: 'blocked', code: 'telegram_blocked' };
  // 401 / 404 = the BOT token is wrong (server configuration), not this user's channel: retry later, never punish the channel
  if (status === 401 || status === 404) return { outcome: 'retry', code: 'telegram_bot_auth' };
  if (status === 400 && /chat not found|user not found|chat_id is empty|PEER_ID_INVALID/i.test(body?.description ?? '')) return { outcome: 'reconnect', code: 'telegram_chat_not_found' };
  return { outcome: 'failed', code: `telegram_http_${status}` };
}

async function tgCall(cfg: Pick<TelegramConfig, 'api' | 'botToken'>, method: string, payload: unknown, timeoutMs = TIMEOUT_MS) {
  return http(`${cfg.api}/bot${cfg.botToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, timeoutMs);
}

export async function telegramSend(cfg: Pick<TelegramConfig, 'api' | 'botToken'>, chatId: number | string, text: string): Promise<Outcome> {
  const r = await tgCall(cfg, 'sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  if (!r.ok) return r.outcome;
  let body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } | null = null;
  try { body = await r.res.json(); } catch { /* not JSON */ }
  return classifyTelegram(r.res.status, body);
}

export interface TelegramStart { updateId: number; chatId: number; token: string | null; label: string }

/** Pending /start messages in PRIVATE chats (everything else is ignored). Confirms what it read (offset), so nothing is read twice. */
export async function telegramStarts(cfg: Pick<TelegramConfig, 'api' | 'botToken'>): Promise<{ ok: true; starts: TelegramStart[] } | { ok: false }> {
  const r = await tgCall(cfg, 'getUpdates', { timeout: 0, limit: 100, allowed_updates: ['message'] });
  if (!r.ok || r.res.status !== 200) return { ok: false };
  let body: { ok?: boolean; result?: Array<{ update_id: number; message?: { text?: string; chat?: { id?: number; type?: string }; from?: { first_name?: string; last_name?: string; username?: string; is_bot?: boolean } } }> } | null = null;
  try { body = await r.res.json(); } catch { return { ok: false }; }
  if (!body?.ok || !Array.isArray(body.result)) return { ok: false };
  const starts: TelegramStart[] = [];
  let max = -1;
  for (const u of body.result) {
    if (typeof u.update_id === 'number') max = Math.max(max, u.update_id);
    const m = u.message;
    if (!m || m.chat?.type !== 'private' || typeof m.chat.id !== 'number' || m.from?.is_bot) continue;
    const text = (m.text ?? '').trim();
    if (!/^\/start(@[A-Za-z0-9_]+)?(\s|$)/.test(text)) continue;
    const tok = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{20,64})$/.exec(text)?.[1] ?? null;
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ').trim();
    const label = `${name || 'Telegram'}${m.from?.username ? ` (@${m.from.username})` : ''}`;
    starts.push({ updateId: u.update_id, chatId: m.chat.id, token: tok, label });
  }
  if (max >= 0) await tgCall(cfg, 'getUpdates', { offset: max + 1, limit: 1, timeout: 0 });   // confirm
  return { ok: true, starts };
}
