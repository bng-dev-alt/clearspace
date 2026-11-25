// RUN 03 -- Gmail integration: HTTP-level integration + adversarial suite against a REAL local stack (GoTrue + PostgREST,
// scripts/gmail-stack.sh), the REAL Next.js app (route handlers) and the Google/Gmail MOCK. Everything Google here is
// SIMULATED (scripts/google-mock.mjs): this proves our flow and our boundaries, not Google's own behaviour. Loopback only.
//
//   eval "$(scripts/gmail-stack.sh env)"; node supabase/tests/gmail_http.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY;
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY;
const APP = process.env.E2E_BASE_URL;
const MOCK = process.env.GOOGLE_MOCK_URL;
const APP_LOG = process.env.APP_LOG;   // optional: the dev server's log, checked for leaks at the end
for (const u of [API, APP, MOCK]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: every endpoint must be loopback'); process.exit(2); }
}
if (!ANON || !SERVICE) { console.error('missing keys'); process.exit(2); }

const run = Date.now().toString(36);
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';

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

async function user(tag) {
  const email = `${tag}-${run}@example.test`;
  const c = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password: 'Test-Password-123', email_confirm: true } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const l = await db('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'Test-Password-123' } });
  return { id: l.json.user.id, email, token: l.json.access_token };
}

/** Full authorization-code flow for one service (start -> mock consent -> callback -> complete under the session). */
async function connect(u, account, { service = 'drive', decision = 'allow', grantDrive = true, grantGmail = true, returnTo = '/settings' } = {}) {
  const s = await app('/api/google/oauth/start', u.token, { method: 'POST', body: { returnTo, service } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const cookie = /cs_google_oauth=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1];
  const auth = new URL(s.json.url);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'include_granted_scopes', 'login_hint']) form.set(k, auth.searchParams.get(k) ?? '');
  form.set('account', account); form.set('decision', decision);
  if (grantDrive) form.set('grant_drive', '1');
  if (grantGmail) form.set('grant_gmail', '1');
  const back = await http(`${MOCK}/o/oauth2/v2/consent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: form.toString() });
  assert.equal(back.status, 302);
  const r1 = await http(back.headers.get('location'));
  assert.equal(r1.status, 303);
  const parked = /cs_google_oauth_result=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1];
  const r = await app('/api/google/oauth/complete', u.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${cookie}; cs_google_oauth_result=${parked}` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { outcome: r.json.outcome, auth, text: r.text };
}
const ANNA = '100000000000000000001', BOHDAN = '100000000000000000002', CYRIL = '100000000000000000003';
const status = async (u) => (await app('/api/google/connection', u.token)).json;
async function expire(u) {
  await ctl('expire-access', {});
  await admin(`/rest/v1/google_connections?user_id=eq.${u.id}`, { method: 'PATCH', body: { access_expires_at: new Date(Date.now() - 1000).toISOString() } });
}
const search = (u, q = {}) => app(`/api/gmail/search?${new URLSearchParams({ kind: 'thread', ...q })}`, u.token);

