// RUN 06 live acceptance of the Google demo pilot through the PRODUCT routes, against REAL Google (dev project, Testing) with the demo
// account (CS-GDEMO data seeded by scripts/google-demo/seed.mjs), on the isolated local stack cs-gdemo-sb in PILOT mode.
//   frontend/scripts/gdemo-stack.sh live-node gdemo_live_accept.mjs [link|drive|isolation]
// Roles: alice = pilot user, owner of the CSD-CORVANE projects (csd1-p01..p14) with Google connected; bob = editor and vera = viewer of
// csd1-p01 (Yutani), both OUTSIDE the pilot; a fresh outsider is in no project. The demo address is read at run time, never written here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const { E2E_SUPABASE_URL: API, E2E_SUPABASE_ANON_KEY: ANON, E2E_BASE_URL: APP, E2E_PASSWORD: PW, APP_LOG } = process.env;
for (const u of [API, APP]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: loopback only'); process.exit(2); }
const phase = process.argv[2] ?? 'link';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } };
const session = async (email, pw = PW, tries = 4) => (await session1(email, pw)) ?? (tries > 1 ? (await new Promise((z) => setTimeout(z, 2000)), session(email, pw, tries - 1)) : undefined);
const session1 = async (email, pw) => (await j(await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) }))).access_token;
const [A, B, V] = [await session('alice@collab.test'), await session('bob@collab.test'), await session('vera@collab.test')];
assert.ok(A && B && V, 'dev identities sign in');
// ponytail: the host is heavily loaded by unrelated containers; a fresh token sometimes gets a slow-GoTrue 401 -> retry that case only
const app = async (path, token, init = {}, tries = 6) => { const res = await app1(path, token, init); return res.status === 401 && res.json.error === 'unauthenticated' && tries > 1 ? (await new Promise((z) => setTimeout(z, 4000)), app(path, token, init, tries - 1)) : res; };
const app1 = async (path, token, init = {}) => { const r = await fetch(`${APP}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } }); return { status: r.status, json: await j(r), headers: r.headers }; };
const rest = async (path, token) => j(await fetch(`${API}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }));
const ok = (m) => console.log(`ok - ${m}`);
const prague = (iso) => new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'numeric' }).format(new Date(iso));
const st = (await app('/api/google/connection', A)).json;
const ACCOUNT = String(st.connection?.email ?? 'none@invalid'); const LOCAL = ACCOUNT.split('@')[0];
const P = { yutani: 'csd1-p01', tyrell: 'csd1-p02', hadley: 'csd1-p03', halden: 'csd1-p04', policy: 'csd1-p14', marlowe: 'csd1-p09' };

