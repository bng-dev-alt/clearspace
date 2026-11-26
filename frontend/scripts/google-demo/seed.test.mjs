// RUN 06 Google demo seeder: dataset invariants, MIME/Calendar builders, the identity guard, and the full seed -> re-seed -> cleanup ->
// restore cycle against a FAKE Google on 127.0.0.1 (nothing here talks to Google).   node --test scripts/google-demo/seed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMessages, buildEvents, checkIdentity, eventId, validate, SEED_SCOPES } from './seed.mjs';
import { zoned, workday, EVENTS } from './dataset.mjs';

const ME = 'alex.demo@example.net', CLIENT = 'seeder-client.apps.googleusercontent.com';
const RESERVED = /@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.example)>?$/i;

test('dataset: counts in the requested ranges, keys unique, projects known, no e-mail in the future', () => {
  const v = validate('2026-11-26');
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.counts, { gmail: 42, threads: 14, drive: 21, folders: 7, calendar: 21 });
});

test('gmail: every address is reserved (except the demo account), threading headers, encoded subject, signature', () => {
  const msgs = buildMessages('2026-11-26', ME);
  for (const m of msgs) {
    const hdr = m.raw.split('\r\n\r\n')[0];
    for (const a of hdr.match(/<[^<>\s]+@[^<>\s]+>/g).filter((x) => !x.includes('corvane.example>') || !/Message-ID|In-Reply-To|References/.test(x))) assert.ok(a === `<${ME}>` || RESERVED.test(a), `${m.key}: ${a}`);
    assert.match(hdr, /^Date: (Mon|Tue|Wed|Thu|Fri), /m, `${m.key} on a working day`);
  }
  const t1 = msgs.filter((m) => m.thread === 't01');
  assert.equal(t1.length, 4);
  assert.match(t1[1].raw, new RegExp(`In-Reply-To: ${t1[0].messageId}`));
  assert.match(t1[3].raw, new RegExp(`References: ${t1[0].messageId} ${t1[1].messageId} ${t1[2].messageId}`));
  const subj = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(t1[0].raw)[1];
  assert.equal(Buffer.from(subj, 'base64').toString(), 'Nostromo Park – výsledky pilotu ručních skenerů');
  const body = Buffer.from(t1[1].raw.split('\r\n\r\n').at(-1).replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /Account Director \| Corvane Systems/);
  assert.deepEqual(t1[1].labelIds, ['SENT']);
  assert.ok(msgs.some((m) => /multipart\/mixed/.test(m.raw)), 'attachments present');
});