await ctl('reset', {});
await admin(`/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE' });
const annaIds = (await ctl('gmail-ids', { email: 'anna.mock@example.test' })).json;
const bobIds = (await ctl('gmail-ids', { email: 'bohdan.mock@example.test' })).json;
const id = (subj) => annaIds.find((m) => m.subject === subj);
const T_OFFER = id('Nabídka na redesign portálu – Corvane').threadId, M_INVOICE = id('Faktura 2026-118 za listopad').id,
  M_NEWS = id('Newsletter: novinky listopadu').id, M_1250 = id('Objednávka – kódování windows-1250').id, M_BROKEN = id('Chybné kódování').id,
  M_LONG = id('Dlouhá zpráva – specifikace').id, M_EMPTY = id('Bez obsahu').id, M_DELETED = id('Smazaná zpráva').id,
  M_XSS = annaIds.find((m) => m.subject.startsWith('<script>')).id, B_THREAD = bobIds[0].threadId;

// ---------------------------------------------------------------- fixture
const O = await user('gm-own'), E = await user('gm-ed'), V = await user('gm-view'), X = await user('gm-out'), D = await user('gm-drv');
const P = `p-gmail-${run}`, CARD = `${P}-card-1`;
for (const r of [
  await db('/rest/v1/projects', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: P, name: 'Gmail projekt' } }),
  await db('/rest/v1/columns', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: `${P}-col`, project_id: P, name: 'Naplánováno', position: 0 } }),
  await db('/rest/v1/project_members', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { project_id: P, member_id: `member-owner-${O.id}` } }),
  await db('/rest/v1/cards', { method: 'POST', token: O.token, body: { id: CARD, column_id: `${P}-col`, title: 'Připravit smlouvu', details: '' } }),
]) assert.ok(r.status < 300, JSON.stringify(r.json));
for (const [u, role, name] of [[E, 'member', 'Eva Editorka'], [V, 'viewer', 'Viktor Čtenář'], [D, 'member', 'Dan Diskový']]) {
  const inv = await rpc('create_project_invitation', { p_project_id: P, p_email: u.email, p_role: role }, O.token);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  assert.equal((await rpc('accept_workspace_invitation', { p_token: inv.json[0].token, p_display_name: name }, u.token)).status, 200);
}
ok('fixture: owner, editor, viewer, Drive-only editor on one project + an outsider');

// ---------------------------------------------------------------- unauthenticated, invalid input, no connection
for (const [m, p] of [['GET', '/api/gmail/search'], ['POST', '/api/gmail/links'], ['GET', '/api/gmail/links/00000000-0000-4000-8000-000000000000/preview'], ['POST', '/api/gmail/links/00000000-0000-4000-8000-000000000000/refresh'], ['DELETE', '/api/gmail/connection']]) {
  const r = await app(p, null, { method: m, body: m === 'POST' ? {} : undefined });
  assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
}
ok('every Gmail endpoint refuses an unauthenticated call (401)');
let st = await status(O);
assert.equal(st.gmailAvailable, true); assert.equal(st.simulated, true); assert.equal(st.connection, null);
ok('status: Gmail available on this server, provider flagged SIMULATED, not connected');
let r = await search(O);
assert.equal(r.status, 409); assert.equal(r.json.error, 'not_connected');
r = await app('/api/google/oauth/start', O.token, { method: 'POST', body: { service: 'gmail-all' } });
assert.equal(r.status, 400);
ok('no Google connection -> 409 not_connected; unknown service -> 400');

// ---------------------------------------------------------------- incremental authorization next to Drive
let c = await connect(O, ANNA);
assert.equal(c.outcome, 'connected');
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: false });
assert.ok(!st.connection.scopes.includes(GMAIL));
r = await search(O);
assert.equal(r.status, 409); assert.equal(r.json.error, 'gmail_not_granted');
ok('Drive connected first: Gmail calls refused (gmail_not_granted) before any Gmail request');

let stats0 = (await ctl('stats')).json;
c = await connect(O, ANNA, { service: 'gmail', grantGmail: false });
assert.equal(c.outcome, 'gmail_denied');
assert.equal(new URL(c.auth).searchParams?.get?.('x') ?? null, null);
assert.equal(c.auth.searchParams.get('include_granted_scopes'), 'true');
assert.equal(c.auth.searchParams.get('scope'), `openid email ${GMAIL}`);
assert.equal(c.auth.searchParams.get('login_hint'), 'anna.mock@example.test');
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: false });
assert.equal(st.connection.status, 'active');
assert.equal((await ctl('stats')).json.revocations, stats0.revocations, 'no revocation');
assert.equal((await app('/api/google/picker-token', O.token, { method: 'POST', body: {} })).status, 200);
ok('incremental Gmail consent refused on Google\'s screen: gmail_denied, Drive connection untouched and still usable, nothing revoked');

stats0 = (await ctl('stats')).json;
c = await connect(O, BOHDAN, { service: 'gmail' });
assert.equal(c.outcome, 'account_mismatch');
st = await status(O);
assert.equal(st.connection.email, 'anna.mock@example.test'); assert.deepEqual(st.connection.services, { drive: true, gmail: false });
assert.equal((await ctl('stats')).json.revocations, stats0.revocations + 1, 'the unused grant of the OTHER (unconnected) account is revoked');
ok('Gmail from a different Google account: refused (account_mismatch), connected account unchanged, the stray grant revoked');

c = await connect(O, ANNA, { service: 'gmail' });
assert.equal(c.outcome, 'gmail_connected');
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: true });
assert.ok(st.connection.scopes.includes(DRIVE) && st.connection.scopes.includes(GMAIL));
const audit = await db(`/rest/v1/integration_audit?select=event,detail&user_id=eq.${O.id}&order=id`, { token: O.token });
assert.ok(audit.json.some((a) => a.event === 'service_added' && a.detail === 'gmail'));
assert.ok(audit.json.some((a) => a.event === 'scope_denied' && a.detail === 'gmail'));
assert.equal((await db(`/rest/v1/integration_audit?select=id&user_id=eq.${O.id}`, { token: X.token })).json.length, 0);
ok('Gmail added incrementally: one grant, both services; audited (service_added / scope_denied); audit private to its user');

// ---------------------------------------------------------------- Picker token never carries Gmail
stats0 = (await ctl('stats')).json;
r = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(r.status, 200);
assert.equal((await ctl('stats')).json.narrowRefreshes, stats0.narrowRefreshes + 1);
const gm = await http(`${MOCK}/gmail/v1/users/me/messages`, { headers: { Authorization: `Bearer ${r.json.accessToken}` } });
assert.equal(gm.status, 403, 'the browser token cannot read Gmail');
const pf = await http(`${MOCK}/picker/files`, { headers: { Authorization: `Bearer ${r.json.accessToken}`, 'X-Picker-Key': 'k', 'X-Picker-App': '1' } });
assert.equal(pf.status, 200, 'but still works for the Picker');
ok('browser (Picker) token is downscoped to Drive: Gmail 403 with it, Picker works');

// ---------------------------------------------------------------- search: pagination, filters, bounds
r = await search(O);
assert.equal(r.status, 200);
assert.ok(r.json.items.length >= 9 && r.json.items.length <= 10 && r.json.nextPageToken, `first page <= 10 (one item deleted between list and get is skipped) + next page: ${r.json.items.length}`);
assert.equal(r.headers.get('cache-control'), 'no-store, private');
const page2 = await search(O, { pageToken: r.json.nextPageToken });
assert.equal(page2.status, 200);
assert.ok(page2.json.items.every((i) => !r.json.items.some((j) => j.id === i.id)), 'page 2 does not repeat page 1');
r = await search(O, { kind: 'message', text: 'Duplicita' });
assert.equal(r.json.items.length, 1, 'duplicate ids in the list are returned once');
r = await search(O, { kind: 'message', text: 'smazaná' });
assert.equal(r.json.items.length, 0, 'deleted between list and get: skipped, not an error');
r = await search(O, { from: 'Jana', subject: 'redesign' });
assert.deepEqual(r.json.items.map((i) => i.id), [T_OFFER]);
assert.equal(r.json.items[0].messageCount, 3);
r = await search(O, { kind: 'message', after: '2026-11-15', before: '2026-11-16' });
assert.ok(r.json.items.length >= 2 && r.json.items.every((i) => i.date >= '2026-11-15'));
r = await search(O, { text: 'nic-takoveho-neexistuje' });
assert.deepEqual(r.json, { items: [], nextPageToken: null, estimate: 0 });
for (const q of [{ kind: 'all' }, { pageToken: '../../x' }, { pageSize: '0' }, { pageSize: '21' }, { text: 'x'.repeat(301) }]) {
  assert.equal((await search(O, q)).status, 400, JSON.stringify(q));
}
r = await search(O, { kind: 'message', text: 'Předmět s HTML' });
assert.ok(r.json.items[0].subject.includes('<script>') && !/‮/.test(r.json.items[0].subject), 'markup kept as inert text, bidi stripped');
ok('search: <=10/page + next page, filters (from/subject/dates/text), duplicates + deleted handled, empty result, input bounds (400), no-store');

// ---------------------------------------------------------------- attach: shared metadata only; forged / cross-account ids
r = await app('/api/gmail/links', O.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'thread', id: T_OFFER }] } });
assert.equal(r.status, 201, JSON.stringify(r.json));
const L_OFFER = r.json.links[0].id;
r = await app('/api/gmail/links', O.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'thread', id: T_OFFER }] } });
assert.equal(r.status, 200); assert.equal(r.json.links[0].duplicate, true); assert.equal(r.json.links[0].id, L_OFFER);
r = await app('/api/gmail/links', O.token, { method: 'POST', body: { projectId: P, cardId: CARD, items: [{ kind: 'message', id: M_INVOICE }, { kind: 'message', id: M_BROKEN }, { kind: 'message', id: M_NEWS }, { kind: 'message', id: M_1250 }, { kind: 'message', id: M_LONG }, { kind: 'message', id: M_EMPTY }, { kind: 'message', id: M_XSS }] } });
assert.equal(r.status, 201); assert.equal(r.json.links.length, 7);
const L = Object.fromEntries(r.json.links.map((l) => [l.itemId, l.id]));
const rows = (await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=*`, { token: V.token })).json;
assert.equal(rows.length, 8, 'viewer sees all 8 links');
const raw = JSON.stringify(rows);
for (const gid of [T_OFFER, M_INVOICE, M_NEWS]) assert.ok(!raw.includes(gid), 'no Gmail id in any shared column');
assert.ok(!/[a-z0-9._%+-]+@[a-z0-9-]+\.(example|test)/i.test(raw), 'no full e-mail address (local@domain) in shared rows -- at most a sender DOMAIN');
assert.ok(!/Rozpočet: 520 000|Splatnost|Kapitola/.test(raw), 'no body text in shared rows');
const offer = rows.find((x) => x.id === L_OFFER);
assert.equal(offer.web_url, null); assert.equal(offer.provider, 'gmail_thread'); assert.equal(offer.email_count, 3); assert.equal(offer.email_from, 'Jana Dvořáková (simulace)');
assert.equal(rows.find((x) => x.id === L[M_BROKEN]).email_from, '@chyby.example');
ok('attach: 201, duplicates return the same link, shared rows = subject/sender name or domain/date/count; no Gmail id, address or body anywhere');

