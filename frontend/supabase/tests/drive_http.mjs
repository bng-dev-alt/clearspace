// RUN 02 -- Google Drive integration: HTTP-level integration + adversarial suite against a REAL local stack
// (GoTrue + PostgREST, scripts/drive-stack.sh), the REAL Next.js app (route handlers) and the Google MOCK.
// Everything Google here is SIMULATED (scripts/google-mock.mjs): this proves our flow and our boundaries,
// not Google's own behaviour. Refuses anything that is not loopback.
//
//   eval "$(scripts/drive-stack.sh env)"; node supabase/tests/drive_http.mjs
import assert from 'node:assert/strict';

const API = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY;
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY;
const APP = process.env.E2E_BASE_URL;
const MOCK = process.env.GOOGLE_MOCK_URL;
for (const u of [API, APP, MOCK]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: every endpoint must be loopback'); process.exit(2); }
}
if (!ANON || !SERVICE) { console.error('missing keys'); process.exit(2); }

const run = Date.now().toString(36);
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const TOKEN_RE = /mock-(at|rt|code)\./;

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

/**
 * Full authorization-code flow: app start -> mock consent -> Google redirect to our callback (no session) ->
 * /oauth/google page completes it under the user's session (POST /api/google/oauth/complete). `tamper` may swap the
 * callback URL, the browser's nonce cookie, or the session that completes it.
 */