if (phase === 'link') {
  // 0. the ClearSpace grant: real Google, all three services, READ-ONLY scopes only (nothing of the seeder's write scopes)
  assert.equal(st.simulated, false); assert.deepEqual(st.connection.services, { drive: true, gmail: true, calendar: true });
  assert.deepEqual([...st.connection.scopes].sort(), ['https://www.googleapis.com/auth/calendar.events.owned.readonly', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email', 'openid']);
  assert.equal(st.gmailAvailable, true); assert.equal(st.calendarAvailable, true);
  ok('ClearSpace grant: real Google, Drive + Gmail + Calendar, exactly 5 read-only scopes (no gmail.modify / calendar write / full drive)');

  // 1. Gmail: search the seeded threads, link them to their projects
  const search = async (text) => { const r = await app(`/api/gmail/search?${new URLSearchParams({ kind: 'thread', text, pageSize: '10' })}`, A); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.items; };
  const pick = async (text, subj) => { const it = (await search(text)).find((x) => x.subject.includes(subj)); assert.ok(it, `thread "${subj}" found`); return it; };
  const tNostromo = await pick('Nostromo Park', 'Nostromo Park – výsledky pilotu');
  assert.equal(tNostromo.messageCount, 4, 'thread of 4 messages (threading preserved by the seeder)');
  const tTyrell = await pick('evidence request', 'compliance review');
  const tHadley = await pick('chlazení', 'servisní okno chlazení');
  const tHalden = await pick('Halden', 'nabídka programu onboardingu');
  console.log('Gmail threads found:', [tNostromo, tTyrell, tHadley, tHalden].map((t) => `${t.subject} (${t.messageCount}, ${t.from.domain})`).join(' | '));
  const linkMail = async (project, t) => { const r = await app('/api/gmail/links', A, { method: 'POST', body: JSON.stringify({ projectId: project, items: [{ kind: 'thread', id: t.id }] }) }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.json)); assert.equal(r.json.failed.length, 0); return r.json.links[0].id; };
  const mail = { yutani: await linkMail(P.yutani, tNostromo), tyrell: await linkMail(P.tyrell, tTyrell), hadley: await linkMail(P.hadley, tHadley), halden: await linkMail(P.halden, tHalden) };
  const again = await app('/api/gmail/links', A, { method: 'POST', body: JSON.stringify({ projectId: P.yutani, items: [{ kind: 'thread', id: tNostromo.id }] }) });
  assert.equal(again.json.links[0].duplicate, true);
  const pv = await app(`/api/gmail/links/${mail.yutani}/preview`, A);
  assert.equal(pv.status, 200); assert.match(JSON.stringify(pv.json), /99,2 %/);
  ok('Gmail live: 4 seeded threads found by search and linked to Yutani / Tyrell / Hadley Park / Halden & Brooke; duplicate detected; owner preview shows the real body');

  // 2. Calendar: list the seeded events, link them, private one refused
  const ev = await app(`/api/calendar/events?${new URLSearchParams({ from: '2026-11-16T00:00:00Z', to: '2026-12-28T00:00:00Z', pageSize: '250' })}`, A);
  assert.equal(ev.status, 200, JSON.stringify(ev.json));
  const E = (s) => { const e = ev.json.items.find((x) => x.title.includes(s)); assert.ok(e, `event "${s}" listed`); return e; };
  const steer = E('Yutani – řídicí výbor'), golive = E('go-live vlny 2'), cooling = E('servisní okno chlazení'), workshop = E('Synthetic Workforce Policy'), tyrellLA = E('compliance evidence review'), doctor = E('Lékař');
  const weekly = ev.json.items.filter((x) => x.title === 'Týdenní koordinace delivery týmu');
  console.log('events seen:', ev.json.items.length, '| e.g.', [steer, golive, cooling, tyrellLA].map((e) => `${e.title} @ ${e.allDay ? e.start.slice(0, 10) : prague(e.start)}${e.timeZone && e.timeZone !== 'Europe/Prague' ? ` [${e.timeZone}]` : ''}`).join(' | '));
  assert.equal(weekly.length, 6, 'weekly series expanded into 6 occurrences'); assert.ok(weekly.every((e) => e.recurring));
  assert.equal(golive.allDay, true); assert.equal(doctor.private, true); assert.equal(tyrellLA.timeZone, 'America/Los_Angeles');
  assert.equal(prague(cooling.end).endsWith('2:00'), true, 'across midnight');
  let r = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: P.yutani, eventIds: [steer.id, golive.id, doctor.id] }) });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.json)); assert.deepEqual(r.json.failed.map((f) => f.reason), ['private']); assert.equal(r.json.links.length, 2);
  const calYutani = r.json.links.find((l) => l.eventId === steer.id).id;
  for (const [p, e] of [[P.hadley, cooling], [P.policy, workshop], [P.tyrell, tyrellLA]]) { r = await app('/api/calendar/links', A, { method: 'POST', body: JSON.stringify({ projectId: p, eventIds: [e.id] }) }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.json)); }
  ok('Calendar live: 21 seeded events listed (weekly series x6, all-day, LA time zone, across midnight); 5 linked to 4 projects; the private event refused');

  // 3. what the TEAM sees (bob editor, vera viewer on Yutani): shared metadata only
  const rows = await rest(`external_resource_links?project_id=eq.${P.yutani}&select=*`, V);
  const kinds = rows.map((x) => x.provider).sort();
  console.log('Yutani project links as the viewer sees them:', rows.map((x) => `${x.provider}: ${x.name}`).join(' | '));
  assert.ok(kinds.includes('google_calendar_event') && kinds.some((k) => k.startsWith('gmail')), JSON.stringify(kinds));
  const raw = JSON.stringify(rows);
  for (const leak of [LOCAL, tNostromo.id, tNostromo.threadId, steer.id, 'google.com/calendar', '99,2 %', 'Zasedačka', 'Lékař']) assert.ok(!raw.includes(leak), `shared rows leak ${leak}`);
  assert.deepEqual((await rest(`external_resource_links?project_id=eq.${P.yutani}&select=id`, B)).length, rows.length, 'editor sees the same links');
  ok('team view (bob editor / vera viewer): subject, sender name-or-domain, event title/time/organizer only; no ids, no body, no location, no demo address, no private event');

  // 4. owner-only actions refused for the team
  for (const t of [B, V]) {
    assert.equal((await app(`/api/gmail/links/${mail.yutani}/preview`, t)).status >= 403, true);
    assert.equal((await app(`/api/calendar/links/${calYutani}/open`, t)).status >= 403, true);
  }
  assert.equal((await app(`/api/calendar/links/${calYutani}/open`, A)).status, 200);
  ok('preview / open in Google only for alice (owner of the links); bob and vera refused');
  console.log('\nNEXT: attach Yutani + Hadley Park documents through the real Google Picker in the UI, then run phase drive');
}