r = await app('/api/gmail/links', O.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'thread', id: B_THREAD }] } });
assert.equal(r.status, 200); assert.equal(r.json.links.length, 0); assert.equal(r.json.failed[0].reason, 'not_found');
r = await app('/api/gmail/links', O.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'message', id: 'ffffffffffffffff' }] } });
assert.equal(r.json.failed[0].reason, 'not_found');
for (const body of [{ projectId: P, items: [{ kind: 'message', id: '../../etc' }] }, { projectId: P, items: [{ kind: 'draft', id: M_INVOICE }] }, { projectId: P, items: [] },
  { projectId: P, items: Array.from({ length: 11 }, (_, i) => ({ kind: 'message', id: (0x18c3a5e000000000n + BigInt(i)).toString(16) })) }, { projectId: 'x y', items: [{ kind: 'message', id: M_INVOICE }] }]) {
  assert.equal((await app('/api/gmail/links', O.token, { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 80));
}
assert.equal((await app('/api/gmail/links', O.token, { method: 'POST', raw: 'x'.repeat(20_000) })).status, 413);
ok('forged / cross-account ids are "not found" in the caller\'s own mailbox (nothing linked); malformed ids, kinds, >10 items, oversized body refused');

for (const [u, code, status] of [[V, 'forbidden', 403], [X, 'forbidden', 403], [E, 'not_connected', 409]]) {
  r = await app('/api/gmail/links', u.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'message', id: M_INVOICE }] } });
  assert.equal(r.status, status, `${u.email} -> ${r.status}`); assert.equal(r.json.error, code);
}
await connect(D, CYRIL);   // Drive only
r = await app('/api/gmail/links', D.token, { method: 'POST', body: { projectId: P, items: [{ kind: 'message', id: M_INVOICE }] } });
assert.equal(r.status, 409); assert.equal(r.json.error, 'gmail_not_granted');
ok('attach refused: viewer / outsider (403), editor without Google (409), editor with Drive only (gmail_not_granted)');

