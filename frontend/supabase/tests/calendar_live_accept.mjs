// RUN 04 live acceptance through the PRODUCT routes, against REAL Google (dev project, Testing), on the local stack.
// Run through: frontend/scripts/calendar-live.sh accept <phase>     (phase: link | after-change | off | on)
// Test data = events titled "ClearSpace TEST – ..." the run created in the owner's calendar (no guests). Only those titles are printed.
// Roles: alice (owner, Google connected), bob (editor, no Google), vera (viewer) on project-collab-demo.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const { E2E_SUPABASE_URL: API, E2E_SUPABASE_ANON_KEY: ANON, E2E_BASE_URL: APP, E2E_PASSWORD: PW, APP_LOG } = process.env;
for (const u of [API, APP]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: loopback only'); process.exit(2); }
const phase = process.argv[2] ?? 'link';
const STATE = `${process.env.TMPDIR ?? '/tmp/'}cs-calendar-live-state.json`;
const P = 'project-collab-demo';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } };
const session = async (email) => (await j(await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) }))).access_token;
const [A, B, V] = [await session('alice@collab.test'), await session('bob@collab.test'), await session('vera@collab.test')];
assert.ok(A && B && V, 'dev identities sign in');
const app = async (path, token, init = {}) => { const r = await fetch(`${APP}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } }); return { status: r.status, json: await j(r), headers: r.headers }; };
const rest = async (path, token) => j(await fetch(`${API}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }));
const prague = (iso) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'numeric', year: 'numeric' }).format(new Date(iso));
const ok = (m) => console.log(`ok - ${m}`);
// the connected Google address is read at run time (never written into the repository); only its presence is checked
const ACCOUNT = String((await app('/api/google/connection', A)).json?.connection?.email ?? 'no-google-connection@invalid');
const LOCAL_PART = ACCOUNT.split('@')[0];
const DEC = new URLSearchParams({ from: '2026-11-30T00:00:00Z', to: '2027-01-10T00:00:00Z', pageSize: '250' });
const test = (items) => items.filter((e) => e.title.startsWith('ClearSpace TEST'));

