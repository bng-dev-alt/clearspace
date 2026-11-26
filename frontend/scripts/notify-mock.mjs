#!/usr/bin/env node
/**
 * Deterministic MOCK of the Slack Web API + Telegram Bot API that ClearSpace uses (RUN 05) -- local tests only, loopback only.
 * It is NOT Slack or Telegram: passing tests against it proves our flow and our boundaries, not the providers' behaviour.
 *
 *   Slack:    GET  /slack/oauth/v2/authorize   (Czech consent page: workspace + user, allow / deny -> redirect with code / error)
 *             POST /slack/api/oauth.v2.access   (Basic client auth, single-use code, 10 min) -> bot token per workspace + authed_user.id
 *             POST /slack/api/chat.postMessage  (channel = user id of the token's workspace; records the message)
 *             POST /slack/api/auth.revoke, /slack/api/auth.test
 *   Telegram: POST /telegram/bot<token>/{getMe,sendMessage,getUpdates}   (401 for a wrong bot token; 403 for a chat that blocked the bot)
 *   Tests:    POST /__control/{reset,fail,telegram-start,telegram-block,slack-revoke-team}   GET /__control/{messages,stats}
 *             fail: { provider: 'slack'|'telegram', status?, error?, description?, retryAfter?, delayMs?, count }  (next `count` sends)
 *
 *   NOTIFY_MOCK_PORT=55622 SLACK_CLIENT_ID=... SLACK_CLIENT_SECRET=... TELEGRAM_BOT_TOKEN=... MOCK_SLACK_REDIRECTS=http://127.0.0.1:3471/api/notify/slack/callback
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.NOTIFY_MOCK_PORT || 55622);
const CLIENT_ID = process.env.SLACK_CLIENT_ID || '100000000001.200000000002';
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'mock-secret';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '100000001:MOCKmockMOCKmockMOCKmockMOCKmock_ab';
const REDIRECTS = (process.env.MOCK_SLACK_REDIRECTS || 'http://127.0.0.1:3471/api/notify/slack/callback').split(',').map((s) => s.trim()).filter(Boolean);

// Fictional workspaces and users (not real people). Two users share workspace T0MOCK01 (N9: shared bot token).
const WORKSPACES = [
  { id: 'T0MOCK01', name: 'Corvane (simulace)', users: [{ id: 'U0MOCKANNA', name: 'Anna' }, { id: 'U0MOCKBOHD', name: 'Bohdan' }] },
  { id: 'T0MOCK02', name: 'Druhý workspace (simulace)', users: [{ id: 'U0MOCKCYRL', name: 'Cyril' }] },
];

let codes, botTokens, slackMessages, tgMessages, tgUpdates, tgChats, failures, stats, nextUpdate;
function reset() {
  codes = new Map();            // code -> { team, user, redirect, exp }
  botTokens = new Map();        // token -> { team, revoked }
  slackMessages = []; tgMessages = []; tgUpdates = []; tgChats = new Map(); failures = { slack: [], telegram: [] };
  stats = { slackPosts: 0, tgSends: 0, exchanges: 0, revokes: 0, getUpdates: 0 }; nextUpdate = 1000;
}
reset();

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Consume one injected failure for a provider (or null). */
async function injected(provider) {
  const f = failures[provider][0];
  if (!f) return null;
  f.count -= 1; if (f.count <= 0) failures[provider].shift();
  if (f.delayMs) await sleep(f.delayMs);
  return f;
}
function slackTeamOfToken(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
  const t = m && botTokens.get(m[1]);
  return t && !t.revoked ? { token: m[1], ...t } : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const json = () => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
    const form = () => Object.fromEntries(new URLSearchParams(raw));

    // ---------------------------------------------------------------- Slack OAuth
    if (p === '/slack/oauth/v2/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('client_id') !== CLIENT_ID || !REDIRECTS.includes(q.get('redirect_uri') ?? '')) return send(res, 400, { error: 'bad_redirect_uri_or_client' });
      const options = WORKSPACES.flatMap((w) => w.users.map((u) => `<option value="${w.id}|${u.id}">${esc(w.name)} – ${esc(u.name)}</option>`)).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="cs"><meta charset="utf-8"><title>Slack (simulace)</title><body>
        <h1>Slack (simulace) – povolit aplikaci ClearSpace?</h1><p>Oprávnění: posílat zprávy jako ClearSpace (chat:write) – jen vám.</p>
        <form method="GET" action="/slack/oauth/v2/decide">
          <input type="hidden" name="state" value="${esc(q.get('state') ?? '')}"><input type="hidden" name="redirect_uri" value="${esc(q.get('redirect_uri'))}">
          <input type="hidden" name="scope" value="${esc(q.get('scope') ?? '')}">
          <label>Účet <select name="who" data-testid="slack-mock-who">${options}</select></label>
          <button name="decision" value="allow" data-testid="slack-mock-allow">Povolit</button>
          <button name="decision" value="deny" data-testid="slack-mock-deny">Zrušit</button>
        </form></body></html>`);
    }
    if (p === '/slack/oauth/v2/decide' && req.method === 'GET') {
      const q = url.searchParams;
      const redirect = q.get('redirect_uri') ?? '';
      if (!REDIRECTS.includes(redirect)) return send(res, 400, { error: 'bad_redirect_uri' });
      const target = new URL(redirect);
      target.searchParams.set('state', q.get('state') ?? '');
      if (q.get('decision') !== 'allow') target.searchParams.set('error', 'access_denied');
      else {
        const [team, user] = (q.get('who') ?? '').split('|');
        const code = `${randomBytes(6).toString('hex')}.${randomBytes(18).toString('hex')}`;
        codes.set(code, { team, user, redirect, scope: q.get('scope') ?? '', exp: Date.now() + 600_000 });
        target.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: target.toString() }); return res.end();
    }
    if (p === '/slack/api/oauth.v2.access' && req.method === 'POST') {
      stats.exchanges += 1;
      const basic = /^Basic\s+(\S+)$/.exec(req.headers.authorization ?? '');
      const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':') : [];
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return send(res, 200, { ok: false, error: 'invalid_client' });
      const f = form();
      const c = codes.get(f.code);
      if (!c || c.exp < Date.now()) return send(res, 200, { ok: false, error: 'invalid_code' });
      codes.delete(f.code);
      if (c.redirect !== f.redirect_uri) return send(res, 200, { ok: false, error: 'bad_redirect_uri' });
      const w = WORKSPACES.find((x) => x.id === c.team);
      // one bot token per workspace (re-installs return the same live token, like Slack)
      let token = [...botTokens.entries()].find(([, v]) => v.team === c.team && !v.revoked)?.[0];
      if (!token) { token = `xoxb-${c.team.toLowerCase()}-${randomBytes(12).toString('hex')}`; botTokens.set(token, { team: c.team, revoked: false }); }
      return send(res, 200, { ok: true, app_id: 'A0MOCKAPP', authed_user: { id: c.user }, scope: c.scope || 'chat:write', token_type: 'bot',
        access_token: token, bot_user_id: 'B0MOCKBOT', team: { id: w.id, name: w.name }, enterprise: null, is_enterprise_install: false });
    }
    if (p === '/slack/api/chat.postMessage' && req.method === 'POST') {
      stats.slackPosts += 1;
      const f = await injected('slack');
      if (f?.status) return send(res, f.status, { ok: false, error: f.error ?? 'ratelimited' }, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {});
      if (f?.error) return send(res, 200, { ok: false, error: f.error });
      const t = slackTeamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      const b = json();
      const w = WORKSPACES.find((x) => x.id === t.team);
      if (!w.users.some((u) => u.id === b.channel)) return send(res, 200, { ok: false, error: 'channel_not_found' });
      slackMessages.push({ team: t.team, channel: b.channel, text: b.text, mrkdwn: b.mrkdwn, unfurl_links: b.unfurl_links, unfurl_media: b.unfurl_media, at: Date.now() });
      return send(res, 200, { ok: true, channel: `D${b.channel.slice(1)}`, ts: `${Date.now() / 1000}` });
    }
    if (p === '/slack/api/auth.revoke' && req.method === 'POST') {
      stats.revokes += 1;
      const t = slackTeamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      botTokens.get(t.token).revoked = true;
      return send(res, 200, { ok: true, revoked: true });
    }
    if (p === '/slack/api/auth.test' && req.method === 'POST') {
      const t = slackTeamOfToken(req);
      return send(res, 200, t ? { ok: true, team_id: t.team } : { ok: false, error: 'invalid_auth' });
    }

    // ---------------------------------------------------------------- Telegram
    const tg = /^\/telegram\/bot([^/]+)\/([A-Za-z]+)$/.exec(p);
    if (tg && req.method === 'POST') {
      if (tg[1] !== BOT_TOKEN) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const b = json();
      if (tg[2] === 'getMe') return send(res, 200, { ok: true, result: { id: Number(BOT_TOKEN.split(':')[0]), is_bot: true, username: 'clearspace_mock_bot' } });
      if (tg[2] === 'getUpdates') {
        stats.getUpdates += 1;
        if (typeof b.offset === 'number') tgUpdates = tgUpdates.filter((u) => u.update_id >= b.offset);
        return send(res, 200, { ok: true, result: tgUpdates.slice(0, b.limit ?? 100) });
      }
      if (tg[2] === 'sendMessage') {
        stats.tgSends += 1;
        const f = await injected('telegram');
        if (f?.status) return send(res, f.status, { ok: false, error_code: f.status, description: f.description ?? 'Too Many Requests: retry after 7', ...(f.retryAfter ? { parameters: { retry_after: f.retryAfter } } : {}) });
        const chat = tgChats.get(Number(b.chat_id));
        if (!chat) return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        if (chat.blocked) return send(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
        tgMessages.push({ chatId: Number(b.chat_id), text: b.text, parse_mode: b.parse_mode ?? null, preview: b.link_preview_options ?? null, at: Date.now() });
        return send(res, 200, { ok: true, result: { message_id: tgMessages.length, chat: { id: Number(b.chat_id), type: 'private' }, text: b.text } });
      }
      return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }

    // ---------------------------------------------------------------- test control
    if (p.startsWith('/__control/')) {
      const b = json();
      switch (p.slice('/__control/'.length)) {
        case 'reset': reset(); return send(res, 200, { ok: true });
        case 'fail': failures[b.provider].push({ status: b.status, error: b.error, description: b.description, retryAfter: b.retryAfter, delayMs: b.delayMs, count: Math.max(1, b.count ?? 1) }); return send(res, 200, { ok: true });
        case 'telegram-start': {
          const chatId = Number(b.chatId ?? 700000001);
          tgChats.set(chatId, { blocked: false });
          tgUpdates.push({ update_id: nextUpdate++, message: { message_id: nextUpdate, date: Math.floor(Date.now() / 1000), text: b.text ?? (b.token ? `/start ${b.token}` : '/start'),
            chat: { id: chatId, type: b.chatType ?? 'private' }, from: { id: chatId, is_bot: false, first_name: b.firstName ?? 'Eva', ...(b.username ? { username: b.username } : {}) } } });
          return send(res, 200, { ok: true });
        }
        case 'telegram-block': { const c = tgChats.get(Number(b.chatId)); if (c) c.blocked = b.blocked !== false; return send(res, 200, { ok: true }); }
        case 'slack-revoke-team': for (const v of botTokens.values()) if (v.team === b.teamId) v.revoked = true; return send(res, 200, { ok: true });
        case 'messages': return send(res, 200, { slack: slackMessages, telegram: tgMessages });
        case 'stats': return send(res, 200, { ...stats, liveSlackTokens: [...botTokens.values()].filter((v) => !v.revoked).length, pendingUpdates: tgUpdates.length });
        default: return send(res, 404, { error: 'unknown control' });
      }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    return send(res, 500, { error: 'mock_error', detail: String(e?.message ?? e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`notify-mock (SIMULACE Slack + Telegram) on http://127.0.0.1:${PORT}`));