// editor connects Gmail ONLY (first connection, no Drive) and links their own conversation
c = await connect(E, BOHDAN, { service: 'gmail' });
assert.equal(c.outcome, 'gmail_connected');
st = await status(E);
assert.deepEqual(st.connection.services, { drive: false, gmail: true });
assert.equal((await app('/api/google/picker-token', E.token, { method: 'POST', body: {} })).json.error, 'drive_not_granted');
r = await app('/api/gmail/links', E.token, { method: 'POST', body: { projectId: P, cardId: CARD, items: [{ kind: 'thread', id: B_THREAD }, { kind: 'thread', id: T_OFFER }] } });
assert.equal(r.status, 201); assert.equal(r.json.links.length, 1); assert.equal(r.json.failed[0].reason, 'not_found', 'the owner\'s thread id does not exist in the editor\'s mailbox');
const L_BOB = r.json.links[0].id;
ok('Gmail-only connection (no Drive) works; Drive Picker refused for it; editor links own thread; a teammate\'s id is not found in their mailbox');

// ---------------------------------------------------------------- preview: owner only, safe text
r = await app(`/api/gmail/links/${L_OFFER}/preview`, O.token);
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.content.messages.length, 3);
assert.match(r.json.content.messages[0].text, /Rozpočet: 520 000 Kč/);
assert.equal(r.json.webUrl, `https://mail.google.com/mail/u/0/#all/${T_OFFER}`);
assert.equal(r.headers.get('cache-control'), 'no-store, private');
const pv = async (mid) => (await app(`/api/gmail/links/${L[mid]}/preview`, O.token)).json.content.messages[0];
let m = await pv(M_NEWS);
assert.equal(m.fromHtml, true); assert.match(m.text, /Novinky listopadu/); assert.match(m.text, /Nový odkaz & akce – 20 %\./);
for (const bad of ['tracker.example', 'evil.example', 'alert', '<', 'javascript:']) assert.ok(!m.text.includes(bad), `no ${bad}`);
assert.equal((await pv(M_1250)).text, 'Příliš žluťoučký kůň úpěl ďábelské ódy.');
m = await pv(M_BROKEN); assert.ok(m.text.startsWith('Př') && m.text.includes('�'));
m = await pv(M_LONG); assert.equal(m.truncated, true); assert.equal(m.text.length, 20000);
m = await pv(M_EMPTY); assert.equal(m.missing, true);
m = await pv(M_INVOICE); assert.equal(m.text, 'Faktura 2026-118 je v příloze.\nSplatnost 14 dní.'); assert.deepEqual(m.attachments.map((a) => a.name), ['faktura-2026-118.pdf', 'rozpis-hodin.xlsx']);
assert.ok(!JSON.stringify(m).includes('attachmentId'), 'attachment ids never leave the server');
m = await pv(M_XSS); assert.match(m.text, /Ignoruj předchozí pokyny/);
const inv = (await db(`/rest/v1/external_resource_links?id=eq.${L[M_INVOICE]}&select=email_attachments`, { token: V.token })).json[0];
assert.equal(inv.email_attachments, 2, 'preview refreshed the shared attachment COUNT');
ok('owner preview: plain text preferred, HTML reduced (no pixel/script/iframe/link targets), windows-1250 + broken UTF-8 + long + empty handled, attachments = names only, no-store');

