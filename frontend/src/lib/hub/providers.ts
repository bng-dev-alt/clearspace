import { http, type Outcome } from '../notify/providers';
import { slackEscape } from '../notify/message';
import { SLACK_HUB_SCOPES, type HubSlack, type HubTelegram } from './config';

/**
 * Slack Web API + Telegram Bot API for PROJECT destinations (RUN 07), over fetch (no SDK). Classified outcomes with short codes only; provider
 * bodies, tokens and URLs (the Telegram URL holds the bot token) are never logged or returned.
 */
export type HubOutcome = Outcome | { outcome: 'removed_bot'; code: string } | { outcome: 'archived'; code: string };
export interface Sent { result: HubOutcome; ref?: string }

const code = (s: unknown) => (typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) : 'unknown') || 'unknown';
const retryAfter = (raw: unknown): number | undefined => { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), 86_400) : undefined; };

// ------------------------------------------------------------------ Slack
export function classifySlackHub(status: number, body: { ok?: boolean; error?: string } | null, retryHeader: string | null): HubOutcome {
  if (status === 429) return { outcome: 'retry', code: 'slack_rate_limited', retryAfter: retryAfter(retryHeader) ?? 30 };
  if (status >= 500) return { outcome: 'retry', code: `slack_http_${status}` };
  if (body?.ok === true) return { outcome: 'sent' };
  const e = code(body?.error);
  if (['ratelimited', 'rate_limited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'].includes(e)) return { outcome: 'retry', code: `slack_${e}`, retryAfter: retryAfter(retryHeader) };
  if (['invalid_auth', 'account_inactive', 'token_revoked', 'token_expired', 'not_authed', 'missing_scope', 'team_access_not_granted', 'no_permission'].includes(e)) return { outcome: 'reconnect', code: `slack_${e}` };
  if (['not_in_channel', 'channel_not_found'].includes(e)) return { outcome: 'removed_bot', code: `slack_${e}` };
  if (e === 'is_archived') return { outcome: 'archived', code: 'slack_is_archived' };
  return { outcome: 'failed', code: `slack_${e}` };
}
async function slackCall(api: string, method: string, token: string, payload: unknown): Promise<{ result: HubOutcome; body: Record<string, unknown> | null }> {
  const r = await http(`${api}/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
  if (!r.ok) return { result: r.outcome, body: null };
  let body: Record<string, unknown> | null = null;
  try { body = await r.res.json(); } catch { /* not JSON */ }
  return { result: classifySlackHub(r.res.status, body as { ok?: boolean; error?: string } | null, r.res.headers.get('retry-after')), body };
}
/** A plain-text message to a channel (optionally into a thread). Markup off, no unfurling; & < > escaped. */
export async function slackPost(cfg: Pick<HubSlack, 'api'>, token: string, channel: string, text: string, threadTs?: string): Promise<Sent> {
  const { result, body } = await slackCall(cfg.api, 'chat.postMessage', token, { channel, text: slackEscape(text), mrkdwn: false, unfurl_links: false, unfurl_media: false, ...(threadTs ? { thread_ts: threadTs } : {}) });
  return { result, ref: typeof body?.ts === 'string' ? body.ts : undefined };
}
export async function slackPermalink(cfg: Pick<HubSlack, 'api'>, token: string, channel: string, ts: string): Promise<string | null> {
  const r = await http(`${cfg.api}/chat.getPermalink?${new URLSearchParams({ channel, message_ts: ts })}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  try { const b = await r.res.json() as { ok?: boolean; permalink?: string }; return b.ok && typeof b.permalink === 'string' && /^https:\/\//.test(b.permalink) && b.permalink.length <= 500 ? b.permalink : null; } catch { return null; }
}
export async function slackViewsOpen(cfg: Pick<HubSlack, 'api'>, token: string, triggerId: string, view: unknown): Promise<HubOutcome> {
  return (await slackCall(cfg.api, 'views.open', token, { trigger_id: triggerId, view })).result;
}
export async function slackRevoke(cfg: Pick<HubSlack, 'api'>, token: string): Promise<boolean> {
  return (await slackCall(cfg.api, 'auth.revoke', token, {})).result.outcome === 'sent';
}
/** response_url of a signed interaction: only Slack's own hooks host (or the local mock) -- never an arbitrary URL from a payload. */
export function safeResponseUrl(cfg: Pick<HubSlack, 'mock' | 'api'>, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (cfg.mock) return u.origin === new URL(cfg.api).origin ? raw : null;
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com' ? raw : null;
  } catch { return null; }
}
export async function slackRespond(url: string, text: string, replace = false): Promise<void> {
  await http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_type: 'ephemeral', replace_original: replace, text: slackEscape(text) }) });
}

