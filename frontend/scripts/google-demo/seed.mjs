#!/usr/bin/env node
// RUN 06 Google demo seeder: fills ONE verified Google demo account with the CS-GDEMO dataset (dataset.mjs) through the official APIs,
// with its OWN Desktop OAuth client ("ClearSpace Demo Seeder", dev project) -- never the ClearSpace client, never ClearSpace's grant.
//   node scripts/google-demo/seed.mjs plan                      offline: validate + counts (no network, no secrets)
//   node scripts/google-demo/seed.mjs auth                      browser consent as the demo account -> identity check -> refresh token to Keychain
//   node scripts/google-demo/seed.mjs seed [--only gmail,drive,calendar] [--anchor YYYY-MM-DD]
//   node scripts/google-demo/seed.mjs status                    what of the dataset exists in the account
//   node scripts/google-demo/seed.mjs cleanup --confirm CS-GDEMO   Gmail -> Trash, Drive -> Trash, Calendar events deleted (Google keeps them 30 days)
//   node scripts/google-demo/seed.mjs revoke                    revoke the seeder grant at Google + delete the Keychain token
// Safety: every write is preceded by an identity check of the token (Google tokeninfo + Gmail profile + Drive about == the demo account from the
// Keychain); scopes must be exactly the seeder set; drive.file only sees files this tool created; Gmail messages are INSERTED (never
// sent: no SMTP, no recipient receives anything); Calendar writes use sendUpdates=none and only reserved-domain guests. Tokens are
// never printed or written to a file. Idempotent by stable keys (Gmail Message-ID, Drive appProperties, deterministic Calendar ids).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { DATASET, VERSION, TIME_ZONE, P, PROJECTS, SIGNATURE, THREADS, FILES, FOLDERS, ROOT_FOLDER, EVENTS, workday, addDays, zoned, plusMinutes } from './dataset.mjs';

export const KEYCHAIN = 'ClearSpace V1 - Google demo seeder';
const CLEARSPACE_KEYCHAIN = 'ClearSpace V1 - Google dev (live)';
export const SEED_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/calendar.events.owned'];
// Tests only: SEED_GOOGLE_BASE (loopback http) points every endpoint at a fake Google and SEED_FAKE_KEYCHAIN replaces the Keychain.
const FAKE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SEED_GOOGLE_BASE ?? '') ? process.env.SEED_GOOGLE_BASE : null;
const fakeKc = FAKE ? JSON.parse(process.env.SEED_FAKE_KEYCHAIN ?? '{}') : null;
const REAL = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me', drive: 'https://www.googleapis.com/drive/v3', upload: 'https://www.googleapis.com/upload/drive/v3', cal: 'https://www.googleapis.com/calendar/v3/calendars/primary', tokeninfo: 'https://oauth2.googleapis.com/tokeninfo' };
const G = FAKE ? Object.fromEntries(Object.entries(REAL).map(([k, v]) => [k, v.replace(/^https:\/\/[^/]+/, FAKE)])) : REAL;
const RESERVED = /@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.example)$/i;