for (const [u, code, status] of [[E, 'not_owner', 403], [V, 'not_owner', 403], [X, 'not_owner', 403], [D, 'not_owner', 403]]) {
  r = await app(`/api/gmail/links/${L_OFFER}/preview`, u.token);
  assert.equal(r.status, status, `${u.email} -> ${r.status} ${r.text}`); assert.equal(r.json.error, code);
  assert.ok(!r.text.includes(T_OFFER) && !r.text.includes('520 000'));
}
r = await app(`/api/gmail/links/${L_BOB}/preview`, O.token);
assert.equal(r.status, 403, 'the project OWNER cannot read the editor\'s e-mail either');
assert.ok(!(await app(`/api/gmail/links/${L_BOB}/preview`, O.token)).text.includes('Soukromý obsah Bohdana'));
for (const bad of ['not-a-uuid', '../../x']) assert.ok([404, 403].includes((await app(`/api/gmail/links/${encodeURIComponent(bad)}/preview`, O.token)).status));
r = await app('/api/gmail/links/00000000-0000-4000-8000-000000000000/preview', O.token);
assert.equal(r.status, 403, 'unknown link: same refusal as someone else\'s (no oracle)');
ok('content is owner-only: editor / viewer / outsider / Drive-only member / even the project owner get 403 without any id or text');

