// RUN 05 -- Slack & Telegram notifications: HTTP-level integration + adversarial suite against a REAL local stack (GoTrue + PostgREST +
// Postgres with pg_net, scripts/notify-stack.sh), the REAL Next.js app (route handlers) and the Slack/Telegram MOCK. Everything
// Slack/Telegram here is SIMULATED (scripts/notify-mock.mjs): this proves our flow and our boundaries (N1-N17), NOT the providers'
// behaviour. Loopback only. The scheduler tick is run by hand (the same SQL function pg_cron runs every minute).
//
//   eval "$(scripts/notify-stack.sh env)"; APP_LOG=<dev log> node supabase/tests/notify_http.mjs
//   NOTIFY_EXPECT_OFF=1 node supabase/tests/notify_http.mjs     # against an app started with both switches 0
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY;
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY;
const APP = process.env.E2E_BASE_URL;
const MOCK = process.env.NOTIFY_MOCK_URL;
const SECRET = process.env.NOTIFY_SERVER_SECRET;
const DBC = process.env.NOTIFY_DB_CONTAINER || 'supabase_db_cs-notify-sb';
const APP_LOG = process.env.APP_LOG;
for (const u of [API, APP, MOCK]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: every endpoint must be loopback'); process.exit(2); }
}
if (!ANON || !SERVICE || !SECRET) { console.error('missing keys'); process.exit(2); }

const run = Date.now().toString(36);
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { method = 'GET', headers = {}, body, raw } = {}) {
  const res = await fetch(url, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}
const db = (path, { token, key = ANON, ...o } = {}) => http(`${API}${path}`, { ...o, headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(o.headers ?? {}) } });
const rpc = (name, args, token) => db(`/rest/v1/rpc/${name}`, { method: 'POST', token, body: args });
const admin = (path, o = {}) => db(path, { ...o, key: SERVICE });
const app = (path, token, o = {}) => http(`${APP}${path}`, { ...o, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...(o.headers ?? {}) } });
const ctl = (name, body) => http(`${MOCK}/__control/${name}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body });
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', DBC, 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' }).trim();

// ================================================================ both switches OFF (separate app run)
const ENDPOINTS = [['GET', '/api/notify/status'], ['PUT', '/api/notify/preferences'], ['POST', '/api/notify/channel'], ['POST', '/api/notify/test'],
  ['POST', '/api/notify/slack/start'], ['POST', '/api/notify/slack/complete'], ['POST', '/api/notify/telegram/link'], ['POST', '/api/notify/telegram/check'],
  ['POST', '/api/notify/telegram/confirm'], ['POST', '/api/notify/dispatch']];
if (process.env.NOTIFY_EXPECT_OFF === '1') {
  for (const [m, p] of ENDPOINTS) {
    const r = await app(p, null, { method: m, body: m === 'GET' ? undefined : {}, headers: p.endsWith('dispatch') ? { 'x-notify-secret': SECRET } : {} });
    assert.equal(r.status, 503, `${m} ${p} -> ${r.status}`);
    assert.ok(['notify_disabled', 'slack_disabled', 'telegram_disabled'].includes(r.json?.error), `${p}: ${JSON.stringify(r.json)}`);
  }
  const cb = await http(`${APP}/api/notify/slack/callback?state=${'a'.repeat(43)}&code=x`);
  assert.equal(cb.status, 303); assert.match(cb.headers.get('location'), /notify=disabled/); assert.ok(!(cb.headers.get('set-cookie') ?? '').includes('cs_notify'));
  const before = await ctl('stats');
  ok(`N11: switches OFF -> all ${ENDPOINTS.length} routes answer 503 first (dispatch too, even with the secret); Slack callback parks nothing`);
  const priv = await http(`${APP}/privacy`);
  assert.ok(priv.text.includes('privacy-notify-off'), 'privacy says off');
  const about = await http(`${APP}/about`);
  assert.ok(!about.text.includes('about-notify'), 'about has no section');
  const after = await ctl('stats');
  assert.deepEqual(after, before, 'no provider call happened');
  ok('N11: /privacy says "not switched on", /about has no section, zero calls reached Slack/Telegram');
  console.log(`\nNotify HTTP (OFF): ${passed} groups passed (SIMULATED providers)`);
  process.exit(0);
}

// ---------------------------------------------------------------- scheduler wiring (vault: url + secret; no cron job -> ticks only by hand)
sql(`create extension if not exists pg_net with schema extensions`);
for (const [name, value] of [['clearspace_notify_url', `http://host.docker.internal:${new URL(APP).port}/api/notify/dispatch`], ['clearspace_notify_secret', SECRET]]) {
  const id = sql(`select id from vault.secrets where name = '${name}'`);
  if (id) sql(`select vault.update_secret('${id}', '${value}')`); else sql(`select vault.create_secret('${value}', '${name}')`);
}
if (sql(`select to_regclass('cron.job') is not null`) === 't') sql(`select cron.unschedule(jobid) from cron.job where jobname = 'clearspace-notify-dispatch'`);
/** One tick, then wait for the app's answer and collect it with a second tick (what pg_cron does over two minutes). */
async function tick(now = null) {
  const r1 = JSON.parse(sql(`select public.notify_scheduler_tick(${now ? `'${now}'` : 'null'})`));
  if (r1.request) {
    for (let i = 0; i < 150; i++) { if (sql(`select count(*) from net._http_response where id = ${r1.request}`) === '1') break; await sleep(400); }
  }
  const r2 = JSON.parse(sql(`select public.notify_scheduler_tick(${now ? `'${now}'` : 'null'})`));
  return { first: r1, second: r2 };
}
const deliveries = async (userId) => (await admin(`/rest/v1/notification_deliveries?user_id=eq.${userId}&order=created_at.asc`)).json;
const channel = async (userId, provider) => (await admin(`/rest/v1/notification_channels?user_id=eq.${userId}&provider=eq.${provider}`)).json[0];
const messages = async () => (await ctl('messages')).json;