async function connect(u, account, { decision = 'allow', grantDrive = true, returnTo = '/settings', tamper } = {}) {
  const s = await app('/api/google/oauth/start', u.token, { method: 'POST', body: { returnTo } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const cookie = /cs_google_oauth=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie, 'nonce cookie set');
  const auth = new URL(s.json.url);
  const consent = await http(auth.toString());
  assert.equal(consent.status, 200);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']) form.set(k, auth.searchParams.get(k) ?? '');
  form.set('account', account); form.set('decision', decision); if (grantDrive) form.set('grant_drive', '1');
  const back = await http(`${MOCK}/o/oauth2/v2/consent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: form.toString() });
  assert.equal(back.status, 302);
  let cb = back.headers.get('location');
  let ck = cookie;
  let completer = u;
  if (tamper) ({ cb = cb, ck = ck, completer = u } = tamper({ cb, ck, auth }));
  const r1 = await http(cb);
  assert.equal(r1.status, 303); assert.equal(r1.headers.get('location'), `${APP}/oauth/google`);
  assert.ok(!/code=/.test(r1.headers.get('location')), 'the code never lands in a page URL');
  const parked = /cs_google_oauth_result=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1];
  const r = await app('/api/google/oauth/complete', completer.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${ck}; cs_google_oauth_result=${parked}` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { outcome: r.json.outcome, returnTo: r.json.returnTo, cb, cookie, parked, setCookie: r.headers.get('set-cookie') ?? '', text: r.text };
}
const ANNA = '100000000000000000001', BOHDAN = '100000000000000000002', CYRIL = '100000000000000000003';
const DOC = 'mockDoc_SmlouvaCorvane01', SHEET = 'mockSheet_RozpocetQ1_01', ZAPIS = 'mockDoc_ZapisPorady1211', MD = 'mockTxt_Poznamky000001',
  XSS = 'mockXss_Soubor00000001', BPRIV = 'mockDoc_BohdanPrivat01', PDF = 'mockPdf_Specifikace0001';
/** Access token expiry: at the provider AND in our stored expiry (what a real hour passing does). */
async function expire(u) {
  await ctl('expire-access', {});
  const r = await admin(`/rest/v1/google_connections?user_id=eq.${u.id}`, { method: 'PATCH', body: { access_expires_at: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(r.status, 200);
}
async function pick(u, ids) {   // what the Picker does: the user selects files -> drive.file grant for this app
  const t = await app('/api/google/picker-token', u.token, { method: 'POST', body: {} });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const g = await http(`${MOCK}/picker/grant`, { method: 'POST', headers: { Authorization: `Bearer ${t.json.accessToken}`, 'Content-Type': 'application/json' }, body: { ids } });
  assert.equal(g.status, 200);
}

await ctl('reset', {});
// previous runs on this local stack may still hold the mock Google accounts (one account <-> one ClearSpace user)
await admin(`/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE' });
// ---------------------------------------------------------------- fixture: owner / editor / viewer / outsider
const O = await user('drive-own'), E = await user('drive-ed'), V = await user('drive-view'), X = await user('drive-out');
const P = `p-drive-${run}`, CARD = `${P}-card-1`;
for (const r of [
  await db('/rest/v1/projects', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: P, name: 'Drive projekt' } }),
  await db('/rest/v1/columns', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: `${P}-col`, project_id: P, name: 'Naplánováno', position: 0 } }),
  await db('/rest/v1/project_members', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { project_id: P, member_id: `member-owner-${O.id}` } }),
  await db('/rest/v1/cards', { method: 'POST', token: O.token, body: { id: CARD, column_id: `${P}-col`, title: 'Připravit smlouvu', details: '' } }),
]) assert.ok(r.status < 300, JSON.stringify(r.json));
for (const [u, role, name] of [[E, 'member', 'Eva Editorka'], [V, 'viewer', 'Viktor Čtenář']]) {
  const inv = await rpc('create_project_invitation', { p_project_id: P, p_email: u.email, p_role: role }, O.token);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const a = await rpc('accept_workspace_invitation', { p_token: inv.json[0].token, p_display_name: name }, u.token);
  assert.equal(a.status, 200, JSON.stringify(a.json));
}
ok('fixture: owner, editor, viewer on one project + an outsider (fresh accounts, local GoTrue)');

// ---------------------------------------------------------------- unauthenticated + status
for (const [m, p] of [['GET', '/api/google/connection'], ['DELETE', '/api/google/connection'], ['POST', '/api/google/oauth/start'], ['POST', '/api/google/picker-token'], ['POST', '/api/drive/links'], ['POST', '/api/drive/links/refresh'], ['GET', '/api/drive/links/00000000-0000-4000-8000-000000000000/content']]) {
  const r = await app(p, null, { method: m, body: m === 'GET' || m === 'DELETE' ? undefined : {} });
  assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
}
ok('every integration endpoint refuses an unauthenticated call (401)');
let st = await app('/api/google/connection', O.token);
assert.equal(st.status, 200); assert.equal(st.json.configured, true); assert.equal(st.json.simulated, true); assert.equal(st.json.connection, null);
ok('status: configured, clearly flagged as SIMULATED provider, not connected');

// ---------------------------------------------------------------- OAuth: consent, denial, granular scope
let c = await connect(O, ANNA, { decision: 'deny' });
assert.equal(c.outcome, 'denied'); assert.equal(c.returnTo, '/settings');
assert.equal((await app('/api/google/connection', O.token)).json.connection, null);
ok('denied consent -> ?google=denied, nothing stored');
const before = (await ctl('stats')).json;
c = await connect(O, ANNA, { grantDrive: false });
assert.equal(c.outcome, 'scope_denied');
assert.equal((await app('/api/google/connection', O.token)).json.connection, null);
assert.equal((await ctl('stats')).json.revocations, before.revocations + 1);
ok('granular consent without Drive -> scope_denied, nothing stored, the grant is revoked at the provider');

c = await connect(O, ANNA, { returnTo: `/projects/${P}` });
assert.equal(c.outcome, 'connected'); assert.equal(c.returnTo, `/projects/${P}`);
assert.match(c.setCookie, /cs_google_oauth=;/); assert.match(c.setCookie, /cs_google_oauth_result=;/);
st = await app('/api/google/connection', O.token);
assert.equal(st.json.connection.email, 'anna.mock@example.test');
assert.ok(st.json.connection.scopes.includes('https://www.googleapis.com/auth/drive.file'));
assert.ok(!st.json.connection.scopes.some((s) => /gmail|calendar|auth\/drive($|\.readonly|\.metadata)/.test(s)), 'no broader scopes');
assert.ok(!TOKEN_RE.test(st.text) && !TOKEN_RE.test(c.text), 'no token in status or completion response');
ok('connect: PKCE code flow, redirect to the validated return path, nonce cookie cleared, only openid/email/drive.file granted, no token exposed');

// replay the same completion (same state, same cookies, same code)
let r = await app('/api/google/oauth/complete', O.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${c.cookie}; cs_google_oauth_result=${c.parked}` } });
assert.equal(r.json.outcome, 'expired');
ok('OAuth state is single-use: replaying the callback is refused');

// CSRF / account linking: E's own transaction completed in another browser (wrong / missing nonce) is refused...
c = await connect(E, BOHDAN, { tamper: () => ({ ck: 'A'.repeat(43) }) });
assert.equal(c.outcome, 'expired');
c = await connect(E, BOHDAN, { tamper: () => ({ ck: '' }) });
assert.equal(c.outcome, 'expired');
c = await connect(E, BOHDAN, { tamper: () => ({ completer: X }) });
assert.equal(c.outcome, 'expired');
assert.equal((await app('/api/google/connection', E.token)).json.connection, null);
assert.equal((await app('/api/google/connection', X.token)).json.connection, null);
ok('transaction bound to the initiating browser AND ClearSpace session: wrong/missing nonce or another signed-in user -> refused, nothing linked');
// ...and a code minted for ANOTHER transaction cannot be swapped in (PKCE verifier mismatch)
const foreign = await connect(X, CYRIL, { tamper: ({ cb }) => ({ cb: cb.replace(/state=[^&]+/, 'state=x') }) }); // obtain an unused code for X
const foreignCode = new URL(foreign.cb).searchParams.get('code');
c = await connect(E, BOHDAN, { tamper: ({ cb }) => ({ cb: cb.replace(/code=[^&]+/, `code=${encodeURIComponent(foreignCode)}`) }) });
assert.equal(c.outcome, 'error');
assert.equal((await app('/api/google/connection', E.token)).json.connection, null);
ok('authorization-code injection: a code issued to another transaction fails the PKCE check, nothing linked');

c = await connect(E, BOHDAN, { returnTo: 'https://evil.example/steal' });
assert.equal(c.outcome, 'connected'); assert.equal(c.returnTo, '/settings');
r = await http(`${APP}/api/google/oauth/callback?state=${'s'.repeat(43)}&code=x&redirect=https://evil.example`);
assert.equal(r.headers.get('location'), `${APP}/oauth/google`);
ok('open redirect: a foreign returnTo is replaced by /settings; the callback redirects only to APP_BASE_URL');

c = await connect(X, ANNA);
assert.equal(c.outcome, 'conflict');
assert.equal((await app('/api/google/connection', X.token)).json.connection, null);
assert.equal((await app('/api/google/connection', O.token)).json.connection.status, 'active');
ok('one Google account cannot be linked to two ClearSpace accounts (and the first connection stays intact)');

// ---------------------------------------------------------------- credential isolation (database boundary)
for (const t of ['google_connections', 'google_oauth_states']) {
  r = await db(`/rest/v1/${t}?select=*`, { token: O.token });
  assert.ok(r.status === 401 || r.status === 403 || (r.status === 200 && r.json.length === 0), `${t}: ${r.status}`);
  assert.ok(!TOKEN_RE.test(r.text) && !/v1\.[0-9a-f]{8}\./.test(r.text));
}
r = await rpc('google_credentials_get', { p_server_secret: 'x'.repeat(40), p_cost: 0 }, O.token);
assert.equal(r.status, 403); assert.equal(r.json.code, '42501');
r = await rpc('google_credentials_get', { p_server_secret: null, p_cost: 0 }, O.token);
assert.equal(r.json?.code, '42501');
r = await rpc('google_oauth_consume', { p_server_secret: 'y'.repeat(40), p_state_sha256: '0'.repeat(64), p_binding_sha256: '0'.repeat(64) });
assert.equal(r.json?.code, '42501');
r = await rpc('google_connection_status', {}, O.token);
assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.json[0]).sort(), ['connected_at', 'google_email', 'last_error_code', 'scopes', 'status']);
r = await rpc('google_connection_status', {}, X.token);
assert.equal(r.json.length, 0);
const stored = await admin('/rest/v1/google_connections?select=refresh_token_enc,access_token_enc');
assert.ok(stored.json.length >= 2 && stored.json.every((x) => /^v1\.[0-9a-f]{8}\./.test(x.refresh_token_enc) && !TOKEN_RE.test(JSON.stringify(x))));
ok('tokens: no table access for users, server RPCs refuse without the server secret, status RPC shows only own non-secret fields, stored values are AES-GCM envelopes (no plaintext)');

// ---------------------------------------------------------------- attach (project + task), dedupe, validation
await pick(O, [DOC, SHEET, ZAPIS, MD, XSS, PDF]);
r = await app('/api/drive/links', O.token, { method: 'POST', body: { projectId: P, fileIds: [DOC, SHEET] } });
assert.equal(r.status, 201, JSON.stringify(r.json)); assert.equal(r.json.links.length, 2);
r = await app('/api/drive/links', O.token, { method: 'POST', body: { projectId: P, fileIds: [DOC] } });
assert.equal(r.status, 200); assert.equal(r.json.links[0].duplicate, true);
r = await app('/api/drive/links', O.token, { method: 'POST', body: { projectId: P, cardId: CARD, fileIds: [DOC, ZAPIS, MD, XSS, BPRIV] } });
assert.equal(r.status, 201, JSON.stringify(r.json));
assert.equal(r.json.links.length, 4); assert.equal(r.json.failed.length, 1); assert.equal(r.json.failed[0].reason, 'no_access');
assert.match(r.json.failed[0].message, /Přístup k souboru není dostupný/);
let links = (await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=*`, { token: O.token })).json;
assert.equal(links.length, 6);
assert.equal(links.filter((l) => l.external_id === DOC).length, 2, 'same file on project AND task is allowed, never twice on one');
const xss = links.find((l) => l.external_id === XSS);
assert.ok(!/[‮\u0000-\u001f]/.test(xss.name) && xss.name.includes('<img'), 'bidi/control chars stripped, text kept verbatim (rendered as text, never HTML)');
assert.ok(links.every((l) => /^https:\/\/(docs|drive)\.google\.com\//.test(l.web_url)));
ok('attach: project and task links from server-side Drive metadata, duplicates de-duplicated, not-picked file refused with a Czech message, names sanitized, only canonical Google URLs');

for (const [body, code] of [
  [{ projectId: P, fileIds: ['http://169.254.169.254/latest/meta-data'] }, 400],
  [{ projectId: P, fileIds: ['../../etc/passwd'] }, 400],
  [{ projectId: P, fileIds: Array.from({ length: 21 }, (_, i) => `mockFile_${String(i).padStart(10, '0')}`) }, 400],
  [{ projectId: P, cardId: 'card;drop', fileIds: [DOC] }, 400],
  [{ projectId: P, fileIds: [] }, 400],
]) assert.equal((await app('/api/drive/links', O.token, { method: 'POST', body })).status, code);
r = await app('/api/drive/links', O.token, { method: 'POST', body: { projectId: P, fileIds: [DOC], pad: 'x'.repeat(20000) } });
assert.equal(r.status, 413);
r = await db('/rest/v1/external_resource_links', { method: 'POST', token: O.token, body: { project_id: P, external_id: 'mockEvil_0000000001', name: 'phish', mime_type: 'text/plain', web_url: 'https://evil.example/' } });
assert.ok([401, 403].includes(r.status), `direct insert: ${r.status}`);
r = await db(`/rest/v1/external_resource_links?id=eq.${links[0].id}`, { method: 'PATCH', token: O.token, body: { web_url: 'https://evil.example/' } });
assert.ok([401, 403].includes(r.status) || (r.json ?? []).length === 0, `direct update: ${r.status}`);
ok('validation: arbitrary URLs / paths / oversize / too many ids refused (no SSRF), no direct INSERT/UPDATE of link metadata by clients');

// other project id with a card of THIS project
r = await rpc('drive_link_add', { p_server_secret: 'z'.repeat(40), p_project_id: P, p_card_id: null, p_external_id: 'mockEvil_0000000001', p_name: 'x', p_mime_type: 'text/plain', p_web_url: 'https://drive.google.com/x', p_size_bytes: null, p_modified_at: null, p_provider_state: 'ok' }, O.token);
assert.equal(r.json?.code, '42501');
ok('drive_link_add cannot be called from a browser (server secret)');

// ---------------------------------------------------------------- events
let ev = (await db(`/rest/v1/activity_logs?project_id=eq.${P}&action_type=like.drive_*&select=*`, { token: E.token })).json;
assert.equal(ev.filter((e) => e.action_type === 'drive_file_linked').length, 6);
assert.ok(ev.every((e) => e.source === 'app' && e.actor_id === O.id && e.entity_id && !TOKEN_RE.test(JSON.stringify(e))));
assert.equal(ev.filter((e) => e.card_id === CARD).length, 4);
ok('activity: one trusted drive_file_linked event per persisted link (none for duplicates or refusals), actor verified, no secrets');

// ---------------------------------------------------------------- roles: viewer, outsider, cross-user content
r = await app('/api/drive/links', V.token, { method: 'POST', body: { projectId: P, fileIds: [DOC] } });
assert.equal(r.status, 403, 'role is checked before any Google call');
const vConn = await connect(V, CYRIL); assert.equal(vConn.outcome, 'connected');
r = await app('/api/drive/links', V.token, { method: 'POST', body: { projectId: P, fileIds: [DOC] } });
assert.equal(r.status, 403);
assert.equal((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: V.token })).json.length, 6, 'viewer reads');
r = await db(`/rest/v1/external_resource_links?id=eq.${links[0].id}`, { method: 'DELETE', token: V.token });
assert.ok(r.status === 403 || (r.json ?? []).length === 0);
assert.equal((await admin(`/rest/v1/external_resource_links?id=eq.${links[0].id}&select=id`)).json.length, 1);
ok('viewer: reads links, cannot attach (403) or remove (database refuses)');

assert.equal((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: X.token })).json.length, 0);
assert.equal((await db(`/rest/v1/activity_logs?project_id=eq.${P}&select=id`, { token: X.token })).json.length, 0);
assert.equal((await app(`/api/drive/links/${links[0].id}/content`, X.token)).status, 404);
r = await app('/api/drive/links/refresh', X.token, { method: 'POST', body: { projectId: P } });
assert.deepEqual(r.json.statuses ?? {}, {});
ok('outsider: no link rows, no events, no content, refresh sees nothing (IDOR by id -> 404)');

const zapisTask = links.find((l) => l.external_id === ZAPIS);
const docProject = links.find((l) => l.external_id === DOC && !l.card_id);
r = await app(`/api/drive/links/${docProject.id}/content`, E.token);
assert.equal(r.status, 403); assert.match(r.json.message, /Přístup k souboru není dostupný/);
r = await app(`/api/drive/links/${zapisTask.id}/content`, E.token);
assert.equal(r.status, 403, 'shared with Bohdan in Drive, but not yet opened with the app by Bohdan');
await pick(E, [ZAPIS]);
r = await app(`/api/drive/links/${zapisTask.id}/content`, E.token);
assert.equal(r.status, 200); assert.match(r.json.content.text, /Zápis z porady/);
ok('content uses ONLY the caller\'s own Google access: a teammate never reads a file through the linker\'s connection; after the teammate\'s own pick (and Drive permission) it works');

r = await app(`/api/drive/links/${links.find((l) => l.external_id === MD).id}/content`, O.token);
assert.equal(r.status, 200); assert.equal(r.json.content.provider, 'google_drive'); assert.match(r.json.content.text, /Ignore previous instructions/);
assert.ok(r.headers.get('cache-control').includes('no-store'));
ok('content preview: provenance attached, untrusted text returned as data (never executed or sent to AI), no-store');

// ---------------------------------------------------------------- metadata refresh
await ctl('rename', { id: SHEET, name: 'Rozpočet projektu Q1 – v2' });
await ctl('trash', { id: DOC });
r = await app('/api/drive/links/refresh', O.token, { method: 'POST', body: { projectId: P } });
assert.equal(r.status, 200); assert.ok(r.json.updated >= 3, JSON.stringify(r.json));
links = (await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=*`, { token: O.token })).json;
assert.equal(links.find((l) => l.external_id === SHEET).name, 'Rozpočet projektu Q1 – v2');
assert.ok(links.filter((l) => l.external_id === DOC).every((l) => l.provider_state === 'trashed'));
const evCount = (await db(`/rest/v1/activity_logs?project_id=eq.${P}&select=id`, { token: O.token })).json.length;
r = await app('/api/drive/links/refresh', E.token, { method: 'POST', body: { projectId: P } });
assert.equal(r.json.statuses[docProject.id], 'no_access'); assert.equal(r.json.updated, 0);
assert.equal(links.find((l) => l.id === docProject.id).provider_state, 'trashed');
assert.equal((await db(`/rest/v1/activity_logs?project_id=eq.${P}&select=id`, { token: O.token })).json.length, evCount, 'refresh writes no events');
await ctl('trash', { id: DOC, trashed: false });
ok('refresh: rename and trash picked up for an editor with access; a teammate without access only gets a per-user status (nothing stored); no timeline noise');