if (phase === 'link') {
  const st = (await app('/api/google/connection', A)).json;
  assert.equal(st.simulated, false); assert.equal(st.connection.services.calendar, true);
  const r = await app(`/api/calendar/events?${DEC}`, A);
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store, private');
  const T = test(r.json.items);
  const by = (s) => T.filter((e) => e.title.includes(s));
  console.log('test events seen:', T.map((e) => `${e.title.replace('ClearSpace TEST – ', '')} @ ${prague(e.start)}${e.private ? ' [private]' : ''}${e.modified ? ' [modified]' : ''}`).join(' | '));
  for (const leak of ['description', 'location', 'hangoutLink', 'conferenceData', 'Testovací událost ClearSpace RUN 04']) assert.ok(!JSON.stringify(r.json).includes(leak), `overlay leaks ${leak}`);
  const occ = by('týdenní porada');
  assert.deepEqual(occ.map((e) => prague(e.start)), ['2. 12. 2026 9:00', '9. 12. 2026 11:00', '23. 12. 2026 9:00'], 'E1/E2/E5: 3 occurrences; 9 Dec moved to 11:00; 16 Dec deleted (absent)');
  assert.ok(occ.every((e) => e.recurring && e.recurringEventId)); assert.deepEqual(occ.map((e) => e.modified), [false, true, false]);
  ok('E1/E2/E5 live: weekly series occurrences, the modified occurrence (11:00, modified=true), the deleted occurrence absent');
  const ws = by('vícedenní workshop')[0];
  assert.deepEqual([ws.allDay, ws.start, ws.end], [true, '2026-12-14T00:00:00.000Z', '2026-12-17T00:00:00.000Z']);
  ok('E3 live: multi-day all-day 14.-16. 12. (end exclusive, no zone shift)');
  const ny = by('New York')[0];
  assert.equal(ny.timeZone, 'America/New_York'); assert.equal(prague(ny.start), '3. 12. 2026 16:00');
  const mid = by('přes půlnoc')[0];
  assert.deepEqual([prague(mid.start), prague(mid.end)], ['10. 12. 2026 22:00', '11. 12. 2026 2:00']);
  const dst = test((await app(`/api/calendar/events?${new URLSearchParams({ from: '2027-03-27T00:00:00Z', to: '2027-03-30T00:00:00Z', pageSize: '50' })}`, A)).json.items).find((e) => e.title.includes('DST'));
  assert.equal(Date.parse(dst.end) - Date.parse(dst.start), 3600e3, '01:30 CET -> 03:30 CEST = 1 real hour'); assert.equal(prague(dst.start), '28. 3. 2027 1:30');
  ok('E4 live: event zone America/New_York (16:00 Prague), across midnight, DST 2027-03-28 = 1 real hour');
  const priv = by('soukromá')[0];
  assert.equal(priv.private, true);
  // attach: occurrence, modified occurrence, midnight, the private one (refused), the one to reschedule
  const resched = by('přeplánovat')[0];
  const ids = [occ[0].id, occ[1].id, mid.id, priv.id, resched.id];
  let a = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: P, eventIds: ids }) });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.deepEqual(a.json.failed.map((f) => [f.eventId === priv.id, f.reason]), [[true, 'private']]);
  assert.equal(a.json.links.length, 4);
  const L = Object.fromEntries(a.json.links.map((l) => [l.eventId, l.id]));
  ok('E6 live: the private event is refused (409-class "private"); 4 events linked');
  a = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: P, eventIds: [occ[0].id] }) });
  assert.equal(a.status, 200); assert.equal(a.json.links[0].duplicate, true); assert.equal(a.json.links[0].id, L[occ[0].id]);
  ok('E7 live: the same occurrence again -> same link (duplicate)');
  // shared rows as the viewer + editor: no ids, no htmlLink, nothing private
  const rows = await rest(`external_resource_links?project_id=eq.${P}&provider=eq.google_calendar_event&select=*`, V);
  assert.equal(rows.length, 4);
  const raw = JSON.stringify(rows);
  for (const id of ids) assert.ok(!raw.includes(id), 'no event id in shared rows');
  for (const leak of ['google.com/calendar', 'eid=', 'Testovací událost', LOCAL_PART]) assert.ok(!raw.includes(leak), 'shared rows leak a private value');
  const mr = rows.find((x) => x.id === L[occ[1].id]);
  assert.deepEqual([mr.event_recurring, prague(mr.event_start), mr.event_time_zone], [true, '9. 12. 2026 11:00', 'Europe/Prague']);
  console.log('shared organizer label:', JSON.stringify(rows[0].event_organizer), '| attendees:', rows.map((x) => x.event_attendees).join(','));
  assert.ok(!String(rows[0].event_organizer).includes(LOCAL_PART), 'organizer never the full address');
  ok('shared rows (viewer): title / times / flags / count / organizer name-or-domain only; no event id, htmlLink, description or address');
  // owner-only: open + refresh; editor and viewer refused
  const o = await app(`/api/calendar/links/${L[occ[0].id]}/open`, A);
  assert.equal(o.status, 200); assert.match(o.json.url, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
  for (const t of [B, V]) { assert.equal((await app(`/api/calendar/links/${L[occ[0].id]}/open`, t)).status, 403); assert.equal((await app(`/api/calendar/links/${L[occ[0].id]}/refresh`, t, { method: 'POST', body: '{}' })).status, 403); }
  assert.equal((await app('/api/calendar/links', V, { method: 'POST', body: JSON.stringify({ projectId: P, eventIds: [occ[2].id] }) })).status, 403);
  assert.equal((await app('/api/calendar/links', B, { method: 'POST', body: JSON.stringify({ projectId: P, eventIds: [occ[2].id] }) })).json.error, 'not_connected');
  ok('roles live: open (Google htmlLink) + refresh only for the owner of the link; editor / viewer 403; viewer cannot attach; editor without Google 409');
  // the task-level link + activity without the title
  const card = (await rest(`cards?select=id,title&limit=1`, A))[0];
  a = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: P, cardId: card.id, eventIds: [ws.id] }) });
  assert.equal(a.status, 201);
  const act = await rest(`activity_logs?project_id=eq.${P}&action_type=eq.event_linked&select=details&order=created_at.desc&limit=5`, B);
  assert.ok(act.length >= 1 && act.every((x) => !JSON.stringify(x.details).includes('ClearSpace TEST')), 'activity carries no event title');
  ok('task-level link (all-day multi-day) + activity without the event title (read by the editor)');
  writeFileSync(STATE, JSON.stringify({ L, occ: occ.map((e) => e.id), resched: resched.id, ws: ws.id }));
  console.log(`\nNEXT: in Google Calendar move "ClearSpace TEST – přeplánovat" (5. 12. 10:00) to 7. 12. 2026 14:00 and DELETE the 23. 12. occurrence; then run phase after-change`);
}