async function user(tag) {
  const email = `${tag}-${run}@example.test`;
  const c = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password: 'Test-Password-123', email_confirm: true } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const l = await db('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'Test-Password-123' } });
  return { id: l.json.user.id, email, token: l.json.access_token };
}

// ---------------------------------------------------------------- fixture
await ctl('reset', {});
sql(`delete from public.notification_dispatch_runs`);
sql(`delete from public.notification_channels where user_id in (select id from auth.users where email like 'ntf-%@example.test')`);   // earlier runs
const O = await user('ntf-own'), E = await user('ntf-ed'), V = await user('ntf-view'), X = await user('ntf-out'), F = await user('ntf-ed2');
const P = `p-ntf-${run}`, TODO = `${P}-todo`, DONE = `${P}-done`;
const card = (n) => `${P}-card-${n}`;
for (const r of [
  await db('/rest/v1/projects', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: P, name: 'Rekonstrukce kanceláře' } }),
  await db('/rest/v1/columns', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: [{ id: TODO, project_id: P, name: 'K udělání', position: 0 }, { id: DONE, project_id: P, name: 'Hotovo', position: 1 }] }),
  await db('/rest/v1/project_members', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { project_id: P, member_id: `member-owner-${O.id}` } }),
]) assert.ok(r.status < 300, JSON.stringify(r.json));
const members = {};
for (const [u, role, name] of [[E, 'member', 'Eva Editorka'], [V, 'viewer', 'Viktor Čtenář'], [F, 'member', 'Filip Druhý']]) {
  const inv = await rpc('create_project_invitation', { p_project_id: P, p_email: u.email, p_role: role }, O.token);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  assert.equal((await rpc('accept_workspace_invitation', { p_token: inv.json[0].token, p_display_name: name }, u.token)).status, 200);
  members[u.id] = (await admin(`/rest/v1/workspace_members?profile_id=eq.${u.id}&owner_id=eq.${O.id}&select=id`)).json[0].id;
}
let cardNo = 0;
async function newCard(title, extra = {}) {
  const id = card(++cardNo);
  const r = await db('/rest/v1/cards', { method: 'POST', token: O.token, body: { id, column_id: TODO, title, details: '', ...extra } });
  assert.ok(r.status < 300, JSON.stringify(r.json));
  return id;
}
const assign = async (cardId, u, by = O) => {
  const r = await db('/rest/v1/card_assignees', { method: 'POST', token: by.token, headers: { Prefer: 'return=minimal' }, body: { card_id: cardId, member_id: u.id === O.id ? `member-owner-${O.id}` : members[u.id] } });
  assert.ok(r.status < 300, JSON.stringify(r.json));
};
ok('fixture: owner, editor, viewer, second editor on one project + an outsider; columns "K udělání" / "Hotovo"');

// ---------------------------------------------------------------- authentication / authorization at the edge
for (const [m, p] of ENDPOINTS.filter(([, p]) => !p.endsWith('dispatch'))) {
  const r = await app(p, null, { method: m, body: m === 'GET' ? undefined : {} });
  assert.ok([400, 401].includes(r.status), `${m} ${p} without a session -> ${r.status}`);
}
for (const hdr of [{}, { 'x-notify-secret': 'x'.repeat(64) }, { 'x-notify-secret': `${SECRET}x` }]) {
  const r = await app('/api/notify/dispatch', null, { method: 'POST', body: { items: [] }, headers: hdr });
  assert.equal(r.status, 401, JSON.stringify(hdr));
}
const big = await app('/api/notify/dispatch', null, { method: 'POST', raw: JSON.stringify({ items: [], pad: 'x'.repeat(600 * 1024) }), headers: { 'x-notify-secret': SECRET } });
assert.equal(big.status, 413);
ok('edge: every user route needs a session; dispatch needs the exact scheduler secret (401) and caps the body (413)');