// ---------------------------------------------------------------- token lifecycle
let s0 = (await ctl('stats')).json.refreshes;
await expire(O);
// RUN 03: the Picker now always gets its OWN freshly minted, Drive-only token (never the stored one), so the stored-token
// lease is exercised through a server route that uses the stored token (metadata refresh).
const conc = await Promise.all(Array.from({ length: 5 }, () => app('/api/drive/links/refresh', O.token, { method: 'POST', body: { projectId: P } })));
assert.ok(conc.every((g) => g.status === 200), conc.map((g) => g.status).join());
assert.equal((await ctl('stats')).json.refreshes - s0, 1, 'exactly one refresh for 5 concurrent requests');
const grants = [await app('/api/google/picker-token', O.token, { method: 'POST', body: {} })];
assert.equal(grants[0].status, 200);
assert.ok(!('refreshToken' in grants[0].json) && !TOKEN_RE.test(JSON.stringify(Object.values(grants[0].json).filter((v) => typeof v === 'string' && v.startsWith('mock-rt')))));
ok('expired access token refreshed once under concurrency (database lease); the browser gets only a short-lived access token');

await ctl('fail', { mode: 'token_unavailable', count: 1 });
await expire(O);
r = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(r.status, 503); assert.match(r.json.message, /dočasně nedostupný/);
r = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(r.status, 200, 'temporary provider error does not break the connection');
await ctl('fail', { mode: 'drive_unavailable', count: 2 });
r = await app('/api/drive/links', O.token, { method: 'POST', body: { projectId: P, fileIds: [PDF] } });
assert.equal(r.json.failed[0]?.reason, 'unavailable'); assert.match(r.json.failed[0].message, /dočasně nedostupný/);
await ctl('fail', { mode: 'drive_rate_limit', count: 2 });
r = await app('/api/drive/links/refresh', O.token, { method: 'POST', body: { projectId: P, cardId: CARD } });
assert.ok(Object.values(r.json.statuses).includes('rate_limited') || Object.values(r.json.statuses).every((x) => x === 'ok' || x === 'trashed'));
ok('provider errors: temporary token/Drive failures and rate limits -> Czech messages, retried once, connection kept');

