// RUN 04 live gate, against REAL Google (dev project, Testing). Run through: frontend/scripts/calendar-live.sh gate [expect-no-calendar]
// Prints scopes, HTTP statuses and COUNTS only -- never a token, an event title, an id or an address.
//  A. Token isolation (E10): the browser's Picker token carries NOTHING beyond identity + drive.file -- Google's own tokeninfo --
//     and the Calendar and Gmail APIs refuse it.
//  B. Scope probe (Phase 0): a token narrowed to calendar.events.owned.readonly (refresh grant with `scope`, in memory only) can
//     list the primary calendar (timeMin/timeMax, singleEvents, orderBy, q, pageToken, fields) and get an occurrence; tokeninfo
//     shows only identity + that scope; real event ids match our id rule; nothing is dropped by our normalization.
//  C. The product path: /api/calendar/events returns the same events; with Calendar switched off in ClearSpace -> 409.
import { createDecipheriv } from 'node:crypto';
import assert from 'node:assert/strict';

const { E2E_SUPABASE_URL: API, E2E_SUPABASE_ANON_KEY: ANON, E2E_BASE_URL: APP, E2E_PASSWORD: PW, GOOGLE_SERVER_SECRET: SECRET,
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEYB64, GOOGLE_OAUTH_CLIENT_ID: CID, GOOGLE_OAUTH_CLIENT_SECRET: CSEC, GOOGLE_API_MOCK_BASE: MOCK } = process.env;
for (const u of [API, APP]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u ?? '')) { console.error('refusing: loopback only'); process.exit(2); }
if (MOCK || !CSEC?.startsWith('GOCSPX-')) { console.error('refusing: real-Google mode only'); process.exit(2); }
const expectCalendar = process.argv[2] !== 'expect-no-calendar';
const CAL = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
const IDENTITY = new Set(['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email']);
const EVENT_ID_RE = /^[A-Za-z0-9_]{5,1024}$/;
const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };
const scopesOf = async (token) => String((await j(await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`))).scope ?? '').split(' ').filter(Boolean).sort();

const login = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@collab.test', password: PW }) });
const session = await j(login);
assert.ok(session.access_token, 'dev identity alice signs in');
const auth = { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' };
const status = await j(await fetch(`${APP}/api/google/connection`, { headers: auth }));
assert.equal(status.simulated, false, 'the app runs against REAL Google');
console.log('ClearSpace services:', JSON.stringify(status.connection?.services), '| calendarAvailable:', status.calendarAvailable);

// ---------------------------------------------------------------- A. Picker token isolation
if (status.connection?.services?.drive) {
  const pt = await fetch(`${APP}/api/google/picker-token`, { method: 'POST', headers: auth });
  const body = await j(pt);
  assert.equal(pt.status, 200, `picker-token minted (got ${pt.status} ${body.error ?? ''})`);
  const s = await scopesOf(body.accessToken);
  console.log('A. Picker token scopes (Google tokeninfo):', s.join(' '));
  assert.ok(s.includes(DRIVE_FILE)); assert.deepEqual(s.filter((x) => !IDENTITY.has(x) && x !== DRIVE_FILE), [], 'Picker token: identity + drive.file only');
  const H = { Authorization: `Bearer ${body.accessToken}` };
  const cal = (await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1', { headers: H })).status;
  const gm = (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: H })).status;
  const dr = (await fetch('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)', { headers: H })).status;
  console.log(`A. with the Picker token: Calendar API ${cal}, Gmail API ${gm}, Drive API ${dr}`);
  assert.equal(cal, 403, 'Calendar refuses the Picker token'); assert.equal(gm, 403, 'Gmail refuses the Picker token'); assert.equal(dr, 200);
} else console.log('A. skipped: Drive not connected for alice (connect Drive to run the Picker isolation gate)');

// ---------------------------------------------------------------- B. direct scope probe with a Calendar-only token (in memory)
const cred = await j(await fetch(`${API}/rest/v1/rpc/google_credentials_get`, { method: 'POST', headers: { ...auth, apikey: ANON }, body: JSON.stringify({ p_server_secret: SECRET, p_cost: 0 }) }));
const row = Array.isArray(cred) ? cred[0] : cred;
assert.ok(row?.refresh_token_enc, 'stored (encrypted) refresh token present -- connect first');
const m = /^v1\.([0-9a-f]{8})\.([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(row.refresh_token_enc);
const d = createDecipheriv('aes-256-gcm', Buffer.from(KEYB64.trim(), 'base64'), Buffer.from(m[2], 'base64url'));
d.setAAD(Buffer.from(`clearspace:google:refresh:${row.user_id}`, 'utf8')); d.setAuthTag(Buffer.from(m[4], 'base64url'));
const refresh = Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString('utf8');
const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CID, client_secret: CSEC, scope: CAL }) });
const tb = await j(tr);
if (!expectCalendar) {
  console.log('B. narrowed Calendar token request ->', tr.status, tb.error ?? 'ok (grant at Google may still hold Calendar; ClearSpace no longer uses it)');
} else {
  assert.equal(tr.status, 200, `Calendar-narrowed token (${tb.error ?? ''})`);
  const s = await scopesOf(tb.access_token);
  console.log('B. Calendar token scopes (Google tokeninfo):', s.join(' '));
  assert.deepEqual(s.filter((x) => !IDENTITY.has(x)), [CAL], 'only the read-only Calendar scope');
  const H = { Authorization: `Bearer ${tb.access_token}` };
  // window: LIVE_FROM (YYYY-MM-DD, default today) + 41 days (the product's maximum is 42); one base instant, no drift
  const base = Date.parse(`${process.env.LIVE_FROM ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const from = new Date(base).toISOString(); const to = new Date(base + 41 * 86400e3).toISOString();
  const fields = 'items(id,status,summary,start,end,recurringEventId,originalStartTime,visibility,organizer(displayName,email),attendees(responseStatus),htmlLink,updated,eventType),nextPageToken';
  const list = async (extra = {}) => {
    const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', fields, ...extra });
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: H });
    return { status: r.status, body: await j(r) };
  };
  const all = await list();
  assert.equal(all.status, 200, 'events.list on the primary calendar with owned.readonly');
  const items = all.body.items ?? [];
  const bad = items.filter((e) => !EVENT_ID_RE.test(e.id)).length;
  const rec = items.filter((e) => e.recurringEventId); const mod = rec.filter((e) => e.originalStartTime && (e.originalStartTime.dateTime ?? e.originalStartTime.date) !== (e.start.dateTime ?? e.start.date));
  const keys = new Set(items.flatMap((e) => Object.keys(e)));
  console.log(`B. events.list -> 200 | events=${items.length} recurring-occurrences=${rec.length} modified-occurrences=${mod.length} all-day=${items.filter((e) => e.start?.date).length}`
    + ` private/confidential=${items.filter((e) => e.visibility === 'private' || e.visibility === 'confidential').length} ids-not-matching-rule=${bad} | response keys: ${[...keys].sort().join(',')}`);
  assert.equal(bad, 0, 'every real event id matches the id rule');
  for (const k of ['description', 'location', 'hangoutLink', 'conferenceData', 'attachments']) assert.ok(!keys.has(k), `fields trimming: Google sent no ${k}`);
  const small = await list({ maxResults: '2' });
  console.log('B. pagination (maxResults=2) ->', small.status, '| nextPageToken present:', Boolean(small.body.nextPageToken));
  if (small.body.nextPageToken) assert.equal((await list({ maxResults: '2', pageToken: small.body.nextPageToken })).status, 200, 'pageToken accepted');
  const word = (items.find((e) => typeof e.summary === 'string' && /\p{L}{4,}/u.test(e.summary))?.summary.match(/\p{L}{4,}/u) ?? [])[0];
  if (word) { const q = await list({ q: word }); console.log('B. q search ->', q.status, '| hits:', (q.body.items ?? []).length); assert.equal(q.status, 200); assert.ok((q.body.items ?? []).length >= 1); }
  const target = rec[0] ?? items[0];
  if (target) {
    const g = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${target.id}?fields=${encodeURIComponent(fields.slice(6, -15))}`, { headers: H });
    const gb = await j(g);
    console.log(`B. events.get (${rec[0] ? 'an occurrence' : 'an event'}) -> ${g.status} | same id: ${gb.id === target.id}`);
    assert.equal(g.status, 200); assert.equal(gb.id, target.id);
  }
  // C. product path returns the same set (minus working-location markers and cancelled), nothing dropped by normalization
  const p = await fetch(`${APP}/api/calendar/events?${new URLSearchParams({ from, to, pageSize: '250' })}`, { headers: auth });
  const pb = await j(p);
  const expected = items.filter((e) => e.eventType !== 'workingLocation' && e.status !== 'cancelled').length;
  console.log(`C. /api/calendar/events -> ${p.status} | events=${pb.items?.length} (Google: ${expected} after skipping working-location / cancelled)`);
  assert.equal(p.status, 200); assert.equal(pb.items.length, expected, 'no event dropped by normalization');
  assert.ok(!JSON.stringify(pb).match(/"(description|location|hangoutLink|conferenceData)"/), 'product response carries none of the private fields');
}
if (!expectCalendar) {
  const p = await fetch(`${APP}/api/calendar/events?${new URLSearchParams({ from: new Date().toISOString(), to: new Date(Date.now() + 86400e3).toISOString() })}`, { headers: auth });
  console.log('C. /api/calendar/events with Calendar switched off in ClearSpace ->', p.status, (await j(p)).error);
  assert.equal(p.status, 409);
}
console.log(`CALENDAR LIVE GATE PASS (${expectCalendar ? 'Calendar enabled' : 'Calendar disabled in ClearSpace'})`);