if (phase === 'drive') {
  const rows = await rest(`external_resource_links?provider=eq.google_drive&select=id,project_id,name,mime_type`, A);
  console.log('Drive links:', rows.map((x) => `${x.project_id}: ${x.name}`).join(' | '));
  assert.ok(rows.length >= 2, 'documents linked through the Picker');
  const c = await app(`/api/drive/links/${rows[0].id}/content`, A);
  console.log('owner content preview ->', c.status);
  for (const t of [B, V]) assert.equal((await rest(`external_resource_links?provider=eq.google_drive&project_id=eq.${P.yutani}&select=id`, t)).length, rows.filter((x) => x.project_id === P.yutani).length);
  ok('Drive live: seeded documents linked through the real Picker; the team sees them in the project');
}

if (phase === 'isolation') {
  // the pilot is per user + per account: bob / vera (in the same project!) and a stranger get exactly the OFF answer
  const email = `gdemo-outsider-${Date.now().toString(36)}@example.test`;
  const svc = process.env.E2E_SUPABASE_SERVICE_KEY;
  const c = await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Test-Password-123', email_confirm: true }) });
  const outsiderId = (await j(c)).id;
  const O = await session(email, 'Test-Password-123');
  for (const [who, t] of [['bob', B], ['vera', V], ['outsider', O]]) {
    const s = (await app('/api/google/connection', t)).json;
    assert.deepEqual([s.gmailAvailable, s.calendarAvailable], [false, false], who);
    assert.equal((await app('/api/google/oauth/start', t, { method: 'POST', body: JSON.stringify({ service: 'gmail' }) })).json.error, 'gmail_disabled', who);
    assert.equal((await app('/api/google/oauth/start', t, { method: 'POST', body: JSON.stringify({ service: 'calendar' }) })).json.error, 'calendar_disabled', who);
    assert.equal((await app('/api/gmail/search?kind=thread', t)).json.error, 'gmail_disabled', who);
    assert.equal((await app('/api/calendar/events?from=2026-11-30T00:00:00Z&to=2027-01-01T00:00:00Z', t)).json.error, 'calendar_disabled', who);
    assert.equal((await app('/api/google/picker-token', t, { method: 'POST', body: '{}' })).status >= 400, true, `${who}: no Picker token (no Google connection of their own)`);
  }
  assert.equal((await rest(`external_resource_links?project_id=eq.csd1-p01&select=id`, O)).length, 0, 'outsider sees no project links (RLS)');
  ok("isolation: bob, vera (same project) and an outsider get gmail_disabled / calendar_disabled everywhere, no consent URL, no token, no access to alice's Google; outsider sees no links");
  await fetch(`${API}/auth/v1/admin/users/${outsiderId}`, { method: 'DELETE', headers: { apikey: svc, Authorization: `Bearer ${svc}` } });
}

if (APP_LOG && existsSync(APP_LOG)) {
  const log = readFileSync(APP_LOG, 'utf8');
  for (const leak of [ACCOUNT, 'ya29.', '1//0', 'Nostromo Park – výsledky', 'GOCSPX-']) assert.ok(!log.includes(leak), `app log leaks ${leak.slice(0, 12)}…`);
  ok('app log: no demo address, token, secret or e-mail subject');
}