await ctl('revoke-account', { email: 'anna.mock@example.test' });
await expire(O);
r = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(r.status, 409); assert.equal(r.json.error, 'revoked'); assert.match(r.json.message, /Připojte účet prosím znovu/);
st = await app('/api/google/connection', O.token);
assert.equal(st.json.connection.status, 'revoked');
const audit = (await db('/rest/v1/integration_audit?select=event', { token: O.token })).json.map((a) => a.event);
assert.ok(audit.includes('revoked_by_provider') && audit.includes('connected'));
assert.equal((await db('/rest/v1/integration_audit?select=event', { token: X.token })).json.some((a) => a.event === 'revoked_by_provider'), false);
r = await app('/api/drive/links/refresh', O.token, { method: 'POST', body: { projectId: P } });
assert.ok(Object.values(r.json.statuses).every((x) => x === 'revoked'));
c = await connect(O, ANNA);
assert.equal(c.outcome, 'connected'); assert.equal((await app('/api/google/connection', O.token)).json.connection.status, 'active');
ok('revoked at the provider (invalid_grant) -> connection marked revoked, Czech reconnect prompt, own audit trail; reconnect restores it');

for (let i = 0; i < 11; i++) r = await app('/api/google/oauth/start', E.token, { method: 'POST', body: {} });
assert.equal(r.status, 429); assert.match(r.json.message, /Příliš mnoho/);
ok('OAuth start is rate limited per user (10 per 10 minutes)');