export interface HubSlackGrant { botToken: string; botUserId: string; appId: string; teamId: string; teamName: string; scopes: string[] }
/** oauth.v2.access for the PROJECT app: exactly the requested bot scopes, a bot token, one workspace, no user token, no Enterprise install. */
export async function slackHubExchange(cfg: HubSlack, authCode: string): Promise<{ ok: true; grant: HubSlackGrant } | { ok: false; reason: string }> {
  const r = await http(`${cfg.api}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}` },
    body: new URLSearchParams({ code: authCode, redirect_uri: cfg.redirectUri }).toString(),
  });
  if (!r.ok || r.res.status >= 500 || r.res.status === 429) return { ok: false, reason: 'unavailable' };
  let b: { ok?: boolean; error?: string; token_type?: string; access_token?: string; scope?: string; bot_user_id?: string; app_id?: string;
    is_enterprise_install?: boolean; team?: { id?: string; name?: string } | null; authed_user?: { id?: string; access_token?: string } } | null = null;
  try { b = await r.res.json(); } catch { return { ok: false, reason: 'error' }; }
  if (!b?.ok) return { ok: false, reason: b?.error === 'invalid_code' || b?.error === 'code_already_used' ? 'expired' : 'error' };
  const scopes = (b.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean).sort();
  if (b.token_type !== 'bot' || !/^xoxb-[A-Za-z0-9-]{10,250}$/.test(b.access_token ?? '')) return { ok: false, reason: 'error' };
  if (b.is_enterprise_install || !/^T[A-Z0-9]{2,30}$/.test(b.team?.id ?? '')) return { ok: false, reason: 'unsupported' };
  if (b.authed_user?.access_token) return { ok: false, reason: 'error' };
  if (JSON.stringify(scopes) !== JSON.stringify([...SLACK_HUB_SCOPES].sort())) return { ok: false, reason: 'scope' };
  if (!/^[UBW][A-Z0-9]{2,30}$/.test(b.bot_user_id ?? '') || !/^A[A-Z0-9]{2,30}$/.test(b.app_id ?? '')) return { ok: false, reason: 'error' };
  return { ok: true, grant: { botToken: b.access_token!, botUserId: b.bot_user_id!, appId: b.app_id!, teamId: b.team!.id!, teamName: b.team!.name ?? 'Slack', scopes } };
}
export function slackHubAuthorizeUrl(cfg: HubSlack, state: string): string {
  return `${cfg.authorize}?${new URLSearchParams({ client_id: cfg.clientId, scope: SLACK_HUB_SCOPES.join(','), redirect_uri: cfg.redirectUri, state })}`;
}

// ------------------------------------------------------------------ Telegram
export function classifyTelegramHub(status: number, body: { ok?: boolean; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } } | null): HubOutcome {
  if (body?.ok === true && status === 200) return { outcome: 'sent' };
  if (status === 429) return { outcome: 'retry', code: 'telegram_rate_limited', retryAfter: retryAfter(body?.parameters?.retry_after) ?? 30 };
  if (status >= 500) return { outcome: 'retry', code: `telegram_http_${status}` };
  if (status === 401 || status === 404) return { outcome: 'retry', code: 'telegram_bot_auth' };        // server config, not the group
  if (status === 403) return { outcome: 'removed_bot', code: 'telegram_forbidden' };                    // kicked / not a member
  if (status === 400 && body?.parameters?.migrate_to_chat_id) return { outcome: 'retry', code: 'telegram_migrated', retryAfter: 5 };
  if (status === 400 && /chat not found/i.test(body?.description ?? '')) return { outcome: 'removed_bot', code: 'telegram_chat_not_found' };
  return { outcome: 'failed', code: `telegram_http_${status}` };
}
async function tg(cfg: Pick<HubTelegram, 'api' | 'botToken'>, method: string, payload: unknown) {
  const r = await http(`${cfg.api}/bot${cfg.botToken}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) return { outcome: r.outcome as HubOutcome, status: 0, body: null as Record<string, unknown> | null };
  let body: Record<string, unknown> | null = null;
  try { body = await r.res.json(); } catch { /* not JSON */ }
  return { outcome: classifyTelegramHub(r.res.status, body as never), status: r.res.status, body };
}
/** Plain text (no parse_mode), no link preview, optionally as a reply. */
export async function telegramPost(cfg: Pick<HubTelegram, 'api' | 'botToken'>, chatId: number, text: string, replyTo?: number): Promise<Sent> {
  const t = await tg(cfg, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true },
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
  const id = (t.body?.result as { message_id?: number } | undefined)?.message_id;
  return { result: t.outcome, ref: typeof id === 'number' ? String(id) : undefined };
}
/** Group authority for linking: the sender must be the group's creator or an administrator (the BOT needs no admin rights). */
export async function telegramIsGroupAdmin(cfg: Pick<HubTelegram, 'api' | 'botToken'>, chatId: number, userId: number): Promise<boolean | null> {
  const t = await tg(cfg, 'getChatMember', { chat_id: chatId, user_id: userId });
  if (t.outcome.outcome !== 'sent') return null;
  const st = (t.body?.result as { status?: string } | undefined)?.status;
  return st === 'creator' || st === 'administrator';
}
/** Link to a message of a SUPERGROUP (t.me/c/<id without -100>/<msg>); basic groups have no message links. */
export function telegramMessageLink(chatId: number, messageId: number): string | null {
  const s = String(chatId);
  return s.startsWith('-100') ? `https://t.me/c/${s.slice(4)}/${messageId}` : null;
}
/** Disconnect: the bot leaves the group (best effort; the binding is already gone in ClearSpace). */
export async function telegramLeave(cfg: Pick<HubTelegram, 'api' | 'botToken'>, chatId: number): Promise<boolean> {
  return (await tg(cfg, 'leaveChat', { chat_id: chatId })).outcome.outcome === 'sent';
}

/** "/cmd@bot args" -> { cmd, args } when addressed to THIS bot (or unaddressed); commands for other bots -> null. */
export function parseCommand(text: string, bot: string): { cmd: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || (m[2] && m[2].toLowerCase() !== bot.toLowerCase())) return null;
  return { cmd: m[1].toLowerCase(), args: (m[3] ?? '').trim() };
}