test('calendar: deterministic valid ids, Prague offsets incl. DST, private + all-day + recurring + foreign time zone', () => {
  const ev = buildEvents('2026-11-26');
  for (const e of ev) { assert.match(e.id, /^[a-v0-9]{5,1024}$/); assert.ok(!e.attendees || e.attendees.every((a) => RESERVED.test(a.email))); }
  assert.equal(eventId('e01'), buildEvents('2027-01-04')[0].id, 'id independent of the anchor');
  assert.equal(new Set(ev.map((e) => e.id)).size, EVENTS.length);
  assert.equal(zoned('2026-11-26', '10:00'), '2026-11-26T10:00:00+01:00');
  assert.equal(zoned('2027-03-28', '03:30'), '2027-03-28T03:30:00+02:00');
  assert.equal(zoned('2026-12-01', '07:00', 'America/Los_Angeles'), '2026-12-01T07:00:00-08:00');
  assert.equal(workday('2026-11-26', 2), '2026-11-30');
  const by = Object.fromEntries(EVENTS.map((e, i) => [e.key, ev[i]]));
  assert.equal(by.e20.visibility, 'private');
  assert.deepEqual(by.e10.start, { date: '2026-12-22' }); assert.deepEqual(by.e10.end, { date: '2026-12-24' });
  assert.deepEqual(by.e01.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=6']);
  assert.equal(by.e06.start.dateTime, '2026-12-02T22:00:00+01:00'); assert.equal(by.e06.end.dateTime, '2026-12-03T02:00:00+01:00');
});

test('identity guard: refuses any other account, audience or scope set', () => {
  const scope = 'openid https://www.googleapis.com/auth/userinfo.email ' + SEED_SCOPES.slice(2).join(' ');
  const good = { expected: ME, clientId: CLIENT, tokenInfo: { aud: CLIENT, email: ME, email_verified: 'true', scope }, gmailEmail: ME, driveEmail: ME.toUpperCase() };
  assert.deepEqual(checkIdentity(good), []);
  assert.ok(checkIdentity({ ...good, gmailEmail: 'owner.private@example.com' }).length);
  assert.ok(checkIdentity({ ...good, tokenInfo: { ...good.tokenInfo, aud: 'clearspace-web.apps.googleusercontent.com' } }).length);
  assert.ok(checkIdentity({ ...good, tokenInfo: { ...good.tokenInfo, scope: `${scope} https://mail.google.com/` } }).length);
  assert.ok(checkIdentity({ ...good, tokenInfo: { ...good.tokenInfo, scope: scope.replace(/ \S+calendar\.events\.owned/, '') } }).length);
  assert.ok(checkIdentity({ ...good, expected: '' }).length);
});

// ------------------------------------------------------------------------------------------------ fake Google
function fakeGoogle(account) {
  const st = { account, msgs: [], files: [], events: new Map(), writes: 0, paths: new Set() };
  let n = 0;
  const srv = createServer(async (rq, rs) => {
    let body = ''; for await (const c of rq) body += c;
    const u = new URL(rq.url, 'http://x'); const p = u.pathname; const send = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }).end(j === undefined ? '' : JSON.stringify(j)); };
    st.paths.add(`${rq.method} ${p.replace(/\/[A-Za-z0-9_-]{6,}(?=\/|$)/g, '/:id')}`);
    if (rq.method !== 'GET') st.writes++;
    if (p === '/token') return send(200, { access_token: 'fake-at', expires_in: 3600, scope: SEED_SCOPES.join(' ') });
    if (p === '/tokeninfo') return send(200, { aud: CLIENT, email: st.account, email_verified: 'true', scope: 'openid https://www.googleapis.com/auth/userinfo.email ' + SEED_SCOPES.slice(2).join(' ') });
    if (p === '/gmail/v1/users/me/profile') return send(200, { emailAddress: st.account });
    if (p === '/drive/v3/about') return send(200, { user: { emailAddress: st.account } });
    if (p === '/gmail/v1/users/me/messages' && rq.method === 'GET') {
      const id = /rfc822msgid:(\S+)/.exec(u.searchParams.get('q'))[1];
      return send(200, { messages: st.msgs.filter((m) => m.mid === `<${id}>`).map(({ id: i, threadId }) => ({ id: i, threadId })) });
    }
    if (p === '/gmail/v1/users/me/messages' && rq.method === 'POST') {
      const j = JSON.parse(body); const raw = Buffer.from(j.raw, 'base64url').toString();
      const m = { id: `m${++n}xxxxxx`, threadId: j.threadId ?? `t${n}xxxxxx`, labelIds: j.labelIds, mid: /Message-ID: (\S+)/.exec(raw)[1] }; st.msgs.push(m); return send(200, m);
    }
    let x;
    if ((x = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)(\/(trash|untrash))?$/.exec(p))) {
      const m = st.msgs.find((y) => y.id === x[1]);
      if (x[3] === 'trash') m.labelIds = [...m.labelIds, 'TRASH']; if (x[3] === 'untrash') m.labelIds = m.labelIds.filter((l) => l !== 'TRASH');
      return send(200, m);
    }
    if (p === '/drive/v3/files' && rq.method === 'GET') {
      const key = /value='([^']+)'/.exec(u.searchParams.get('q'))[1];
      return send(200, { files: st.files.filter((f) => f.appProperties.csdemo === key && !f.trashed) });
    }
    if (p === '/drive/v3/files' || p === '/upload/drive/v3/files') {
      const meta = p.startsWith('/upload') ? JSON.parse(/\r\n\r\n(\{.*\})\r\n/.exec(body)[1]) : JSON.parse(body);
      const f = { id: `f${++n}xxxxxx`, ...meta, trashed: false }; st.files.push(f); return send(200, { id: f.id });
    }
    if ((x = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) { const f = st.files.find((y) => y.id === x[1]); Object.assign(f, JSON.parse(body)); return send(200, { id: f.id }); }
    if (p === '/calendar/v3/calendars/primary/events' && rq.method === 'POST') {
      const e = JSON.parse(body); if (st.events.has(e.id)) return send(409, { error: { status: 'duplicate' } });
      st.events.set(e.id, { ...e, status: 'confirmed' }); return send(200, e);
    }
    if ((x = /^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/.exec(p))) {
      const e = st.events.get(x[1]); if (!e) return send(404, {});
      if (rq.method === 'GET') return send(200, e);
      if (rq.method === 'PUT') { st.events.set(x[1], JSON.parse(body)); return send(200, {}); }
      if (rq.method === 'DELETE') { if (e.status === 'cancelled') return send(410, {}); e.status = 'cancelled'; return send(204); }
    }
    if (p === '/revoke') return send(200, {});
    send(404, { error: `unexpected ${rq.method} ${p}` });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ st, srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const SEED = fileURLToPath(new URL('./seed.mjs', import.meta.url));
const run = (base, args) => new Promise((resolve) => execFile(process.execPath, [SEED, ...args], {
  env: { ...process.env, SEED_GOOGLE_BASE: base, SEED_FAKE_KEYCHAIN: JSON.stringify({ client_id: CLIENT, client_secret: 'GOCSPX-fake', demo_account: ME, refresh_token: '1//fake' }) },
}, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr })));