// ---------------------------------------------------------------- removal, membership, disconnect
const toRemove = links.find((l) => l.external_id === SHEET);
r = await db(`/rest/v1/external_resource_links?id=eq.${toRemove.id}`, { method: 'DELETE', token: E.token });
assert.equal(r.status, 200); assert.equal(r.json.length, 1);
ev = (await db(`/rest/v1/activity_logs?project_id=eq.${P}&action_type=eq.drive_file_unlinked&select=*`, { token: O.token })).json;
assert.equal(ev.length, 1); assert.equal(ev[0].actor_id, E.id);
ok('editor removes an association: row gone, one drive_file_unlinked event (the Drive file itself is never touched -- no write call exists)');

const eMembers = (await db(`/rest/v1/workspace_members?profile_id=eq.${E.id}&select=id`, { token: O.token })).json.map((m) => m.id);
const mem = (await db(`/rest/v1/project_members?project_id=eq.${P}&select=member_id`, { token: O.token })).json.find((m) => eMembers.includes(m.member_id));
r = await rpc('remove_project_member', { p_project_id: P, p_member_id: mem.member_id }, O.token);
assert.ok(r.status < 300, JSON.stringify(r.json));
assert.equal((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: E.token })).json.length, 0);
assert.equal((await app(`/api/drive/links/${zapisTask.id}/content`, E.token)).status, 404);
assert.equal((await app('/api/drive/links', E.token, { method: 'POST', body: { projectId: P, fileIds: [ZAPIS] } })).status, 403);
ok('removed member: no link rows, no content, cannot attach (their own Google connection stays theirs)');

r = await app('/api/google/connection', O.token, { method: 'DELETE' });
assert.equal(r.status, 200); assert.equal(r.json.disconnected, true); assert.equal(r.json.revokedAtGoogle, true);
assert.equal((await app('/api/google/connection', O.token)).json.connection, null);
assert.equal((await admin(`/rest/v1/google_connections?user_id=eq.${O.id}&select=user_id`)).json.length, 0);
assert.ok((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: O.token })).json.length >= 4, 'links stay');
assert.equal((await app('/api/google/picker-token', O.token, { method: 'POST', body: {} })).json.error, 'not_connected');
ok('disconnect: revoked at the provider, credentials deleted, project links kept, further Google calls refused');

console.log(`\n${passed} drive HTTP checks passed (provider = SIMULATED Google mock)`);
