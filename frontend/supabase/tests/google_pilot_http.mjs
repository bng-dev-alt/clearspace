// RUN 06 -- Gmail / Calendar PILOT mode: HTTP suite against the REAL local stack (cs-gdemo-sb), the REAL Next.js app started by
// scripts/gdemo-stack.sh app (GMAIL/CALENDAR_INTEGRATION_ENABLED=pilot, pilot user = alice, pilot account = anna.mock@example.test)
// and the Google MOCK. Everything Google here is SIMULATED. Loopback only.
//   eval "$(scripts/gdemo-stack.sh env)"; E2E_PASSWORD=<collab password> node supabase/tests/google_pilot_http.mjs
import assert from 'node:assert/strict';

const API = process.env.E2E_SUPABASE_URL, ANON = process.env.E2E_SUPABASE_ANON_KEY, SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY;
const APP = process.env.E2E_BASE_URL, MOCK = process.env.GOOGLE_MOCK_URL, PW = process.env.E2E_PASSWORD;
for (const u of [API, APP, MOCK]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: every endpoint must be loopback'); process.exit(2); }
if (!ANON || !SERVICE || !PW) { console.error('missing keys / E2E_PASSWORD'); process.exit(2); }
const run = Date.now().toString(36);
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly', CAL = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';

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

async function user(tag, email = null) {
  const pw = email ? PW : 'Test-Password-123';
  if (!email) { email = `${tag}-${run}@example.test`; const c = await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password: pw, email_confirm: true } }); assert.equal(c.status, 200, JSON.stringify(c.json)); }
  const l = await db('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: pw } });
  assert.equal(l.status, 200, 'login ' + tag);
  return { id: l.json.user.id, email, token: l.json.access_token };
}
/** Full authorization-code flow for one service (start -> mock consent -> callback -> complete under the session). */
async function connect(u, account, { service = 'drive', decision = 'allow', grant = { drive: true, gmail: true, calendar: true } } = {}) {
  const s = await app('/api/google/oauth/start', u.token, { method: 'POST', body: { returnTo: '/settings', service } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const cookie = /cs_google_oauth=([^;]+)/.exec(s.headers.get('set-cookie') ?? '')?.[1];
  const auth = new URL(s.json.url);
  const form = new URLSearchParams();
  for (const k of ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'include_granted_scopes', 'login_hint']) form.set(k, auth.searchParams.get(k) ?? '');
  form.set('account', account); form.set('decision', decision);
  for (const k of ['drive', 'gmail', 'calendar']) if (grant[k]) form.set(`grant_${k}`, '1');
  const back = await http(`${MOCK}/o/oauth2/v2/consent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: form.toString() });
  assert.equal(back.status, 302);
  const r1 = await http(back.headers.get('location'));
  assert.equal(r1.status, 303);
  const parked = /cs_google_oauth_result=([^;]+)/.exec(r1.headers.get('set-cookie') ?? '')?.[1];
  const r = await app('/api/google/oauth/complete', u.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${cookie}; cs_google_oauth_result=${parked}` } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { outcome: r.json.outcome, auth };
}
const ANNA = '100000000000000000001', BOHDAN = '100000000000000000002', CYRIL = '100000000000000000003';
const status = async (u) => (await app('/api/google/connection', u.token)).json;
const start = (u, service) => app('/api/google/oauth/start', u.token, { method: 'POST', body: { returnTo: '/settings', service } });
const EV = `/api/calendar/events?from=2026-11-30T00:00:00Z&to=2027-01-01T00:00:00Z`;
const disconnect = (u) => app('/api/google/connection', u.token, { method: 'DELETE' });

const alice = await user('alice', 'alice@collab.test');
const bob = await user('bob', 'bob@collab.test');
const outsider = await user('outsider');
for (const u of [alice, bob]) await disconnect(u);      // clean start (re-runnable)
// other suites on this stack may leave the MOCK accounts connected to their own throwaway users: free them (mock subs only)
await admin(`/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE' });

// 1. availability is per user: only alice sees Gmail / Calendar; nothing tells the others that a pilot exists
let s = await status(alice); assert.equal(s.gmailAvailable, true); assert.equal(s.calendarAvailable, true);
for (const u of [bob, outsider]) { s = await status(u); assert.equal(s.gmailAvailable, false); assert.equal(s.calendarAvailable, false); assert.equal(s.configured, true); }
ok('availability: alice (pilot) yes, bob + a fresh user no; Drive configured for all');

// 2. a non-pilot user cannot start Gmail / Calendar consent (same answer as OFF); Drive works
for (const u of [bob, outsider]) {
  let r = await start(u, 'gmail'); assert.equal(r.status, 503); assert.equal(r.json.error, 'gmail_disabled'); assert.equal(r.json.url, undefined);
  r = await start(u, 'calendar'); assert.equal(r.status, 503); assert.equal(r.json.error, 'calendar_disabled');
}
assert.equal((await connect(bob, BOHDAN)).outcome, 'connected');
s = await status(bob); assert.equal(s.connection.services.drive, true); assert.equal(s.connection.scopes.includes(GMAIL) || s.connection.scopes.includes(CAL), false);
assert.equal((await app('/api/gmail/search?kind=thread', bob.token)).json.error, 'gmail_disabled');
assert.equal((await app(EV, bob.token)).json.error, 'calendar_disabled');
ok('non-pilot users: consent refused 503 *_disabled, no Google URL; Drive connects; Gmail/Calendar routes 503');

// 3. pilot user + NON-pilot Google account: refused at completion, nothing stored
let r = await connect(alice, CYRIL, { service: 'gmail' }); assert.equal(r.outcome, 'pilot_account');
assert.equal((await status(alice)).connection, null);
assert.equal((await connect(alice, CYRIL)).outcome, 'connected');                       // Drive with that account is fine
s = await status(alice); assert.equal(s.gmailAvailable, false); assert.equal(s.calendarAvailable, false);
assert.equal((await start(alice, 'gmail')).json.error, 'gmail_disabled');            // the connected account is outside the pilot
ok('pilot user with a non-pilot Google account: pilot_account, nothing stored; Drive yes, Gmail/Calendar not offered');

// 4. pilot user + pilot account: Gmail and Calendar work
assert.equal((await disconnect(alice)).status, 200);
assert.equal((await connect(alice, ANNA)).outcome, 'connected');
assert.equal((await connect(alice, ANNA, { service: 'gmail' })).outcome, 'gmail_connected');
assert.equal((await connect(alice, ANNA, { service: 'calendar' })).outcome, 'calendar_connected');
s = await status(alice); assert.deepEqual(s.connection.services, { drive: true, gmail: true, calendar: true });
assert.equal((await app('/api/gmail/search?kind=thread', alice.token)).status, 200);
assert.equal((await app(EV, alice.token)).status, 200);
ok('pilot user + pilot account: Drive + Gmail + Calendar connected, routes 200');

// 5. the stored grant is not enough: the same token is refused for anyone else -- bob is never served alice's connection
assert.equal((await app('/api/gmail/search?kind=thread', bob.token)).json.error, 'gmail_disabled');
ok('pilot is enforced per request (token check), not only at consent');

for (const u of [alice, bob]) await disconnect(u);
await admin(`/auth/v1/admin/users/${outsider.id}`, { method: 'DELETE' });
console.log(`# google_pilot_http: ${passed} passed`);