// ---------------------------------------------------------------- Telegram: deep link -> /start -> confirm (N8)
const tgLink = async (u) => { const r = await app('/api/notify/telegram/link', u.token, { method: 'POST', body: {} }); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.url; };
const urlE = await tgLink(E);
assert.match(urlE, /^https:\/\/t\.me\/clearspace_mock_bot\?start=[A-Za-z0-9_-]{43}$/);
const tokE = new URL(urlE).searchParams.get('start');
const again = await app('/api/notify/telegram/link', E.token, { method: 'POST', body: {} });
assert.equal(again.status, 429, 'link throttle');
await ctl('telegram-start', { token: tokE, chatId: 7001, firstName: 'Eva', username: 'eva_test' });
await ctl('telegram-start', { token: tokE, chatId: 7666, firstName: 'Útočník' });           // replay of the same token from another chat
await ctl('telegram-start', { chatId: 7002, firstName: 'Bez tokenu' });                       // bare /start
await ctl('telegram-start', { token: tokE, chatId: -100123, chatType: 'group' });             // a group: ignored completely
const chk = await app('/api/notify/telegram/check', X.token, { method: 'POST', body: {} });  // ANOTHER user's request processes the updates
assert.equal(chk.status, 200, JSON.stringify(chk.json));
assert.equal(chk.json.channel, null, 'the outsider has no Telegram channel of his own');
let stE = (await app('/api/notify/status', E.token)).json.channels.find((c) => c.provider === 'telegram');
assert.equal(stE.status, 'confirm'); assert.equal(stE.label, 'Eva (@eva_test)');
let m = await messages();
assert.equal(m.telegram.filter((x) => x.chatId === 7001).length, 1, 'confirmation request to the linking chat');
assert.equal(m.telegram.filter((x) => x.chatId === 7666).length, 1, 'the replaying chat only gets the help text');
assert.match(m.telegram.find((x) => x.chatId === 7666).text, /jen doručuje oznámení/);
assert.equal(m.telegram.filter((x) => x.chatId === -100123).length, 0, 'groups are ignored');
assert.equal((await ctl('stats')).json.pendingUpdates, 0, 'updates confirmed (offset), never read twice');
const notMine = await app('/api/notify/telegram/confirm', X.token, { method: 'POST', body: { accept: true } });
assert.equal(notMine.json.status, 'none');
const conf = await app('/api/notify/telegram/confirm', E.token, { method: 'POST', body: { accept: true } });
assert.equal(conf.json.status, 'active');
assert.match((await messages()).telegram.filter((x) => x.chatId === 7001).at(-1).text, /budou chodit sem/);
ok('N8: Telegram token resolves from any server request, single use (replay -> help only), private chats only, nothing sent before the owner confirms; others cannot confirm');

// viewer V: link + reject
const tokV = new URL(await tgLink(V)).searchParams.get('start');
await ctl('telegram-start', { token: tokV, chatId: 7003, firstName: 'Viktor' });
await app('/api/notify/telegram/check', V.token, { method: 'POST', body: {} });
assert.equal((await app('/api/notify/telegram/confirm', V.token, { method: 'POST', body: { accept: false } })).json.status, 'removed');
assert.equal((await app('/api/notify/status', V.token)).json.channels.length, 0);
ok('N8: rejecting the found chat removes the link');