// ---------------------------------------------------------------- refresh, deleted, trashed, realtime-visible metadata
await ctl('gmail-trash', { id: M_INVOICE });
r = await app(`/api/gmail/links/${L[M_INVOICE]}/refresh`, O.token, { method: 'POST', body: {} });
assert.equal(r.status, 200); assert.equal(r.json.state, 'trashed');
await ctl('gmail-delete', { id: M_INVOICE });
r = await app(`/api/gmail/links/${L[M_INVOICE]}/refresh`, O.token, { method: 'POST', body: {} });
assert.deepEqual(r.json, { state: 'deleted', updated: true });
r = await app(`/api/gmail/links/${L[M_INVOICE]}/preview`, O.token);
assert.equal(r.status, 404); assert.equal(r.json.error, 'deleted');
assert.equal((await db(`/rest/v1/external_resource_links?id=eq.${L[M_INVOICE]}&select=provider_state`, { token: V.token })).json[0].provider_state, 'deleted');
r = await app(`/api/gmail/links/${L_OFFER}/refresh`, E.token, { method: 'POST', body: {} });
assert.equal(r.status, 403);
ok('owner refresh: trashed / deleted recorded and shown to the team (provider_state); others cannot refresh');

// ---------------------------------------------------------------- provider failures, token refresh, concurrency
// count = failures the mock injects: 429 / 5xx are retried once (2 consumed), 403 is final (1 consumed)
for (const [mode, n, status, code] of [['gmail_rate_limit', 2, 429, 'rate_limited'], ['gmail_unavailable', 2, 503, 'unavailable'], ['gmail_forbidden', 1, 403, 'forbidden']]) {
  await ctl('fail', { mode, count: n });
  r = await search(O);
  assert.equal(r.status, status, `${mode} -> ${r.status}`); assert.equal(r.json.error, code); assert.match(r.json.message, /Gmail|Google/);
  assert.equal((await search(O, { pageSize: '1' })).status, 200, `${mode}: recovers on the next request`);
}
await ctl('fail', { mode: 'gmail_unauthorized', count: 1 });
assert.equal((await search(O)).status, 200, 'a 401 from Gmail triggers exactly one forced token refresh, then succeeds');
await expire(O);
stats0 = (await ctl('stats')).json;
const par = await Promise.all(Array.from({ length: 5 }, () => search(O, { pageSize: '1' })));
assert.ok(par.every((x) => x.status === 200), par.map((x) => x.status).join(','));
assert.equal((await ctl('stats')).json.refreshes, stats0.refreshes + 1, 'five concurrent requests -> exactly one refresh');
ok('Gmail 429/503/403 -> Czech errors with matching status (one retry on 429/5xx); 401 -> one forced refresh; expired token: 5 concurrent requests, 1 refresh');