// ------------------------------------------------------------------------------------------------ pure parts (unit-tested)
export const msgId = (key) => `<${DATASET.toLowerCase()}.${key}@corvane.example>`;
export const eventId = (key) => `csgdemo${createHash('sha256').update(`${DATASET}/${key}`).digest('hex').slice(0, 24)}`;   // base32hex subset
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const addr = (k, me) => (k === 'me' ? `${encWord('Alex Morgan')} <${me}>` : `${encWord(P[k][0])} <${P[k][1]}>`);
const b64lines = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
function rfc2822(rfc3339) {   // "2026-11-12T08:41:00+01:00" -> "Thu, 12 Nov 2026 08:41:00 +0100"
  const d = new Date(Date.parse(rfc3339.slice(0, 19) + 'Z'));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${day}, ${String(d.getUTCDate()).padStart(2, '0')} ${mon} ${d.getUTCFullYear()} ${rfc3339.slice(11, 19)} ${rfc3339.slice(19).replace(':', '')}`;
}

/** Every Gmail message of the dataset as RFC 5322 text, in thread order. `me` = the verified demo address. */
export function buildMessages(anchor, me) {
  const out = [];
  for (const t of THREADS) {
    const ids = [];
    t.messages.forEach((m, i) => {
      const key = `${t.key}m${i + 1}`;
      const date = zoned(workday(anchor, m.at[0]), m.at[1]);
      const body = m.from === 'me' ? `${m.body}\n\n${SIGNATURE}\n` : `${m.body}\n`;
      const headers = [`From: ${addr(m.from, me)}`, `To: ${m.to.map((k) => addr(k, me)).join(', ')}`, ...(m.cc?.length ? [`Cc: ${m.cc.map((k) => addr(k, me)).join(', ')}`] : []),
        `Subject: ${encWord(i ? `Re: ${t.subject}` : t.subject)}`, `Date: ${rfc2822(date)}`, `Message-ID: ${msgId(key)}`,
        ...(ids.length ? [`In-Reply-To: ${ids.at(-1)}`, `References: ${ids.join(' ')}`] : []), `X-CS-Demo: ${DATASET}/${VERSION} ${key}`, 'MIME-Version: 1.0'];
      const text = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(body.replace(/\n/g, '\r\n')))].join('\r\n');
      let raw;
      if (m.attach) {
        const bnd = `cs-gdemo-${key}`;
        raw = [...headers, `Content-Type: multipart/mixed; boundary="${bnd}"`, '', `--${bnd}`, text, `--${bnd}`,
          `Content-Type: ${m.attach.type}; charset=UTF-8; name="${m.attach.name}"`, `Content-Disposition: attachment; filename="${m.attach.name}"`, 'Content-Transfer-Encoding: base64', '',
          b64lines(Buffer.from('﻿' + m.attach.text)), `--${bnd}--`, ''].join('\r\n');
      } else raw = [...headers, text].join('\r\n');
      out.push({ key, thread: t.key, project: t.project, messageId: msgId(key), date, raw, labelIds: m.from === 'me' ? ['SENT'] : m.at[0] >= -2 ? ['INBOX', 'UNREAD'] : ['INBOX'] });
      ids.push(msgId(key));
    });
  }
  return out;
}

/** Every Calendar event body (Calendar API v3 resource), deterministic for an anchor. */
export function buildEvents(anchor) {
  return EVENTS.map((e) => {
    const base = { id: eventId(e.key), summary: e.summary, extendedProperties: { private: { csdemo: e.key, csdemoSet: DATASET } }, guestsCanInviteOthers: false,
      description: e.project ? `Projekt: ${PROJECTS[e.project]}` : undefined, location: e.location, visibility: e.visibility ?? 'default',
      attendees: e.attendees?.map((k) => ({ email: P[k][1], displayName: P[k][0] })) };
    if (e.allDay !== undefined) { const s = addDays(anchor, e.allDay); return { ...base, start: { date: s }, end: { date: addDays(s, e.days) } }; }
    let date;
    if (e.weekly) { date = anchor; while (new Date(`${date}T12:00:00Z`).getUTCDay() !== e.weekday) date = addDays(date, -1); date = addDays(date, -7); }
    else if (e.saturday) { date = anchor; let n = 0; while (true) { date = addDays(date, 1); if (new Date(`${date}T12:00:00Z`).getUTCDay() === 6 && ++n === e.saturday) break; } }
    else date = workday(anchor, e.day);
    const tz = e.timeZone ?? TIME_ZONE; const start = zoned(date, e.time, tz);
    return { ...base, start: { dateTime: start, timeZone: tz }, end: { dateTime: plusMinutes(start, e.minutes), timeZone: tz }, ...(e.weekly ? { recurrence: [`RRULE:FREQ=WEEKLY;COUNT=${e.weekly}`] } : {}) };
  });
}

/** The identity + scope guard: refuses unless EVERY source names the expected demo account and the scopes are exactly the seeder set. */
export function checkIdentity({ expected, clientId, tokenInfo, gmailEmail, driveEmail }) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const problems = [];
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(expected ?? '')) problems.push('expected demo account is not configured');
  if (tokenInfo?.aud !== clientId) problems.push('token audience is not the seeder client');
  if (String(tokenInfo?.email_verified) !== 'true') problems.push('token e-mail not verified');
  for (const [what, v] of [['tokeninfo', tokenInfo?.email], ['gmail profile', gmailEmail], ['drive about', driveEmail]]) if (norm(v) !== norm(expected)) problems.push(`${what} is not the demo account`);
  const want = new Set(SEED_SCOPES.map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)));
  const got = new Set(String(tokenInfo?.scope ?? '').split(' ').filter(Boolean).map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)));
  for (const s of got) if (!want.has(s)) problems.push(`unexpected scope ${s}`);
  for (const s of want) if (!got.has(s)) problems.push(`missing scope ${s}`);
  return problems;
}

/** Dataset invariants (also run by `plan`). */
export function validate(anchor = '2026-11-26') {
  const problems = [];
  const keys = new Set();
  const dup = (k) => { if (keys.has(k)) problems.push(`duplicate key ${k}`); keys.add(k); };
  const msgs = buildMessages(anchor, 'alex.morgan.demo@example.com');
  for (const m of msgs) dup(m.key);
  for (const f of FILES) { dup(f.key); if (!FOLDERS.includes(f.folder)) problems.push(`${f.key}: unknown folder`); if (!PROJECTS[f.project]) problems.push(`${f.key}: unknown project`); }
  for (const e of EVENTS) { dup(e.key); if (e.project && !PROJECTS[e.project]) problems.push(`${e.key}: unknown project`); }
  for (const t of THREADS) if (!PROJECTS[t.project]) problems.push(`${t.key}: unknown project`);
  for (const [k, [, email]] of Object.entries(P)) if (!RESERVED.test(email)) problems.push(`${k}: ${email} is not a reserved domain`);
  for (const m of THREADS.flatMap((t) => t.messages)) for (const k of [m.from, ...m.to, ...(m.cc ?? [])]) if (k !== 'me' && !P[k]) problems.push(`unknown person ${k}`);
  for (const m of msgs) if (Date.parse(m.date) > Date.parse(`${anchor}T23:59:59Z`)) problems.push(`${m.key}: e-mail in the future`);
  if (msgs.length < 30 || msgs.length > 50) problems.push(`gmail count ${msgs.length} not in 30-50`);
  if (FILES.length < 15 || FILES.length > 25) problems.push(`drive count ${FILES.length} not in 15-25`);
  if (EVENTS.length < 15 || EVENTS.length > 25) problems.push(`calendar count ${EVENTS.length} not in 15-25`);
  return { problems, counts: { gmail: msgs.length, threads: THREADS.length, drive: FILES.length, folders: FOLDERS.length + 1, calendar: EVENTS.length } };
}

// ------------------------------------------------------------------------------------------------ Keychain + HTTP
const kc = (account) => { if (fakeKc) return fakeKc[account] ?? ''; try { return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const kcOther = (svc, account) => { if (fakeKc) return fakeKc[`${svc}/${account}`] ?? ''; try { return execFileSync('security', ['find-generic-password', '-s', svc, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const kcPut = (account, value) => fakeKc ? (fakeKc[account] = value) : execFileSync('security', ['-i'], { input: `add-generic-password -U -s "${KEYCHAIN}" -a "${account}" -w "${value}"\n`, stdio: ['pipe', 'ignore', 'ignore'] });
const kcDel = (account) => { if (fakeKc) return delete fakeKc[account]; try { execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN, '-a', account], { stdio: 'ignore' }); return true; } catch { return false; } };

function clientConfig() {
  const clientId = kc('client_id'), clientSecret = kc('client_secret'), expected = kc('demo_account');
  if (!clientId || !clientSecret || !expected) throw new Error('missing Keychain items -- run: scripts/google-demo.sh setup');
  // separation: the seeder must never run with ClearSpace's own OAuth client (its grant would gain write scopes)
  if (clientId === kcOther(CLEARSPACE_KEYCHAIN, 'client_id')) throw new Error('refusing: the seeder client id equals the ClearSpace client id');
  return { clientId, clientSecret, expected };
}
async function req(method, url, token, { json, body, headers = {}, ok = [200] } = {}) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!ok.includes(res.status)) { const e = new Error(`${method} ${new URL(url).pathname.replace(/[^/]{30,}/g, '…')} -> ${res.status} ${data?.error?.status ?? data?.error?.message ?? data?.error ?? ''}`.slice(0, 200)); e.status = res.status; throw e; }
  return { status: res.status, data };
}

async function tokenFromRefresh(cfg) {
  const rt = kc('refresh_token');
  if (!rt) throw new Error('no seeder grant -- run: node scripts/google-demo/seed.mjs auth');
  const r = await fetch(G.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cfg.clientId, client_secret: cfg.clientSecret }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`token refresh refused: ${j.error ?? r.status}`);
  return j;
}
/** Re-verified on EVERY run before any write. */
async function verified(cfg, t) {
  const gmailEmail = (await req('GET', `${G.gmail}/profile`, t.access_token)).data.emailAddress;
  const driveEmail = (await req('GET', `${G.drive}/about?fields=user(emailAddress)`, t.access_token)).data.user?.emailAddress;
  // Google's own view of THIS access token (audience, account, scopes) -- not what the token response claims
  const tokenInfo = await (await fetch(`${G.tokeninfo}?${new URLSearchParams({ access_token: t.access_token })}`)).json();
  const problems = checkIdentity({ expected: cfg.expected, clientId: cfg.clientId, tokenInfo, gmailEmail, driveEmail });
  if (problems.length) throw new Error(`IDENTITY GUARD refused (nothing written): ${problems.join('; ')}`);
  return { token: t.access_token, me: gmailEmail };
}

// ------------------------------------------------------------------------------------------------ commands
async function auth() {
  const cfg = clientConfig();
  const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const { code, redirect } = await new Promise((resolve, reject) => {
    const srv = createServer((rq, rs) => {
      const u = new URL(rq.url, 'http://127.0.0.1');
      if (u.pathname !== '/cb') { rs.writeHead(404).end(); return; }
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<p>ClearSpace Demo Seeder: hotovo, okno můžete zavřít.</p>');
      srv.close(); clearTimeout(timer);
      if (u.searchParams.get('state') !== state) return reject(new Error('state mismatch'));
      if (!u.searchParams.get('code')) return reject(new Error(`consent not given: ${u.searchParams.get('error') ?? 'no code'}`));
      resolve({ code: u.searchParams.get('code'), redirect: `http://127.0.0.1:${srv.address()?.port ?? port}/cb` });
    });
    let port; const timer = setTimeout(() => { srv.close(); reject(new Error('timed out waiting for consent (30 min)')); }, 1_800_000);
    srv.listen(0, '127.0.0.1', () => {
      port = srv.address().port;
      const url = `${G.auth}?${new URLSearchParams({ client_id: cfg.clientId, redirect_uri: `http://127.0.0.1:${port}/cb`, response_type: 'code', scope: SEED_SCOPES.join(' '),
        state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account', login_hint: cfg.expected })}`;
      if (process.env.SEED_AUTH_URL_FILE) writeFileSync(process.env.SEED_AUTH_URL_FILE, url, { mode: 0o600 });
      console.log(`Open in the browser where the DEMO account is signed in:\n${url}\n(waiting on 127.0.0.1:${port})`);
    });
  });
  const r = await fetch(G.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirect }) });
  const t = await r.json();
  if (!r.ok) throw new Error(`code exchange refused: ${t.error ?? r.status}`);
  try { await verified(cfg, t); } catch (e) {
    await fetch(G.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }) });
    throw new Error(`${e.message} -- the grant was revoked immediately`);
  }
  if (!t.refresh_token) throw new Error('Google returned no refresh token (re-run auth)');
  kcPut('refresh_token', t.refresh_token);
  console.log(`identity guard PASS (tokeninfo + Gmail + Drive = the configured demo account); scopes = exactly the ${SEED_SCOPES.length} seeder scopes; refresh token stored in the Keychain`);
}