if (phase === 'after-change') {
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  let r = await app(`/api/calendar/links/${s.L[s.resched]}/refresh`, A, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200); assert.equal(r.json.state, 'ok');
  const row = (await rest(`external_resource_links?id=eq.${s.L[s.resched]}&select=event_start,event_end,provider_state`, V))[0];
  console.log('rescheduled event as the viewer sees it:', prague(row.event_start), '-', prague(row.event_end));
  assert.equal(prague(row.event_start), '7. 12. 2026 14:00');
  ok('E5 live: rescheduled in Google -> owner refresh -> the team sees the new time');
  r = await app(`/api/calendar/links/${s.L[s.occ[0]]}/refresh`, A, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200);
  const del = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: P, eventIds: [s.occ[2]] }) });
  console.log('attach the deleted 23. 12. occurrence ->', del.status, JSON.stringify(del.json.failed?.map((f) => f.reason)));
  assert.deepEqual(del.json.failed.map((f) => f.reason), ['not_found']);
  ok('E5 live: an occurrence deleted in Google cannot be attached (not found)');
}

if (phase === 'deleted-linked') {   // after deleting a LINKED event (the rescheduled one) in Google
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  const r = await app(`/api/calendar/links/${s.L[s.resched]}/refresh`, A, { method: 'POST', body: '{}' });
  console.log('refresh of a linked event deleted in Google ->', r.status, r.json.state);
  assert.equal(r.json.state, 'deleted');
  const row = (await rest(`external_resource_links?id=eq.${s.L[s.resched]}&select=provider_state,name,event_start`, V))[0];
  assert.equal(row.provider_state, 'deleted'); assert.ok(row.name.startsWith('ClearSpace TEST')); assert.equal(prague(row.event_start), '7. 12. 2026 14:00');
  assert.equal((await app(`/api/calendar/links/${s.L[s.resched]}/open`, A)).status, 404);
  ok('E5 live: linked event deleted in Google -> "deleted", last metadata kept, open refused');
}

if (phase === 'off') {   // Calendar switched off in ClearSpace (Drive untouched); grant at Google unchanged
  const r = await app('/api/calendar/connection', A, { method: 'DELETE' });
  assert.equal(r.status, 200); assert.equal(r.json.calendarRemoved, true);
  const st = (await app('/api/google/connection', A)).json;
  assert.deepEqual([st.connection.services.drive, st.connection.services.calendar, st.connection.status], [true, false, 'active']);
  assert.equal((await app(`/api/calendar/events?${DEC}`, A)).json.error, 'calendar_not_granted');
  assert.equal((await app('/api/google/picker-token', A, { method: 'POST', body: '{}' })).status, 200);
  ok('E9/E10 live: "Vypnout Kalendář" -> Calendar refused (calendar_not_granted), Drive still works, connection active');
}

if (APP_LOG && existsSync(APP_LOG)) {
  const log = readFileSync(APP_LOG, 'utf8');
  for (const leak of ['ClearSpace TEST', 'ya29.', '1//', 'eid=', '/api/calendar/events?', LOCAL_PART, 'code=4/']) assert.ok(!log.includes(leak), 'dev server log contains a private value');
  ok('dev server log: no event titles, tokens, codes, htmlLinks, search URLs or the Google address');
}
console.log(`LIVE ACCEPT (${phase}) PASS`);
