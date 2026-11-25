// RUN 04 -- Google Calendar integration: HTTP-level integration + adversarial suite against a REAL local stack (GoTrue + PostgREST,
// scripts/calendar-stack.sh), the REAL Next.js app (route handlers) and the Google MOCK. Everything Google here is SIMULATED
// (scripts/google-mock.mjs): this proves our flow and our boundaries (E1-E10), not Google's own behaviour. Loopback only.
//
//   eval "$(scripts/calendar-stack.sh env)"; APP_LOG=<dev log> node supabase/tests/calendar_http.mjs
//   CAL_EXPECT_OFF=1 node supabase/tests/calendar_http.mjs     # against an app started with CALENDAR_INTEGRATION_ENABLED=0
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY;
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY;
const APP = process.env.E2E_BASE_URL;
const MOCK = process.env.GOOGLE_MOCK_URL;
const APP_LOG = process.env.APP_LOG;
for (const u of [API, APP, MOCK]) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: every endpoint must be loopback'); process.exit(2); }
}
if (!ANON || !SERVICE) { console.error('missing keys'); process.exit(2); }

const run = Date.now().toString(36);
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const CAL = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

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
async function expire(u) {
  await ctl('expire-access', {});
  await admin(`/rest/v1/google_connections?user_id=eq.${u.id}`, { method: 'PATCH', body: { access_expires_at: new Date(Date.now() - 1000).toISOString() } });
}
const events = (u, q) => app(`/api/calendar/events?${new URLSearchParams(q)}`, u.token);
const DEC = { from: '2026-11-30T00:00:00Z', to: '2027-01-01T00:00:00Z', pageSize: '250' };
const prague = (iso) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(iso));
const ENDPOINTS = [['GET', `/api/calendar/events?from=${DEC.from}&to=${DEC.to}`], ['POST', '/api/calendar/links'], ['POST', '/api/calendar/links/00000000-0000-4000-8000-000000000000/refresh'],
  ['GET', '/api/calendar/links/00000000-0000-4000-8000-000000000000/open']];