async function session() { const cfg = clientConfig(); return { cfg, ...(await verified(cfg, await tokenFromRefresh(cfg))) }; }
const pragueToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

async function gmailFind(token, m) {
  const r = await req('GET', `${G.gmail}/messages?${new URLSearchParams({ q: `rfc822msgid:${m.messageId.slice(1, -1)}`, includeSpamTrash: 'true', maxResults: '5' })}`, token);
  return r.data.messages ?? [];
}
async function seedGmail(token, me, anchor, stats) {
  const threadIds = {};
  for (const m of buildMessages(anchor, me)) {
    const found = await gmailFind(token, m);
    if (found.length) {
      threadIds[m.thread] ??= found[0].threadId;
      const full = (await req('GET', `${G.gmail}/messages/${found[0].id}?format=minimal`, token)).data;
      if (full.labelIds?.includes('TRASH')) { await req('POST', `${G.gmail}/messages/${found[0].id}/untrash`, token); stats.restored++; } else stats.kept++;
      continue;
    }
    const r = await req('POST', `${G.gmail}/messages?internalDateSource=dateHeader`, token, { json: { raw: Buffer.from(m.raw).toString('base64url'), labelIds: m.labelIds, ...(threadIds[m.thread] ? { threadId: threadIds[m.thread] } : {}) } });
    threadIds[m.thread] ??= r.data.threadId; stats.created++;
  }
}
const driveQ = (key) => `appProperties has { key='csdemo' and value='${key}' } and trashed=false`;
async function driveFind(token, key) { return (await req('GET', `${G.drive}/files?${new URLSearchParams({ q: driveQ(key), fields: 'files(id,name)', spaces: 'drive' })}`, token)).data.files ?? []; }
async function folder(token, name, parent, stats) {
  const key = `folder:${name}`;
  const f = await driveFind(token, key); if (f.length) { stats.kept++; return f[0].id; }
  const r = await req('POST', `${G.drive}/files?fields=id`, token, { json: { name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}), appProperties: { csdemo: key, csdemoSet: DATASET } } });
  stats.created++; return r.data.id;
}
async function seedDrive(token, stats) {
  const root = await folder(token, ROOT_FOLDER, null, stats);
  const ids = {}; for (const n of FOLDERS) ids[n] = await folder(token, n, root, stats);
  for (const f of FILES) {
    if ((await driveFind(token, f.key)).length) { stats.kept++; continue; }
    const meta = { name: f.name, parents: [ids[f.folder]], mimeType: f.kind === 'doc' ? 'application/vnd.google-apps.document' : 'application/vnd.google-apps.spreadsheet', appProperties: { csdemo: f.key, csdemoSet: DATASET, project: f.project } };
    const bnd = `cs${randomBytes(8).toString('hex')}`;
    const media = f.kind === 'doc' ? { type: 'text/html; charset=UTF-8', body: `<html><head><meta charset="utf-8"></head><body>${f.html}</body></html>` } : { type: 'text/csv; charset=UTF-8', body: f.csv };
    const body = `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${bnd}\r\nContent-Type: ${media.type}\r\n\r\n${media.body}\r\n--${bnd}--\r\n`;
    await req('POST', `${G.upload}/files?uploadType=multipart&fields=id`, token, { body, headers: { 'Content-Type': `multipart/related; boundary=${bnd}` } });
    stats.created++;
  }
}
async function seedCalendar(token, anchor, stats) {
  for (const ev of buildEvents(anchor)) {
    const r = await req('POST', `${G.cal}/events?sendUpdates=none`, token, { json: ev, ok: [200, 409] });
    if (r.status === 200) { stats.created++; continue; }
    const cur = (await req('GET', `${G.cal}/events/${ev.id}`, token)).data;
    if (cur.status === 'cancelled') { await req('PUT', `${G.cal}/events/${ev.id}?sendUpdates=none`, token, { json: { ...ev, status: 'confirmed' } }); stats.restored++; } else stats.kept++;
  }
}

