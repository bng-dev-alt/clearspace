#!/usr/bin/env node
/**
 * Deterministic MOCK of the Slack Web API (PROJECT app) + Telegram Bot API (PROJECT bot) for the Communication Hub (RUN 07) -- local tests
 * only, loopback only. It is NOT Slack or Telegram: passing tests against it proves our flow and boundaries, not the providers' behaviour.
 * Inbound traffic (Slack Events / commands / interactivity, Telegram updates) is sent BY THE TESTS straight to the app, signed like the
 * real providers do (supabase/tests/hub_http.mjs); this mock only answers the app's outbound API calls.
 *
 *   Slack:    GET  /slack/oauth/v2/authorize -> consent page (workspace) -> /slack/oauth/v2/decide -> redirect with code / error
 *             POST /slack/api/{oauth.v2.access, chat.postMessage, views.open, auth.revoke}   GET /slack/api/chat.getPermalink
 *   Telegram: POST /telegram/bot<token>/{sendMessage, getChatMember, leaveChat, getMe}
 *   Tests:    POST /__control/{reset, fail, slack-channel, slack-revoke-team, telegram-chat}   GET /__control/{messages, stats}
 *             slack-channel { team, id, member?, archived? }   telegram-chat { chatId, type?, admins?: number[], member? }
 *             fail { provider, status?, error?, description?, retryAfter?, delayMs?, count? }  (next `count` sends)
 *
 *   HUB_MOCK_PORT=55623 SLACK_HUB_CLIENT_ID=... SLACK_HUB_CLIENT_SECRET=... TELEGRAM_HUB_BOT_TOKEN=... MOCK_SLACK_REDIRECTS=...
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.HUB_MOCK_PORT || 55623);
const CLIENT_ID = process.env.SLACK_HUB_CLIENT_ID || '300000000003.400000000004';
const CLIENT_SECRET = process.env.SLACK_HUB_CLIENT_SECRET || 'mock-hub-secret';
const BOT_TOKEN = process.env.TELEGRAM_HUB_BOT_TOKEN || '200000002:MOCKmockMOCKmockMOCKmockMOCKhub_cd';
const REDIRECTS = (process.env.MOCK_SLACK_REDIRECTS || 'http://127.0.0.1:3471/api/hub/slack/install/callback').split(',').map((s) => s.trim()).filter(Boolean);
const WORKSPACES = [{ id: 'T0HUB0001', name: 'Corvane (simulace)' }, { id: 'T0HUB0002', name: 'Druhý tým (simulace)' }];

let codes, botTokens, slackChannels, slackMessages, views, tgChats, tgMessages, failures, stats;
function reset() {
  codes = new Map(); botTokens = new Map(); slackChannels = new Map(); slackMessages = []; views = [];
  tgChats = new Map(); tgMessages = []; failures = { slack: [], telegram: [] };
  stats = { slackPosts: 0, tgSends: 0, exchanges: 0, revokes: 0, views: 0, permalinks: 0, chatMember: 0, leaves: 0 };
}
reset();

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function injected(provider) {
  const f = failures[provider][0];
  if (!f) return null;
  f.count -= 1; if (f.count <= 0) failures[provider].shift();
  if (f.delayMs) await sleep(f.delayMs);
  return f;
}
function teamOfToken(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
  const t = m && botTokens.get(m[1]);
  return t && !t.revoked ? { token: m[1], ...t } : null;
}
let tsCounter = 1_800_000_000;
const nextTs = () => `${tsCounter++}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const json = () => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };

    // ---------------------------------------------------------------- Slack OAuth (project app)
    if (p === '/slack/oauth/v2/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('client_id') !== CLIENT_ID || !REDIRECTS.includes(q.get('redirect_uri') ?? '')) return send(res, 400, { error: 'bad_redirect_uri_or_client' });
      const opts = WORKSPACES.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html lang="cs"><meta charset="utf-8"><title>Slack (simulace)</title><body>
        <h1>Slack (simulace) – nainstalovat ClearSpace Projekty?</h1><p>Oprávnění: ${esc(q.get('scope') ?? '')}</p>
        <form method="GET" action="/slack/oauth/v2/decide">
          <input type="hidden" name="state" value="${esc(q.get('state') ?? '')}"><input type="hidden" name="redirect_uri" value="${esc(q.get('redirect_uri'))}">
          <input type="hidden" name="scope" value="${esc(q.get('scope') ?? '')}">
          <label>Workspace <select name="team" data-testid="slack-hub-mock-team">${opts}</select></label>
          <button name="decision" value="allow" data-testid="slack-hub-mock-allow">Povolit</button>
          <button name="decision" value="deny" data-testid="slack-hub-mock-deny">Zrušit</button>
        </form></body></html>`);
    }
    if (p === '/slack/oauth/v2/decide' && req.method === 'GET') {
      const q = url.searchParams, redirect = q.get('redirect_uri') ?? '';
      if (!REDIRECTS.includes(redirect)) return send(res, 400, { error: 'bad_redirect_uri' });
      const target = new URL(redirect);
      target.searchParams.set('state', q.get('state') ?? '');
      if (q.get('decision') !== 'allow') target.searchParams.set('error', 'access_denied');
      else {
        const code = `${randomBytes(6).toString('hex')}.${randomBytes(18).toString('hex')}`;
        codes.set(code, { team: q.get('team'), redirect, scope: q.get('scope') ?? '', exp: Date.now() + 600_000 });
        target.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: target.toString() }); return res.end();
    }
    if (p === '/slack/api/oauth.v2.access' && req.method === 'POST') {
      stats.exchanges += 1;
      const basic = /^Basic\s+(\S+)$/.exec(req.headers.authorization ?? '');
      const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString().split(':') : [];
      if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return send(res, 200, { ok: false, error: 'invalid_client' });
      const f = Object.fromEntries(new URLSearchParams(raw));
      const c = codes.get(f.code);
      if (!c || c.exp < Date.now()) return send(res, 200, { ok: false, error: 'invalid_code' });
      codes.delete(f.code);
      if (c.redirect !== f.redirect_uri) return send(res, 200, { ok: false, error: 'bad_redirect_uri' });
      const w = WORKSPACES.find((x) => x.id === c.team) ?? WORKSPACES[0];
      let token = [...botTokens.entries()].find(([, v]) => v.team === w.id && !v.revoked)?.[0];
      if (!token) { token = `xoxb-${w.id.toLowerCase()}-${randomBytes(12).toString('hex')}`; botTokens.set(token, { team: w.id, revoked: false }); }
      return send(res, 200, { ok: true, app_id: 'A0MOCKHUB', authed_user: { id: 'U0HUBINST' }, scope: c.scope, token_type: 'bot', access_token: token,
        bot_user_id: 'U0HUBBOT', team: { id: w.id, name: w.name }, enterprise: null, is_enterprise_install: false });
    }
    if (p === '/slack/api/chat.postMessage' && req.method === 'POST') {
      stats.slackPosts += 1;
      const f = await injected('slack');
      if (f?.status) return send(res, f.status, { ok: false, error: f.error ?? 'ratelimited' }, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {});
      if (f?.error) return send(res, 200, { ok: false, error: f.error });
      const t = teamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      const b = json();
      const ch = slackChannels.get(`${t.team}:${b.channel}`);
      if (!ch) return send(res, 200, { ok: false, error: 'channel_not_found' });
      if (ch.archived) return send(res, 200, { ok: false, error: 'is_archived' });
      if (!ch.member) return send(res, 200, { ok: false, error: 'not_in_channel' });
      const ts = nextTs();
      slackMessages.push({ team: t.team, channel: b.channel, text: b.text, thread_ts: b.thread_ts ?? null, mrkdwn: b.mrkdwn, unfurl_links: b.unfurl_links, ts, at: Date.now() });
      return send(res, 200, { ok: true, channel: b.channel, ts });
    }
    if (p === '/slack/api/chat.getPermalink' && req.method === 'GET') {
      stats.permalinks += 1;
      const t = teamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      const ch = url.searchParams.get('channel') ?? '', ts = url.searchParams.get('message_ts') ?? '';
      return send(res, 200, { ok: true, channel: ch, permalink: `https://slack.invalid/archives/${ch}/p${ts.replace('.', '')}` });
    }
    if (p === '/slack/api/views.open' && req.method === 'POST') {
      stats.views += 1;
      const t = teamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      const b = json();
      if (!/^trig-/.test(String(b.trigger_id ?? ''))) return send(res, 200, { ok: false, error: 'invalid_trigger_id' });
      views.push({ team: t.team, trigger: b.trigger_id, view: b.view });
      return send(res, 200, { ok: true, view: { id: `V${views.length}` } });
    }
    if (p === '/slack/api/auth.revoke' && req.method === 'POST') {
      stats.revokes += 1;
      const t = teamOfToken(req);
      if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
      botTokens.get(t.token).revoked = true;
      return send(res, 200, { ok: true, revoked: true });
    }

    // ---------------------------------------------------------------- Telegram (project bot)
    const tg = /^\/telegram\/bot([^/]+)\/([A-Za-z]+)$/.exec(p);
    if (tg && req.method === 'POST') {
      if (tg[1] !== BOT_TOKEN) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const b = json(), chat = tgChats.get(Number(b.chat_id));
      if (tg[2] === 'getMe') return send(res, 200, { ok: true, result: { id: Number(BOT_TOKEN.split(':')[0]), is_bot: true, username: 'clearspace_hub_mock_bot' } });
      if (tg[2] === 'getChatMember') {
        stats.chatMember += 1;
        if (!chat) return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        const uid = Number(b.user_id);
        return send(res, 200, { ok: true, result: { user: { id: uid, is_bot: false, first_name: 'X' }, status: chat.admins.includes(uid) ? (uid === chat.admins[0] ? 'creator' : 'administrator') : 'member' } });
      }
      if (tg[2] === 'leaveChat') { stats.leaves += 1; if (chat) chat.member = false; return send(res, 200, { ok: true, result: true }); }
      if (tg[2] === 'sendMessage') {
        stats.tgSends += 1;
        const f = await injected('telegram');
        if (f?.status) return send(res, f.status, { ok: false, error_code: f.status, description: f.description ?? 'Too Many Requests: retry after 7', ...(f.retryAfter ? { parameters: { retry_after: f.retryAfter } } : {}) });
        if (!chat) return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
        if (!chat.member) return send(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the group chat' });
        chat.nextId += 1;
        tgMessages.push({ chatId: Number(b.chat_id), messageId: chat.nextId, text: b.text, parse_mode: b.parse_mode ?? null, preview: b.link_preview_options ?? null,
          replyTo: b.reply_parameters?.message_id ?? null, at: Date.now() });
        return send(res, 200, { ok: true, result: { message_id: chat.nextId, chat: { id: Number(b.chat_id), type: chat.type }, text: b.text } });
      }
      return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }

    // ---------------------------------------------------------------- test control
    if (p.startsWith('/__control/')) {
      const b = json();
      switch (p.slice('/__control/'.length)) {
        case 'reset': reset(); return send(res, 200, { ok: true });
        case 'fail': failures[b.provider].push({ status: b.status, error: b.error, description: b.description, retryAfter: b.retryAfter, delayMs: b.delayMs, count: Math.max(1, b.count ?? 1) }); return send(res, 200, { ok: true });
        case 'slack-channel': slackChannels.set(`${b.team}:${b.id}`, { member: b.member !== false, archived: b.archived === true }); return send(res, 200, { ok: true });
        case 'slack-revoke-team': for (const v of botTokens.values()) if (v.team === b.teamId) v.revoked = true; return send(res, 200, { ok: true });
        case 'telegram-chat': {
          const prev = tgChats.get(Number(b.chatId));
          tgChats.set(Number(b.chatId), { type: b.type ?? 'supergroup', admins: b.admins ?? prev?.admins ?? [], member: b.member !== false, nextId: prev?.nextId ?? 5000 });
          return send(res, 200, { ok: true });
        }
        case 'messages': return send(res, 200, { slack: slackMessages, telegram: tgMessages, views });
        case 'stats': return send(res, 200, { ...stats, liveSlackTokens: [...botTokens.values()].filter((v) => !v.revoked).length });
        default: return send(res, 404, { error: 'unknown control' });
      }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    return send(res, 500, { error: 'mock_error', detail: String(e?.message ?? e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`hub-mock (SIMULACE Slack + Telegram, projektová aplikace) on http://127.0.0.1:${PORT}`));