test('seeder end-to-end against a fake Google: seed, idempotent re-seed, status, cleanup (trash), restore', async () => {
  const { st, srv, base } = await fakeGoogle(ME);
  try {
    let r = await run(base, ['seed', '--anchor', '2026-11-26']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /gmail: created 42, already present 0/); assert.match(r.out, /drive: created 28, already present 0/); assert.match(r.out, /calendar: created 21, already present 0/);
    assert.equal(new Set(st.msgs.map((m) => m.threadId)).size, 14, '14 Gmail threads');
    r = await run(base, ['seed', '--anchor', '2026-12-10']);
    assert.match(r.out, /gmail: created 0, already present 42/); assert.match(r.out, /drive: created 0, already present 28/); assert.match(r.out, /calendar: created 0, already present 21/);
    r = await run(base, ['status']); assert.match(r.out, /"gmail":\{"present":42,"trashed":0,"duplicates":0,"of":42\},"drive":\{"present":21,"of":21,"duplicates":0\},"calendar":\{"present":21,"deleted":0,"of":21\}/);
    assert.equal((await run(base, ['cleanup'])).code, 1, 'cleanup needs --confirm');
    r = await run(base, ['cleanup', '--confirm', 'CS-GDEMO']); assert.match(r.out, /42 messages -> Gmail Trash, 28 Drive items -> Trash, 21 events deleted/);
    r = await run(base, ['status']); assert.match(r.out, /"trashed":42/); assert.match(r.out, /"drive":\{"present":0/); assert.match(r.out, /"deleted":21/);
    r = await run(base, ['seed']); assert.match(r.out, /gmail: created 0, already present 0, restored 42/); assert.match(r.out, /calendar: created 0, already present 0, restored 21/);
    // never a send / import / draft / share / ACL call
    assert.deepEqual([...st.paths].filter((x) => /send|import|draft|permission|acl|watch|settings/i.test(x)), []);
  } finally { srv.close(); }
});

test('seeder refuses to write when the token belongs to any other account', async () => {
  const { st, srv, base } = await fakeGoogle('owner.private@example.com');
  try {
    const r = await run(base, ['seed']);
    assert.equal(r.code, 1); assert.match(r.out, /IDENTITY GUARD refused \(nothing written\)/);
    assert.equal(st.writes, 1, 'only the token refresh POST, no data write'); assert.equal(st.msgs.length + st.files.length + st.events.size, 0);
  } finally { srv.close(); }
});