async function status() {
  const { token, me } = await session();
  let gm = 0, gt = 0, gd = 0; for (const m of buildMessages(pragueToday(), me)) { const f = await gmailFind(token, m); if (f.length > 1) gd++; if (f.length) { const x = (await req('GET', `${G.gmail}/messages/${f[0].id}?format=minimal`, token)).data; x.labelIds?.includes('TRASH') ? gt++ : gm++; } }
  let df = 0, dd = 0; for (const key of [...FILES.map((f) => f.key), ...FOLDERS.map((n) => `folder:${n}`), `folder:${ROOT_FOLDER}`]) { const n = (await driveFind(token, key)).length; if (n && !key.startsWith('folder:')) df++; if (n > 1) dd++; }
  let ce = 0, cc = 0; for (const e of EVENTS) { const r = await req('GET', `${G.cal}/events/${eventId(e.key)}`, token, { ok: [200, 404, 410] }); if (r.status === 200) (r.data.status === 'cancelled' ? cc++ : ce++); }
  console.log(JSON.stringify({ dataset: `${DATASET}@${VERSION}`, gmail: { present: gm, trashed: gt, duplicates: gd, of: buildMessages(pragueToday(), me).length }, drive: { present: df, of: FILES.length, duplicates: dd }, calendar: { present: ce, deleted: cc, of: EVENTS.length } }));
}