// ================================================================ feature switch OFF (separate app run)
if (process.env.CAL_EXPECT_OFF === '1') {
  for (const [m, p] of ENDPOINTS) {
    const r = await app(p, null, { method: m, body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 503, `${m} ${p} -> ${r.status}`); assert.equal(r.json.error, 'calendar_disabled');
    assert.match(r.json.message, /Google Kalendářem není na serveru zapnuté/);
  }
  const U = await user('cal-off');
  assert.equal((await status(U)).calendarAvailable, false);
  const s = await app('/api/google/oauth/start', U.token, { method: 'POST', body: { service: 'calendar' } });
  assert.equal(s.status, 503); assert.equal(s.json.error, 'calendar_disabled'); assert.ok(!s.text.includes('accounts.google') && !s.text.includes('/o/oauth2'));
  const d = await app('/api/google/oauth/start', U.token, { method: 'POST', body: { service: 'drive' } });
  assert.equal(d.status, 200); assert.ok(!new URL(d.json.url).searchParams.get('scope').includes('calendar'));
  ok('switch OFF: every Calendar route 503 calendar_disabled before auth, no Google URL for Calendar, Drive consent carries no Calendar scope, calendarAvailable=false');
  console.log(`\nCalendar HTTP (switch OFF): ${passed} groups passed (SIMULATED Google)`);
  process.exit(0);
}

await ctl('reset', {});
await admin(`/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE' });

// ---------------------------------------------------------------- fixture
const O = await user('cal-own'), E = await user('cal-ed'), V = await user('cal-view'), X = await user('cal-out'), G = await user('cal-gm');
const P = `p-cal-${run}`, CARD = `${P}-card-1`;
for (const r of [
  await db('/rest/v1/projects', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: P, name: 'Kalendář projekt' } }),
  await db('/rest/v1/columns', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { id: `${P}-col`, project_id: P, name: 'Naplánováno', position: 0 } }),
  await db('/rest/v1/project_members', { method: 'POST', token: O.token, headers: { Prefer: 'return=minimal' }, body: { project_id: P, member_id: `member-owner-${O.id}` } }),
  await db('/rest/v1/cards', { method: 'POST', token: O.token, body: { id: CARD, column_id: `${P}-col`, title: 'Kickoff s klientem', details: '' } }),
]) assert.ok(r.status < 300, JSON.stringify(r.json));
for (const [u, role, name] of [[E, 'member', 'Eva Editorka'], [V, 'viewer', 'Viktor Čtenář'], [G, 'member', 'Gustav Gmail']]) {
  const inv = await rpc('create_project_invitation', { p_project_id: P, p_email: u.email, p_role: role }, O.token);
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  assert.equal((await rpc('accept_workspace_invitation', { p_token: inv.json[0].token, p_display_name: name }, u.token)).status, 200);
}
ok('fixture: owner, editor, viewer, editor with Drive+Gmail only on one project + an outsider');

// ---------------------------------------------------------------- unauthenticated, no connection, invalid service
for (const [m, p] of [...ENDPOINTS, ['DELETE', '/api/calendar/connection']]) {
  const r = await app(p, null, { method: m, body: m === 'POST' ? {} : undefined });
  assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
}
let st = await status(O);
assert.equal(st.calendarAvailable, true); assert.equal(st.simulated, true); assert.equal(st.connection, null);
let r = await events(O, DEC);
assert.equal(r.status, 409); assert.equal(r.json.error, 'not_connected');
assert.equal((await app('/api/google/oauth/start', O.token, { method: 'POST', body: { service: 'calendar-all' } })).status, 400);
ok('every Calendar endpoint refuses an unauthenticated call (401); not connected -> 409; unknown service -> 400; switch ON, provider SIMULATED');

// ---------------------------------------------------------------- E9: incremental consent next to Drive; denied; account mismatch
let c = await connect(O, ANNA);
assert.equal(c.outcome, 'connected');
assert.deepEqual((await status(O)).connection.services, { drive: true, gmail: false, calendar: false });
r = await events(O, DEC);
assert.equal(r.status, 409); assert.equal(r.json.error, 'calendar_not_granted');
let stats0 = (await ctl('stats')).json;
c = await connect(O, ANNA, { service: 'calendar', grant: { calendar: false } });
assert.equal(c.outcome, 'calendar_denied');
assert.equal(c.auth.searchParams.get('scope'), `openid email ${CAL}`, 'Calendar consent asks ONLY for the read-only Calendar scope');
assert.equal(c.auth.searchParams.get('include_granted_scopes'), 'true');
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: false, calendar: false }); assert.equal(st.connection.status, 'active');
assert.equal((await ctl('stats')).json.revocations, stats0.revocations, 'denying Calendar revokes nothing (would end Drive)');
assert.equal((await app('/api/google/picker-token', O.token, { method: 'POST', body: {} })).status, 200, 'Drive still usable');
c = await connect(O, BOHDAN, { service: 'calendar' });
assert.equal(c.outcome, 'account_mismatch');
assert.equal((await status(O)).connection.email, 'anna.mock@example.test');
ok('E9: Calendar refused before consent (calendar_not_granted); unticked Calendar -> calendar_denied, Drive untouched, nothing revoked; another Google account -> account_mismatch');

c = await connect(O, ANNA, { service: 'calendar' });
assert.equal(c.outcome, 'calendar_connected');
c = await connect(O, ANNA, { service: 'gmail' });
assert.equal(c.outcome, 'gmail_connected');
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: true, calendar: true });
const audit = (await db(`/rest/v1/integration_audit?select=event,detail&order=created_at`, { token: O.token })).json;
assert.ok(audit.some((a) => a.event === 'scope_denied' && a.detail === 'calendar') && audit.some((a) => a.event === 'service_added' && a.detail === 'calendar'));
ok('Calendar added incrementally on the same grant (Drive + Gmail + Calendar); audited (scope_denied / service_added = calendar)');

// ---------------------------------------------------------------- E10: token isolation
const pt = await app('/api/google/picker-token', O.token, { method: 'POST', body: {} });
assert.equal(pt.status, 200);
const PT = { Authorization: `Bearer ${pt.json.accessToken}` };
assert.equal((await http(`${MOCK}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`, { headers: PT })).status, 403, 'Picker token cannot read Calendar');
assert.equal((await http(`${MOCK}/gmail/v1/users/me/messages`, { headers: PT })).status, 403, 'nor Gmail');
assert.equal((await events(O, DEC)).status, 200);
assert.equal((await app('/api/gmail/search?kind=thread', O.token)).status, 200, 'Gmail unchanged next to Calendar');
r = await events(G, DEC);
assert.equal(r.status, 409); assert.equal(r.json.error, 'not_connected');
await connect(G, CYRIL); await connect(G, CYRIL, { service: 'gmail' });
r = await events(G, DEC);
assert.equal(r.status, 409); assert.equal(r.json.error, 'calendar_not_granted', 'Drive + Gmail grant does not open Calendar');
ok('E10: browser token downscoped to Drive (Calendar 403, Gmail 403); Calendar routes need the Calendar scope even with Drive + Gmail; Gmail keeps working');

// ---------------------------------------------------------------- owner overlay: shape, privacy, E1-E4, E6
r = await events(O, DEC);
assert.equal(r.status, 200, r.text); assert.equal(r.headers.get('cache-control'), 'no-store, private');
const items = r.json.items;
const by = (t) => items.filter((e) => e.title.startsWith(t));
for (const leak of ['SOUKROMÝ POPIS', 'Soukromá adresa', 'meet.google.com', 'ucastnik', 'corvane.example"', 'jana.dvorakova', 'description', 'location', 'hangoutLink', 'iCalUID'])
  assert.ok(!r.text.includes(leak), `overlay leaks ${leak}`);
assert.equal(by('Pracuji z kanceláře').length, 0, 'working-location marker skipped');
assert.equal(by('Duplicita v seznamu').length, 1, 'duplicate list id shown once');
const kick = by('Kickoff Corvane')[0];
assert.equal(kick.attendees, 4); assert.equal(kick.organizer, 'Jana Dvořáková (simulace)'); assert.equal(prague(kick.start), '1. 12. 2026 9:00');
assert.match(kick.htmlLink, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
const ws = by('Workshop Brno')[0];
assert.deepEqual([ws.allDay, ws.start, ws.end], [true, '2026-11-30T00:00:00.000Z', '2026-12-03T00:00:00.000Z'], 'E3: multi-day all-day across the month boundary, end exclusive, no zone shift');
assert.deepEqual([by('Firemní volno')[0].allDay, by('Firemní volno')[0].start.slice(0, 10)], [true, '2026-12-24']);
const conf = by('Konference')[0];
assert.equal(prague(conf.start), '10. 12. 2026 16:00'); assert.equal(prague(conf.end), '11. 12. 2026 12:00');
const ny = by('Call s New Yorkem')[0];
assert.equal(ny.timeZone, 'America/New_York'); assert.equal(prague(ny.start), '3. 12. 2026 16:00'); assert.equal(ny.attendees, 40);
assert.equal(by('Lékař')[0].private, true); assert.equal(by('Personální pohovor')[0].private, true); assert.equal(kick.private, false);
const stand = by('Standup Corvane');
assert.deepEqual(stand.map((e) => prague(e.start)), ['2. 12. 2026 10:30', '16. 12. 2026 9:00', '23. 12. 2026 9:00', '30. 12. 2026 9:00'], 'E1/E2: weekly occurrences; the 2 Dec one moved to 10:30; the 9 Dec one cancelled (absent)');
assert.ok(stand.every((e) => e.recurring && e.recurringEventId === 'standupcorvane01'));
const MOVED = stand[0];
assert.equal(MOVED.title, 'Standup Corvane (přesunuto)'); assert.equal(MOVED.modified, true); assert.equal(stand[1].modified, false);
assert.match(by('<img')[0].title, /^<img src=x onerror=alert\(1\)>/, 'untrusted title returned as data (rendered as text by React)');
assert.ok(!by('<img')[0].title.includes('‮'), 'bidi override stripped');
assert.equal(by('Dlouhý název')[0].title.length, 300);
ok('owner overlay: own events only with title/times/flags/count/organizer/htmlLink -- no description, location, attendee e-mails, Meet data; E1 occurrences, E2 modified + cancelled occurrence, E3 all-day + multi-day, E4 zones, E6 private flagged; no-store');

// E4 DST
r = await events(O, { from: '2027-03-22T00:00:00Z', to: '2027-04-02T00:00:00Z', pageSize: '250' });
const spring = r.json.items.filter((e) => e.title === 'Standup Corvane');
assert.deepEqual(spring.map((e) => [e.start, prague(e.start)]), [['2027-03-24T08:00:00.000Z', '24. 3. 2027 9:00'], ['2027-03-31T07:00:00.000Z', '31. 3. 2027 9:00']], 'series keeps 09:00 local across the spring DST change');
const night = r.json.items.find((e) => e.title.startsWith('Noční údržba'));
assert.equal(Date.parse(night.end) - Date.parse(night.start), 3600e3, '01:30 CET -> 03:30 CEST is ONE real hour');
r = await events(O, { from: '2027-10-29T00:00:00Z', to: '2027-11-02T00:00:00Z', pageSize: '250' });
const autumn = r.json.items.find((e) => e.title === 'Podzimní přechod času');
assert.equal(prague(autumn.start), '31. 10. 2027 1:00'); assert.equal(prague(autumn.end), '31. 10. 2027 4:00'); assert.equal(Date.parse(autumn.end) - Date.parse(autumn.start), 4 * 3600e3);
ok('E4: Europe/Prague DST 2027-03-28 (series keeps 09:00 local, night event = 1 real hour) and 2027-10-31 (01:00 CEST - 04:00 CET = 4 real hours)');

// E8 range boundaries + pagination
r = await events(O, { from: '2026-12-20T09:00:00Z', to: '2026-12-20T12:00:00Z', pageSize: '250' });
assert.deepEqual(r.json.items.map((e) => e.title).filter((t) => t.startsWith('Hranice')), ['Hranice – přesahuje do rozsahu'], 'ends exactly at "from" and starts exactly at "to" are outside; overlapping is inside');
for (const q of [{ from: '2026-12-01T00:00:00Z', to: '2027-01-13T00:00:01Z' }, { from: '2026-12-02T00:00:00Z', to: '2026-12-01T00:00:00Z' }, { from: '2026-12-01', to: '2026-12-02' }, { from: '2026-12-01T00:00:00Z' }]) {
  r = await events(O, q); assert.equal(r.status, 400, JSON.stringify(q)); assert.equal(r.json.error, 'invalid_range');
}
for (const q of [{ ...DEC, pageSize: '251' }, { ...DEC, pageSize: '0' }, { ...DEC, pageToken: 'x'.repeat(600) }, { ...DEC, q: 'q'.repeat(201) }]) assert.equal((await events(O, q)).status, 400);
const JAN = { from: '2027-01-01T00:00:00Z', to: '2027-02-01T00:00:00Z' };
const all = (await events(O, { ...JAN, pageSize: '250' })).json;
assert.equal(all.nextPageToken, null);
const seen = []; let tok = null; let pages = 0;
do {
  const p = (await events(O, { ...JAN, pageSize: '7', ...(tok ? { pageToken: tok } : {}) })).json;
  seen.push(...p.items.map((e) => e.id)); tok = p.nextPageToken; pages++;
} while (tok && pages < 20);
assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages'); assert.deepEqual(seen, all.items.map((e) => e.id), 'no gaps, same order');
assert.ok(pages >= 5 && all.items.length >= 30);
r = await events(O, { ...DEC, q: 'kickoff' });
assert.deepEqual(r.json.items.map((e) => e.id), ['kickoffcorvane0001'], 'q search (accent/case-insensitive in the provider)');
ok('E8: [from,to) overlap boundaries exact; >42 days / reversed / non-instant / missing -> 400 invalid_range; page size, token, q bounds; pagination without gaps or duplicates; q search');

// ---------------------------------------------------------------- attach (E1, E2, E5, E6, E7)
r = await app('/api/calendar/links', O.token, { method: 'POST', body: { projectId: P, eventIds: ['kickoffcorvane0001', stand[1].id, MOVED.id, 'lekarsoukrome00001', 'pohovordurverny001', 'smazanamezitim0001', 'bohdanovaschuzka01', 'standupcorvane01_20261209T080000Z'] } });
assert.equal(r.status, 201, r.text);
assert.deepEqual(r.json.links.map((l) => l.eventId), ['kickoffcorvane0001', stand[1].id, MOVED.id]);
assert.deepEqual(Object.fromEntries(r.json.failed.map((f) => [f.eventId, f.reason])), {
  lekarsoukrome00001: 'private', pohovordurverny001: 'private', smazanamezitim0001: 'not_found', bohdanovaschuzka01: 'not_found', standupcorvane01_20261209T080000Z: 'not_found' });
assert.match(r.json.failed[0].message, /Soukromou ani důvěrnou/);
const L = Object.fromEntries(r.json.links.map((l) => [l.eventId, l.id]));
const L_KICK = L.kickoffcorvane0001, L_OCC = L[stand[1].id], L_MOVED = L[MOVED.id];
r = await app('/api/calendar/links', O.token, { method: 'POST', body: { projectId: P, eventIds: ['kickoffcorvane0001'] } });
assert.equal(r.status, 200); assert.deepEqual([r.json.links[0].id, r.json.links[0].duplicate], [L_KICK, true]);
r = await app('/api/calendar/links', O.token, { method: 'POST', body: { projectId: P, cardId: CARD, eventIds: ['kickoffcorvane0001'] } });
assert.equal(r.status, 201); assert.notEqual(r.json.links[0].id, L_KICK);
const L_KICK_TASK = r.json.links[0].id;
const rows = (await db(`/rest/v1/external_resource_links?project_id=eq.${P}&select=*&order=created_at`, { token: V.token })).json;
assert.equal(rows.length, 4);
const raw = JSON.stringify(rows);
for (const leak of ['kickoffcorvane', 'standupcorvane', 'SOUKROMÝ', 'Soukromá adresa', 'meet.google', 'ucastnik', 'eid=', 'jana.dvorakova', 'Lékař', 'pohovor'])
  assert.ok(!raw.includes(leak), `shared rows leak ${leak}`);
const kr = rows.find((x) => x.id === L_KICK);
assert.deepEqual([kr.provider, kr.web_url, kr.mime_type, kr.name, kr.event_attendees, kr.event_organizer, kr.event_all_day, kr.event_recurring, kr.event_time_zone, kr.provider_state],
  ['google_calendar_event', null, 'text/calendar', 'Kickoff Corvane – redesign portálu', 4, 'Jana Dvořáková (simulace)', false, false, 'Europe/Prague', 'ok']);
assert.equal(prague(kr.event_start), '1. 12. 2026 9:00');
const mr = rows.find((x) => x.id === L_MOVED);
assert.deepEqual([mr.name, mr.event_recurring, prague(mr.event_start)], ['Standup Corvane (přesunuto)', true, '2. 12. 2026 10:30']);
assert.equal((await db(`/rest/v1/calendar_link_sources?select=*`, { token: O.token })).status >= 400 || (await db(`/rest/v1/calendar_link_sources?select=*`, { token: O.token })).json.length === 0, true, 'private sources not readable by clients');
ok('attach: occurrence + modified occurrence linked (E1/E2); private + confidential refused (E6); deleted / cancelled / another calendar\'s event not found (E5); duplicate -> same link, project + task coexist (E7); shared rows hold only the shared fields');

for (const body of [{ projectId: P, eventIds: Array.from({ length: 11 }, (_, i) => `evtmany${i}000`) }, { projectId: P, eventIds: ['../etc'] }, { projectId: P, eventIds: [] },
  { eventIds: ['kickoffcorvane0001'] }, { projectId: P, cardId: 'bad card!', eventIds: ['kickoffcorvane0001'] }]) {
  assert.equal((await app('/api/calendar/links', O.token, { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 80));
}
assert.equal((await app('/api/calendar/links', O.token, { method: 'POST', raw: JSON.stringify({ projectId: P, eventIds: ['kickoffcorvane0001'], pad: 'x'.repeat(17000) }) })).status, 413);
for (const [u, code, st2] of [[V, 'forbidden', 403], [X, 'forbidden', 403], [E, 'not_connected', 409], [G, 'calendar_not_granted', 409]]) {
  r = await app('/api/calendar/links', u.token, { method: 'POST', body: { projectId: P, eventIds: ['kickoffcorvane0001'] } });
  assert.equal(r.status, st2, `${u.email} -> ${r.status}`); assert.equal(r.json.error, code);
}
ok('attach bounds (>10, malformed, empty, missing project, bad card -> 400; oversized -> 413); refused for viewer / outsider (403), editor without Google (409), editor with Drive+Gmail only (calendar_not_granted)');

c = await connect(E, BOHDAN, { service: 'calendar' });
assert.equal(c.outcome, 'calendar_connected');
assert.deepEqual((await status(E)).connection.services, { drive: false, gmail: false, calendar: true });
r = await app('/api/calendar/links', E.token, { method: 'POST', body: { projectId: P, cardId: CARD, eventIds: ['bohdanovaschuzka01', 'kickoffcorvane0001'] } });
assert.equal(r.status, 201); assert.equal(r.json.links.length, 1); assert.equal(r.json.failed[0].reason, 'not_found', 'the owner\'s event id does not exist in the editor\'s calendar');
const L_BOB = r.json.links[0].id;
assert.equal((await app('/api/google/picker-token', E.token, { method: 'POST', body: {} })).json.error, 'drive_not_granted');
ok('Calendar-only connection works (no Drive, no Gmail); editor links own event; a teammate\'s id is not found in their calendar');

// ---------------------------------------------------------------- open: owner only
r = await app(`/api/calendar/links/${L_KICK}/open`, O.token);
assert.equal(r.status, 200); assert.match(r.json.url, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/); assert.equal(r.headers.get('cache-control'), 'no-store, private');
for (const u of [E, V, X, G]) {
  r = await app(`/api/calendar/links/${L_KICK}/open`, u.token);
  assert.ok([403, 409].includes(r.status), `${u.email} -> ${r.status}`); assert.ok(!r.text.includes('eid=') && !r.text.includes('kickoffcorvane'));
}
r = await app(`/api/calendar/links/${L_BOB}/open`, O.token);
assert.equal(r.status, 403, 'the project OWNER cannot open the editor\'s event either'); assert.equal(r.json.error, 'not_owner');
assert.equal((await app('/api/calendar/links/00000000-0000-4000-8000-000000000000/open', O.token)).status, 403, 'unknown link: same refusal (no oracle)');
assert.equal((await app('/api/calendar/links/not-a-uuid/open', O.token)).status, 404);
ok('"Otevřít v Google Kalendáři" is owner-only (htmlLink never stored or shown to others); unknown id gives the same refusal');

// ---------------------------------------------------------------- refresh: E5 rescheduled / cancelled / deleted / gone; private later
await ctl('cal-move', { id: 'kickoffcorvane0001', start: '2026-12-02T12:00:00Z', end: '2026-12-02T13:00:00Z', summary: 'Kickoff Corvane (nový termín)' });
r = await app(`/api/calendar/links/${L_KICK}/refresh`, O.token, { method: 'POST', body: {} });
assert.equal(r.status, 200); assert.deepEqual([r.json.state, r.json.updated], ['ok', true]);
let row = (await db(`/rest/v1/external_resource_links?id=eq.${L_KICK}&select=name,event_start,provider_state`, { token: V.token })).json[0];
assert.deepEqual([row.name, prague(row.event_start)], ['Kickoff Corvane (nový termín)', '2. 12. 2026 13:00']);
await ctl('cal-move', { id: stand[1].id, start: '2027-06-01T08:00:00Z', end: '2027-06-01T08:30:00Z' });
await app(`/api/calendar/links/${L_OCC}/refresh`, O.token, { method: 'POST', body: {} });
assert.equal(prague((await db(`/rest/v1/external_resource_links?id=eq.${L_OCC}&select=event_start`, { token: V.token })).json[0].event_start), '1. 6. 2027 10:00', 'rescheduled far outside the viewed range: still refreshed');
await ctl('cal-cancel', { id: 'kickoffcorvane0001' });
r = await app(`/api/calendar/links/${L_KICK}/refresh`, O.token, { method: 'POST', body: {} });
assert.deepEqual([r.json.state, r.json.updated], ['deleted', true]);
row = (await db(`/rest/v1/external_resource_links?id=eq.${L_KICK}&select=name,event_start,provider_state`, { token: V.token })).json[0];
assert.deepEqual([row.provider_state, row.name], ['deleted', 'Kickoff Corvane (nový termín)'], 'cancelled: marked deleted, last known metadata kept (no 1970 dates)');
r = await app(`/api/calendar/links/${L_KICK}/open`, O.token);
assert.equal(r.status, 404); assert.equal(r.json.error, 'deleted');
await ctl('cal-delete', { id: MOVED.id });
assert.equal((await app(`/api/calendar/links/${L_MOVED}/refresh`, O.token, { method: 'POST', body: {} })).json.state, 'deleted');
await ctl('fail', { mode: 'calendar_gone', count: 1 });
assert.equal((await app(`/api/calendar/links/${L_KICK_TASK}/refresh`, O.token, { method: 'POST', body: {} })).json.state, 'deleted', '410 Gone -> deleted');
await ctl('cal-visibility', { id: 'standupcorvane01', visibility: 'private' });
await ctl('cal-move', { id: stand[1].id, start: '2027-06-02T08:00:00Z', end: '2027-06-02T08:30:00Z', summary: 'Soukromě přejmenováno' });
r = await app(`/api/calendar/links/${L_OCC}/refresh`, O.token, { method: 'POST', body: {} });
assert.equal(r.json.private, true);
assert.equal((await db(`/rest/v1/external_resource_links?id=eq.${L_OCC}&select=name`, { token: V.token })).json[0].name, 'Standup Corvane', 'an event made private later: its new metadata is not shared');
for (const u of [E, V, X]) assert.equal((await app(`/api/calendar/links/${L_OCC}/refresh`, u.token, { method: 'POST', body: {} })).status, 403);
ok('E5 refresh (owner only): rescheduled -> new time/title for the team, also outside the range; cancelled / deleted / 410 -> deleted with last metadata kept; open refused; made private later -> not re-shared');

// ---------------------------------------------------------------- provider failures, token refresh, concurrency (E9 expiry)
for (const [mode, n, code, st2] of [['calendar_rate_limit', 1, 'rate_limited', 429], ['calendar_unavailable', 2, 'unavailable', 503], ['calendar_forbidden', 1, 'forbidden', 403]]) {
  await ctl('fail', { mode, count: n });
  r = await events(O, DEC);
  assert.equal(r.status, st2, `${mode} -> ${r.status}`); assert.equal(r.json.error, code); assert.match(r.json.message, /Kalendář/);
  assert.equal((await events(O, DEC)).status, 200, `${mode}: recovers`);
}
await ctl('fail', { mode: 'calendar_unauthorized', count: 1 });
assert.equal((await events(O, DEC)).status, 200, 'a 401 triggers exactly one forced token refresh, then succeeds');
await expire(O);
stats0 = (await ctl('stats')).json;
const par = await Promise.all(Array.from({ length: 5 }, () => events(O, DEC)));
assert.ok(par.every((x) => x.status === 200), par.map((x) => x.status).join(','));
assert.equal((await ctl('stats')).json.refreshes, stats0.refreshes + 1, 'five concurrent requests -> exactly one refresh');
ok('Calendar 403 rateLimit/503/403 -> Czech errors with matching status (one retry on 5xx); 401 -> one forced refresh; expired access token: 5 concurrent requests, 1 refresh');

// ---------------------------------------------------------------- OAuth hardening (shared flow)
const s1 = await app('/api/google/oauth/start', O.token, { method: 'POST', body: { service: 'calendar', returnTo: 'https://evil.example' } });
assert.equal(new URL(s1.json.url).searchParams.get('redirect_uri'), `${APP}/api/google/oauth/callback`);
assert.equal(new URL(s1.json.url).searchParams.get('login_hint'), 'anna.mock@example.test');
r = await app('/api/google/oauth/complete', X.token, { method: 'POST', headers: { Cookie: `cs_google_oauth=${/cs_google_oauth=([^;]+)/.exec(s1.headers.get('set-cookie'))[1]}` } });
assert.equal(r.json.outcome, 'expired', 'another session cannot complete it');
ok('Calendar consent uses the same hardened flow: fixed redirect URI, login_hint = connected account, session-bound completion');

// ---------------------------------------------------------------- E9 / E10: Calendar off in ClearSpace (Drive + Gmail untouched) + purge
r = await app('/api/calendar/connection', O.token, { method: 'DELETE' });
assert.deepEqual([r.status, r.json.calendarRemoved, r.json.purged], [200, true, null]);
st = await status(O);
assert.deepEqual(st.connection.services, { drive: true, gmail: true, calendar: false }); assert.equal(st.connection.status, 'active');
assert.equal((await events(O, DEC)).json.error, 'calendar_not_granted');
assert.equal((await app(`/api/calendar/links/${L_KICK_TASK}/open`, O.token)).json.error, 'calendar_not_granted');
assert.equal((await app('/api/google/picker-token', O.token, { method: 'POST', body: {} })).status, 200);
assert.equal((await app('/api/gmail/search?kind=thread', O.token)).status, 200);
c = await connect(O, ANNA, { service: 'drive' });
assert.deepEqual((await status(O)).connection.services, { drive: true, gmail: true, calendar: false }, 'reconnecting Drive does not silently re-enable Calendar');
r = await app('/api/calendar/connection?purge=1', O.token, { method: 'DELETE' });
assert.deepEqual([r.json.calendarRemoved, r.json.purged], [false, { removed: 4, skipped: 0 }]);
assert.deepEqual((await db(`/rest/v1/external_resource_links?project_id=eq.${P}&provider=eq.google_calendar_event&select=id`, { token: V.token })).json.map((x) => x.id), [L_BOB], 'only the editor\'s event remains');
ok('"Vypnout Kalendář": Calendar calls stop, Drive + Gmail keep working, Drive reconnect keeps Calendar off; purge removes exactly my 4 event links');

// ---------------------------------------------------------------- full disconnect + provider-side revocation (E9)
stats0 = (await ctl('stats')).json;
r = await app('/api/google/connection', E.token, { method: 'DELETE' });
assert.equal(r.json.revokedAtGoogle, true);
assert.ok((await ctl('stats')).json.liveRefreshTokens < stats0.liveRefreshTokens);
r = await app(`/api/calendar/links/${L_BOB}/open`, E.token);
assert.equal(r.status, 409); assert.equal(r.json.error, 'not_connected');
assert.equal((await db(`/rest/v1/external_resource_links?id=eq.${L_BOB}&select=name`, { token: O.token })).json[0].name, 'Bohdanova soukromá schůzka');
await connect(E, BOHDAN, { service: 'calendar' });
await ctl('revoke-account', { email: 'bohdan.mock@example.test' });
await expire(E);
r = await events(E, DEC);
assert.equal(r.status, 409); assert.equal(r.json.error, 'revoked');
assert.equal((await status(E)).connection.status, 'revoked');
ok('E9: full disconnect revokes the whole grant (link keeps only shared metadata); grant revoked / expired at Google -> connection marked revoked, Czech "reconnect" error');

// ---------------------------------------------------------------- logs
if (APP_LOG && existsSync(APP_LOG)) {
  const log = readFileSync(APP_LOG, 'utf8');
  for (const leak of ['mock-at.', 'mock-rt.', 'mock-code.', 'SOUKROMÝ POPIS', 'anna.mock@', 'jana.dvorakova', 'kickoffcorvane0001', 'standupcorvane01', '/api/calendar/events?', 'eid=', 'Kickoff Corvane'])
    assert.ok(!log.includes(leak), `dev server log contains ${leak}`);
  ok('dev server log: no tokens, codes, event ids, titles, addresses, htmlLinks or event-search URLs');
}
console.log(`\nCalendar HTTP: ${passed} groups passed (SIMULATED Google -- not a live Google result)`);