// ---------------------------------------------------------------- OAuth hardening (shared with RUN 02, now per service)
const s1 = await app('/api/google/oauth/start', O.token, { method: 'POST', body: { service: 'gmail', returnTo: 'https://evil.example' } });
assert.equal(new URL(s1.json.url).searchParams.get('redirect_uri'), `${APP}/api/google/oauth/callback`);
r = await app('/api/google/oauth/complete', O.token, { method: 'POST', headers: { Cookie: 'cs_google_oauth=forged; cs_google_oauth_result={"state":"x","code":"y"}' } });
assert.equal(r.json.outcome, 'expired');
r = await app('/api/google/oauth/complete', X.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${/cs_google_oauth=([^;]+)/.exec(s1.headers.get('set-cookie'))[1]}` } });
assert.equal(r.json.outcome, 'expired', 'another session cannot complete it');
ok('Gmail consent uses the same hardened flow: fixed redirect URI, forged state/cookies -> expired, session-bound completion');

// ---------------------------------------------------------------- Gmail off in ClearSpace (Drive untouched) + purge
r = await app('/api/gmail/connection', O.token, { method: 'DELETE' });
assert.equal(r.status, 200); assert.equal(r.json.gmailRemoved, true); assert.equal(r.json.purged, null);
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: false }); assert.equal(st.connection.status, 'active');
assert.equal((await search(O)).json.error, 'gmail_not_granted');
r = await app(`/api/gmail/links/${L_OFFER}/preview`, O.token);
assert.equal(r.status, 409, 'no preview after Gmail was switched off'); assert.equal(r.json.error, 'gmail_not_granted');
const pt = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(pt.status, 200);
assert.equal((await http(`${MOCK}/gmail/v1/users/me/messages`, { headers: { Authorization: `Bearer ${pt.json.accessToken}` } })).status, 403, 'the Picker token still cannot read Gmail (grant at Google still holds it)');
c = await connect(O, ANNA, { service: 'drive' });
assert.equal(c.outcome, 'connected');
assert.deepEqual((await status(O)).connection.services, { drive: true, gmail: false }, 'reconnecting Drive does not silently re-enable Gmail although Google still returns it');
r = await app('/api/gmail/connection?purge=1', O.token, { method: 'DELETE' });
assert.equal(r.json.gmailRemoved, false); assert.deepEqual(r.json.purged, { removed: 8, skipped: 0 });
assert.equal((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&provider=neq.google_drive&select=id`, { token: V.token })).json.length, 1, 'only the editor\'s e-mail remains');
ok('"Vypnout Gmail": Gmail calls stop, Drive keeps working, Picker token stays Gmail-free, Drive reconnect keeps Gmail off; purge removes exactly my 8 e-mail links');

// ---------------------------------------------------------------- full disconnect: whole grant revoked (Drive + Gmail)
stats0 = (await ctl('stats')).json;
r = await app('/api/google/connection', E.token, { method: 'DELETE' });
assert.equal(r.json.revokedAtGoogle, true);
assert.equal((await ctl('stats')).json.liveRefreshTokens < stats0.liveRefreshTokens, true);
assert.equal((await status(E)).connection, null);
r = await app(`/api/gmail/links/${L_BOB}/preview`, E.token);
assert.equal(r.status, 409, 'after disconnect: no content'); assert.equal(r.json.error, 'not_connected');
assert.equal((await db(`/rest/v1/external_resource_links?id=eq.${L_BOB}&select=name`, { token: O.token })).json[0].name, 'Bohdanova soukromá konverzace');
ok('full disconnect revokes the whole grant at the provider; the editor\'s link keeps only its shared metadata; no content without reconnecting');

// ---------------------------------------------------------------- provider-side revocation
await connect(E, BOHDAN, { service: 'gmail' });
await ctl('revoke-account', { email: 'bohdan.mock@example.test' });
await expire(E);
r = await search(E);
assert.equal(r.status, 409); assert.equal(r.json.error, 'revoked');
assert.equal((await status(E)).connection.status, 'revoked');
ok('grant revoked at Google: next refresh -> connection marked revoked, Czech "reconnect" error');

// ---------------------------------------------------------------- feature switch + logs
if (APP_LOG && existsSync(APP_LOG)) {
  const log = readFileSync(APP_LOG, 'utf8');
  for (const leak of ['mock-at.', 'mock-rt.', 'mock-code.', 'Rozpočet: 520 000', 'Splatnost 14 dní', 'žluťoučký', 'anna.mock@', 'jana.dvorakova', T_OFFER, M_INVOICE, '/api/gmail/search?', 'code=mock']) {
    assert.ok(!log.includes(leak), `dev server log contains ${leak}`);
  }
  ok('dev server log: no tokens, codes, e-mail bodies, addresses, Gmail ids or search URLs');
}
console.log(`\nGMAIL HTTP SUITE: ${passed} groups passed`);