async function cleanup() {
  const { token, me } = await session();
  const s = { gmail: 0, drive: 0, calendar: 0 };
  for (const m of buildMessages(pragueToday(), me)) for (const f of await gmailFind(token, m)) { await req('POST', `${G.gmail}/messages/${f.id}/trash`, token); s.gmail++; }
  for (const key of [...FILES.map((f) => f.key), ...FOLDERS.map((n) => `folder:${n}`), `folder:${ROOT_FOLDER}`]) for (const f of await driveFind(token, key)) { await req('PATCH', `${G.drive}/files/${f.id}?fields=id`, token, { json: { trashed: true } }); s.drive++; }
  for (const e of EVENTS) { const r = await req('DELETE', `${G.cal}/events/${eventId(e.key)}?sendUpdates=none`, token, { ok: [204, 404, 410] }); if (r.status === 204) s.calendar++; }
  console.log(`cleanup: ${s.gmail} messages -> Gmail Trash, ${s.drive} Drive items -> Trash, ${s.calendar} events deleted (all recoverable for ~30 days)`);
}

async function revoke() {
  const rt = kc('refresh_token');
  if (rt) { const r = await fetch(G.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: rt }) }); console.log(`revoke at Google -> ${r.status}`); }
  console.log(kcDel('refresh_token') ? 'Keychain refresh token deleted' : 'no Keychain refresh token');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const anchor = opt('anchor') ?? pragueToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('--anchor YYYY-MM-DD');
  if (cmd === 'plan') { const v = validate(anchor); console.log(JSON.stringify({ dataset: `${DATASET}@${VERSION}`, anchor, ...v.counts, problems: v.problems })); process.exit(v.problems.length ? 1 : 0); }
  if (cmd === 'auth') return auth();
  if (cmd === 'status') return status();
  if (cmd === 'revoke') return revoke();
  if (cmd === 'cleanup') { if (opt('confirm') !== DATASET) throw new Error(`cleanup needs --confirm ${DATASET}`); return cleanup(); }
  if (cmd === 'seed') {
    const v = validate(anchor); if (v.problems.length) throw new Error(`dataset invalid: ${v.problems.join('; ')}`);
    const only = new Set((opt('only') ?? 'gmail,drive,calendar').split(','));
    const { token, me } = await session();
    console.log(`identity guard PASS; anchor ${anchor}; writing ${[...only].join(', ')}`);
    for (const [svc, fn] of [['gmail', (s) => seedGmail(token, me, anchor, s)], ['drive', (s) => seedDrive(token, s)], ['calendar', (s) => seedCalendar(token, anchor, s)]]) {
      if (!only.has(svc)) continue;
      const s = { created: 0, kept: 0, restored: 0 }; await fn(s); console.log(`${svc}: created ${s.created}, already present ${s.kept}, restored ${s.restored}`);
    }
    return;
  }
  console.error('usage: seed.mjs plan|auth|seed|status|cleanup --confirm CS-GDEMO|revoke'); process.exit(2);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