// ---------------------------------------------------------------- Slack OAuth (N9)
async function slackConnect(u, who, decision = 'allow', { dropNonce = false } = {}) {
  const s = await app('/api/notify/slack/start', u.token, { method: 'POST', body: {} });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const nonce = /cs_notify_slack=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(nonce && /HttpOnly/i.test(s.headers.get('set-cookie')) && /Path=\/api\/notify\/slack/.test(s.headers.get('set-cookie')), 'nonce cookie HttpOnly + path-scoped');
  const auth = new URL(s.json.url);
  assert.equal(auth.searchParams.get('scope'), 'chat:write'); assert.equal(auth.searchParams.get('user_scope'), null);
  const d = new URL(`${MOCK}/slack/oauth/v2/decide`);
  for (const k of ['state', 'redirect_uri', 'scope']) d.searchParams.set(k, auth.searchParams.get(k));
  d.searchParams.set('who', who); d.searchParams.set('decision', decision);
  const back = await http(d.toString());
  assert.equal(back.status, 302);
  const cb = await http(back.headers.get('location'));
  assert.equal(cb.status, 303); assert.match(cb.headers.get('location'), /\/settings\?notify=slack$/);
  // next.config.ts security headers override the route's no-referrer (same as the Google callback since RUN 02): the code never leaves the origin
  assert.ok(['no-referrer', 'strict-origin-when-cross-origin'].includes(cb.headers.get('referrer-policy')), cb.headers.get('referrer-policy'));
  const parked = /cs_notify_slack_result=([^;]+)/.exec(cb.headers.get('set-cookie') ?? '')?.[1];
  const cookie = `${dropNonce ? '' : `cs_notify_slack=${nonce}; `}cs_notify_slack_result=${parked}`;
  const r = await app('/api/notify/slack/complete', u.token, { method: 'POST', body: {}, headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { outcome: r.json.outcome, cookie, setCookie: r.headers.get('set-cookie') };
}
const c1 = await slackConnect(O, 'T0MOCK01|U0MOCKANNA');
assert.equal(c1.outcome, 'connected');
assert.match(c1.setCookie, /cs_notify_slack_result=;/, 'parked answer cleared');
const replay = await app('/api/notify/slack/complete', O.token, { method: 'POST', body: {}, headers: { Cookie: c1.cookie } });
assert.equal(replay.json.outcome, 'expired', 'N9: the state is single use');
assert.equal((await slackConnect(F, 'T0MOCK01|U0MOCKBOHD')).outcome, 'connected');
assert.equal((await slackConnect(V, 'T0MOCK02|U0MOCKCYRL', 'deny')).outcome, 'denied');
assert.equal((await app('/api/notify/status', V.token)).json.channels.find((c) => c.provider === 'slack')?.status ?? 'linking', 'linking', 'denied -> nothing connected');
await sleep(3100);
assert.equal((await slackConnect(V, 'T0MOCK02|U0MOCKCYRL', 'allow', { dropNonce: true })).outcome, 'expired', 'N9: another browser (no nonce) cannot complete');
// another user cannot complete my parked answer
const s2 = await app('/api/notify/slack/start', E.token, { method: 'POST', body: {} });
const n2 = /cs_notify_slack=([^;]+)/.exec(s2.headers.get('set-cookie'))?.[1];
const a2 = new URL(s2.json.url); const d2 = new URL(`${MOCK}/slack/oauth/v2/decide`);
for (const k of ['state', 'redirect_uri', 'scope']) d2.searchParams.set(k, a2.searchParams.get(k));
d2.searchParams.set('who', 'T0MOCK02|U0MOCKCYRL'); d2.searchParams.set('decision', 'allow');
const cb2 = await http((await http(d2.toString())).headers.get('location'));
const parked2 = /cs_notify_slack_result=([^;]+)/.exec(cb2.headers.get('set-cookie'))?.[1];
const stolen = await app('/api/notify/slack/complete', X.token, { method: 'POST', body: {}, headers: { Cookie: `cs_notify_slack=${n2}; cs_notify_slack_result=${parked2}` } });
assert.equal(stolen.json.outcome, 'expired', 'N9: another ClearSpace user cannot use my state + nonce');
ok('N9: Slack OAuth = chat:write only, state bound to user + browser (HttpOnly nonce), single use; deny / other browser / other user -> nothing stored');

const stO = await app('/api/notify/status', O.token);
const blob = JSON.stringify(stO.json);
for (const leak of ['xoxb-', 'U0MOCK', 'T0MOCK', '7001', 'secret', 'team_hmac']) assert.ok(!blob.includes(leak), `status leaks ${leak}`);
assert.equal(stO.json.channels.find((c) => c.provider === 'slack').label, 'Corvane (simulace)');
assert.equal(stO.json.slack.simulated, true);
ok('N13: status shows provider, state, workspace / chat label only -- no token, Slack id, team id or chat id');

// ---------------------------------------------------------------- test message
const t1 = await app('/api/notify/test', O.token, { method: 'POST', body: { provider: 'slack' } });
assert.equal(t1.json.outcome, 'sent');
const t2 = await app('/api/notify/test', O.token, { method: 'POST', body: { provider: 'slack' } });
assert.equal(t2.status, 429);
const lastSlack = (await messages()).slack.at(-1);
assert.equal(lastSlack.channel, 'U0MOCKANNA'); assert.equal(lastSlack.mrkdwn, false); assert.equal(lastSlack.unfurl_links, false); assert.equal(lastSlack.unfurl_media, false);
ok('test message goes to the connecting user only (DM), markup + previews off; at most one per 30 s');

// ---------------------------------------------------------------- delivery: assignment (M3/M6), content (§2.4), injection (N7)
const k1 = await newCard('Objednat nábytek');
await assign(k1, E);
assert.equal((await deliveries(E.id)).length, 1, 'queued at the moment of the in-app notification');
let t = await tick();
assert.equal(t.first.sent, 1); assert.equal(t.second.applied, 1);
m = await messages();
const msgE = m.telegram.filter((x) => x.chatId === 7001).at(-1);
assert.match(msgE.text, /^ClearSpace · Rekonstrukce kanceláře\n.+ vám přiřadil\(a\) úkol „Objednat nábytek"\.\nOtevřít: /);
assert.ok(msgE.text.endsWith(`Otevřít: ${APP}/projects/${encodeURIComponent(P)}?task=${encodeURIComponent(k1)}`), msgE.text);
assert.equal(msgE.parse_mode, null); assert.deepEqual(msgE.preview, { is_disabled: true });
assert.equal((await deliveries(E.id))[0].status, 'sent');
assert.ok((await channel(E.id, 'telegram')).last_sent_at);
ok('M3/M6: assignment -> Telegram message with task + project + deep link into ClearSpace; plain text, no link preview; recorded as sent');

const evil = await newCard('<!channel> & <@U0MOCKBOHD> <https://evil.example|klikni> ‮\u0007 Útok');
await assign(evil, O, E);
await tick();
const sm = (await messages()).slack.filter((x) => x.channel === 'U0MOCKANNA').at(-1);
assert.ok(sm.text.includes('&lt;!channel&gt; &amp; &lt;@U0MOCKBOHD&gt; &lt;https://evil.example|klikni&gt;'), sm.text);
assert.ok(!/[<>]/.test(sm.text.replace(/&lt;|&gt;/g, '')) && !/[‮\u0007]/.test(sm.text), 'no raw markup / control characters');
ok('N7: Slack mentions, <!channel>, masked links and control characters from a task title arrive as inert text');

// comment text never leaves ClearSpace
const k2 = await newCard('Revize elektroinstalace');
await assign(k2, E);
await tick();
await db('/rest/v1/task_comments', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: `${P}-c1`, card_id: k2, author_name: 'x', content: 'TAJNÝ OBSAH KOMENTÁŘE 123', mentions: [E.id], author_id: O.id } });
await tick();
const mention = (await messages()).telegram.filter((x) => x.chatId === 7001).at(-1);
assert.match(mention.text, /zmínil\(a\) v komentáři u úkolu „Revize elektroinstalace"/);
assert.ok(!mention.text.includes('TAJNÝ'), 'comment text never sent');
ok('§2.4: a mention says who and where -- never the comment text');

// ---------------------------------------------------------------- preferences (N10): hide titles, type off, project filter
assert.equal((await app('/api/notify/preferences', E.token, { method: 'PUT', body: { eventTypes: ['assignment', 'mention'], projectIds: null, hideTitles: true } })).status, 200);
const k3 = await newCard('Tajný název úkolu');
await assign(k3, E);
await tick();
const hidden = (await messages()).telegram.filter((x) => x.chatId === 7001).at(-1);
assert.equal(hidden.text, `ClearSpace\nByl vám přiřazen úkol.\nOtevřít: ${APP}/projects/${encodeURIComponent(P)}?task=${encodeURIComponent(k3)}`);
await db(`/rest/v1/cards?id=eq.${k3}`, { method: 'PATCH', token: O.token, headers: { Prefer: 'return=minimal' }, body: { column_id: DONE } });
assert.equal((await deliveries(E.id)).filter((d) => d.kind === 'task_completed').length, 0, 'task_completed switched off -> not queued');
assert.equal((await app('/api/notify/preferences', E.token, { method: 'PUT', body: { eventTypes: ['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership'], projectIds: ['p-jiny'], hideTitles: false } })).status, 200);
const k4 = await newCard('Mimo vybrané projekty');
await assign(k4, E);
assert.equal((await deliveries(E.id)).filter((d) => d.card_id === k4).length, 0, 'project outside the selection -> not queued');
const bad = await app('/api/notify/preferences', E.token, { method: 'PUT', body: { eventTypes: ['assignment', 'chat'], projectIds: null, hideTitles: false } });
assert.equal(bad.status, 400);
assert.equal((await app('/api/notify/preferences', E.token, { method: 'PUT', body: { eventTypes: ['assignment', 'due_soon', 'mention', 'comment', 'task_completed', 'task_due_changed', 'project_membership'], projectIds: null, hideTitles: false } })).status, 200);
ok('N10: "hide titles" sends type + link only; a switched-off type or an unselected project is not queued; invalid preferences -> 400');

// ---------------------------------------------------------------- task_completed / task_due_changed (M5)
const k5 = await newCard('Malování', { due_date: '2026-12-20' });
await assign(k5, E);
await tick();
await db(`/rest/v1/cards?id=eq.${k5}`, { method: 'PATCH', token: O.token, headers: { Prefer: 'return=minimal' }, body: { due_date: '2026-12-22' } });
await tick();
assert.match((await messages()).telegram.filter((x) => x.chatId === 7001).at(-1).text, /změnil\(a\) termín vašeho úkolu „Malování" na 22\. 12\. 2026/);
await db(`/rest/v1/cards?id=eq.${k5}`, { method: 'PATCH', token: O.token, headers: { Prefer: 'return=minimal' }, body: { column_id: DONE } });
await tick();
assert.match((await messages()).telegram.filter((x) => x.chatId === 7001).at(-1).text, /označil\(a\) váš úkol „Malování" jako hotový/);
await db(`/rest/v1/cards?id=eq.${k5}`, { method: 'PATCH', token: E.token, headers: { Prefer: 'return=minimal' }, body: { column_id: TODO, due_date: '2026-12-23' } });
assert.equal((await deliveries(E.id)).filter((d) => d.card_id === k5 && d.status === 'pending').length, 0, 'own changes do not notify me');
ok('M5: due-date change and completion by someone else reach the assignee with the new date; own changes do not');

// ---------------------------------------------------------------- due date reminders (M4, N2, N17) with the test clock
const k6 = await newCard('Předání klíčů', { due_date: '2027-03-29' });
await assign(k6, E);
await tick();
t = await tick('2027-03-28T06:59:00Z');
assert.equal(t.first.dueQueued, 0, 'before 09:00 CEST on the DST day: nothing');
t = await tick('2027-03-28T07:00:00Z');
assert.equal(t.first.dueQueued, 1);
const due = (await messages()).telegram.filter((x) => x.chatId === 7001).at(-1);
assert.match(due.text, /^ClearSpace · Rekonstrukce kanceláře\nZítra \(29\. 3\. 2027\) je termín úkolu „Předání klíčů"\./);
t = await tick('2027-03-28T07:05:00Z');
assert.equal(t.first.dueQueued, 0, 'N1: no second reminder');
ok('M4/N17: reminder at 09:00 Europe/Prague the day before (07:00 UTC on the spring DST day), "Zítra (29. 3. 2027)", exactly once');

// ---------------------------------------------------------------- retry, rate limit, ambiguous timeout (N4, N6)
const k7 = await newCard('Retry 429');
await ctl('fail', { provider: 'telegram', status: 429, retryAfter: 120, count: 1 });
await assign(k7, E);
await tick();
let d7 = (await deliveries(E.id)).find((d) => d.card_id === k7);
assert.equal(d7.status, 'pending'); assert.equal(d7.last_error_code, 'telegram_rate_limited');
assert.ok(Date.parse(d7.next_attempt_at) > Date.now() + 110_000, 'Retry-After (120 s) honoured');
sql(`update public.notification_deliveries set next_attempt_at = now() where id = '${d7.id}'`);
await tick();
d7 = (await deliveries(E.id)).find((d) => d.card_id === k7);
assert.equal(d7.status, 'sent'); assert.equal(d7.attempts, 2);
const k8 = await newCard('Retry 5xx');
await ctl('fail', { provider: 'telegram', status: 502, description: 'Bad Gateway', count: 1 });
await assign(k8, E);
await tick();
assert.equal((await deliveries(E.id)).find((d) => d.card_id === k8).last_error_code, 'telegram_http_502');
const k9 = await newCard('Timeout');
await ctl('fail', { provider: 'telegram', delayMs: 11_000, count: 1 });
await assign(k9, E);
await tick();
const d9 = (await deliveries(E.id)).find((d) => d.card_id === k9);
assert.equal(d9.status, 'failed'); assert.equal(d9.last_error_code, 'ambiguous_timeout');
await sleep(2500);
assert.ok((await messages()).telegram.some((x) => x.text.includes('„Timeout"')), 'the provider DID deliver it after our timeout: exactly why it is never re-sent');
ok('N4/N6: 429 -> retry after Retry-After then sent (attempt 2); 5xx -> retry; timeout after sending -> failed (the provider still delivered it once; never re-sent)');

// burst (N4): 12 assignments -> all delivered, >= 1.1 s apart, no lost message
await ctl('reset', {});
await ctl('telegram-start', { chatId: 7001 });   // the mock forgot the chat on reset: the same chat exists again
sql(`update public.notification_deliveries set status = 'cancelled', last_error_code = 'test_isolation' where status = 'pending'`);   // isolate the burst
const burst = [];
for (let i = 0; i < 12; i++) burst.push(await newCard(`Dávka ${i + 1}`));
for (const k of burst) await assign(k, E);
t = await tick();
assert.equal(t.first.sent, 12);
const bm = (await messages()).telegram.filter((x) => x.chatId === 7001);
assert.equal(bm.length, 12);
for (let i = 1; i < bm.length; i++) assert.ok(bm[i].at - bm[i - 1].at >= 1050, `gap ${bm[i].at - bm[i - 1].at} ms`);
assert.equal((await deliveries(E.id)).filter((d) => burst.includes(d.card_id) && d.status === 'sent').length, 12);
ok('N4: a burst of 12 to one chat is delivered completely, >= 1.1 s apart (provider limit ~1/s per chat)');

// N15: two scheduler ticks at the same moment (pg_cron overlap / a manual tick) -> every message exactly once
const sqlAsync = (q) => promisify(execFile)('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', DBC, 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-q', '-c', q], { encoding: 'utf8' }).then((r) => JSON.parse(r.stdout.trim()));
const conc = [];
for (let i = 0; i < 6; i++) conc.push(await newCard(`Souběh ${i + 1}`));
for (const k of conc) await assign(k, E);
const [ta, tb] = await Promise.all([sqlAsync('select public.notify_scheduler_tick()'), sqlAsync('select public.notify_scheduler_tick()')]);
assert.equal((ta.sent ?? 0) + (tb.sent ?? 0), 6, `claimed ${ta.sent}+${tb.sent}`);
for (const r of [ta.request, tb.request].filter(Boolean)) for (let i = 0; i < 150 && sql(`select count(*) from net._http_response where id = ${r}`) !== '1'; i++) await sleep(400);
sql('select public.notify_scheduler_tick()');
const cm = (await messages()).telegram.filter((x) => x.chatId === 7001 && /Souběh \d/.test(x.text));
assert.equal(cm.length, 6, `messages: ${cm.length}`);
assert.equal(new Set(cm.map((x) => x.text)).size, 6, 'no duplicates');
assert.equal((await deliveries(E.id)).filter((d) => conc.includes(d.card_id) && d.status === 'sent').length, 6);
ok('N15: two concurrent scheduler ticks never claim the same row (SKIP LOCKED) -- 6 messages, each exactly once, all recorded as sent');

// ---------------------------------------------------------------- access lost before sending (N3) + in-app independence (N16)
const k10 = await newCard('Po odebrání');
await assign(k10, F);    // F: Slack (same workspace as O)
await db(`/rest/v1/project_members?project_id=eq.${P}&member_id=eq.${members[F.id]}`, { method: 'DELETE', token: O.token, headers: { Prefer: 'return=minimal' } });
await tick();
const dF = await deliveries(F.id);
assert.equal(dF.find((d) => d.card_id === k10)?.status ?? 'cancelled', 'cancelled', 'N3: removed before sending -> not sent');
assert.ok(!(await messages()).slack.some((x) => x.channel === 'U0MOCKBOHD' && x.text.includes('Po odebrání')));
ok('N3: removed from the project between queueing and sending -> nothing about the project is sent');

await ctl('fail', { provider: 'telegram', status: 503, count: 3 });
const k11 = await newCard('Výpadek poskytovatele');
await assign(k11, E);
await tick();
const inApp = await db(`/rest/v1/notifications?card_id=eq.${k11}&select=type`, { token: E.token });
assert.equal(inApp.json.length, 1, 'in-app notification exists');
assert.equal((await deliveries(E.id)).find((d) => d.card_id === k11).status, 'pending', 'outbox waits for the provider');
ok('N16: provider outage -> in-app notification unaffected, the delivery waits for a retry');

// ---------------------------------------------------------------- blocked bot / revoked Slack (N5)
await ctl('reset', {});
await ctl('telegram-start', { chatId: 7001 });
await ctl('telegram-block', { chatId: 7001, blocked: true });
sql(`update public.notification_deliveries set next_attempt_at = now() where status = 'pending'`);
const k12 = await newCard('Zablokovaný bot');
await assign(k12, E);
await tick();
assert.equal((await channel(E.id, 'telegram')).status, 'blocked');
assert.equal((await deliveries(E.id)).filter((d) => d.status === 'pending').length, 0, 'queue of a blocked channel cancelled');
assert.match((await app('/api/notify/status', E.token)).json.channels.find((c) => c.provider === 'telegram').status, /blocked/);
await ctl('slack-revoke-team', { teamId: 'T0MOCK01' });
const k13 = await newCard('Odvolaný Slack');
await assign(k13, O, E);
await tick();
assert.equal((await channel(O.id, 'slack')).status, 'reconnect');
assert.equal((await channel(O.id, 'slack')).last_error_code, 'slack_invalid_auth');
ok('N5: bot blocked -> channel "blocked", Slack token revoked at Slack -> channel "reconnect"; their queues stop');

// ---------------------------------------------------------------- disconnect (N14) with a shared Slack workspace
await ctl('reset', {});
sql(`delete from public.notification_channels where provider = 'slack' and user_id not in ('${O.id}', '${E.id}', '${F.id}')`);   // other local users of the mock workspace
assert.equal((await slackConnect(O, 'T0MOCK01|U0MOCKANNA')).outcome, 'connected');
assert.equal((await slackConnect(E, 'T0MOCK01|U0MOCKBOHD')).outcome, 'connected');
assert.equal((await ctl('stats')).json.liveSlackTokens, 1, 'one bot token per workspace');
const dE = await app('/api/notify/channel?provider=slack', E.token, { method: 'DELETE' });
assert.deepEqual(dE.json, { removed: true, revoked: null, shared: true });
assert.equal((await ctl('stats')).json.liveSlackTokens, 1, 'shared token NOT revoked');
const dF2 = await app('/api/notify/channel?provider=slack', F.token, { method: 'DELETE' });   // F (same workspace) still had Slack
assert.deepEqual(dF2.json, { removed: true, revoked: null, shared: true });
const dO = await app('/api/notify/channel?provider=slack', O.token, { method: 'DELETE' });
assert.equal(dO.json.revoked, true);
assert.equal((await ctl('stats')).json.liveSlackTokens, 0, 'last user -> token revoked at Slack');
await ctl('telegram-start', { chatId: 7001 });
await admin(`/rest/v1/notification_channels?user_id=eq.${E.id}&provider=eq.telegram`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { status: 'active' } });
const dT = await app('/api/notify/channel?provider=telegram', E.token, { method: 'DELETE' });
assert.equal(dT.json.removed, true);
assert.match((await messages()).telegram.at(-1).text, /odpojená/);
assert.equal((await deliveries(E.id)).length, 0, 'queue deleted with the channel');
assert.equal((await app('/api/notify/channel?provider=telegram', E.token, { method: 'DELETE' })).json.removed, false);
ok('N14: disconnect deletes the credential + queue; Slack revokes the bot token only when no other user of that workspace uses it; Telegram says goodbye');

// ---------------------------------------------------------------- pause (prefs-independent)
await sleep(3100);
assert.equal((await slackConnect(O, 'T0MOCK01|U0MOCKANNA')).outcome, 'connected');
assert.equal((await app('/api/notify/channel', O.token, { method: 'POST', body: { provider: 'slack', enabled: false } })).json.changed, true);
const k14 = await newCard('Pozastaveno');
await assign(k14, O, E);
assert.equal((await deliveries(O.id)).filter((d) => d.card_id === k14).length, 0);
await app('/api/notify/channel', O.token, { method: 'POST', body: { provider: 'slack', enabled: true } });
ok('pausing a channel queues nothing (and drops what was queued)');

// ---------------------------------------------------------------- dispatch endpoint contract (scheduler side)
const garbage = await app('/api/notify/dispatch', null, { method: 'POST', headers: { 'x-notify-secret': SECRET }, body: { items: [{ id: '00000000-0000-4000-8000-000000000000', provider: 'slack', channelId: 'nope' }, 'x'] } });
assert.equal(garbage.status, 200);
assert.deepEqual(garbage.json.results, [{ id: '00000000-0000-4000-8000-000000000000', outcome: 'failed', code: 'invalid_item' }]);
const forged = await app('/api/notify/dispatch', null, { method: 'POST', headers: { 'x-notify-secret': SECRET }, body: { items: [{ id: '00000000-0000-4000-8000-000000000001', provider: 'telegram', channelId: '00000000-0000-4000-8000-000000000002', secret: 'v1.00000000.aaaa.bbbb.cccc', kind: 'assignment', title: 'x' }] } });
assert.equal(forged.json.results[0].outcome, 'reconnect'); assert.equal(forged.json.results[0].code, 'undecryptable');
ok('dispatch: malformed items -> failed invalid_item; a forged / foreign credential envelope cannot be decrypted (AAD-bound) -> nothing sent');

// ---------------------------------------------------------------- logs
if (APP_LOG && existsSync(APP_LOG)) {
  const log = readFileSync(APP_LOG, 'utf8');
  for (const leak of ['xoxb-', 'MOCKmockMOCK', 'U0MOCK', 'T0MOCK', '7001', tokE, tokV, 'TAJNÝ', 'Objednat nábytek', 'evil.example', '/api/notify/slack/callback?', 'code='])
    assert.ok(!log.includes(leak), `dev server log contains ${leak}`);
  ok('N13: dev server log: no tokens, Slack / team / chat ids, link tokens, OAuth codes, titles or comment text');
}
console.log(`\nNotify HTTP: ${passed} groups passed (SIMULATED Slack + Telegram -- not a live result)`);
