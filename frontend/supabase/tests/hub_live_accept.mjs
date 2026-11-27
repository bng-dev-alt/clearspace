// RUN 08 LIVE acceptance driver (isolated local stack, REAL Slack + Telegram providers, synthetic ClearSpace users bob / vera / alice).
// Every check says how it was verified:
//   [LIVE]       real provider: the message is read back from Slack (bot's conversations.history) / Telegram accepted it (ok) / the event came FROM Slack
//   [LIVE-DB]    real scheduler (pg_cron -> pg_net -> app -> provider) result recorded in the database
//   [SIMULATED]  an event WE signed and sent through the real public tunnel (provider behaviour not involved)
// Never prints a token, id of a person or chat; prints only test-channel message texts written by this run.
//   eval "$(scripts/hub-stack.sh env)"; node supabase/tests/hub_live_accept.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL, ANON = process.env.E2E_SUPABASE_ANON_KEY;
const DIR = process.env.NOTIFY_STACK_DIR || `${process.env.TMPDIR}/cs-notify-sb`;
const acc = (k) => (readFileSync(`${DIR}/collab-accounts.env`, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const PUBLIC = process.env.HUB_PUBLIC_URL || 'https://cs-hub-live.luffast.com';
const P = 'project-collab-demo', TAG = `R08-${Date.now().toString(36).slice(-5)}`;
const SIGNING = execFileSync('security', ['find-generic-password', '-s', 'ClearSpace V1 - Hub dev (live)', '-a', 'slack_hub_signing_secret', '-w'], { encoding: 'utf8' }).trim();
let pass = 0, fail = 0;
const results = [];
const ok = (cond, label, msg) => { (cond ? pass++ : fail++); results.push(`${cond ? 'PASS' : 'FAIL'} ${label} ${msg}`); console.log(`${cond ? 'PASS' : 'FAIL'} ${label} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', 'supabase_db_cs-notify-sb', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' }).trim();
const probe = (...a) => execFileSync('node', ['scripts/hub-live-probe.mjs', ...a], { encoding: 'utf8' }).trim();
const history = () => probe('slack-history', '40').split('\n').map((l) => { const s = l.replace(/^\s*↳ /, ''); try { return { ...JSON.parse(s), reply: l.trimStart().startsWith('↳') }; } catch { return null; } }).filter(Boolean);
async function login(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: acc('COLLAB_PASSWORD') }) });
  const j = await r.json(); assert.ok(j.access_token, `login ${email}`); return { id: j.user.id, token: j.access_token };
}
const rest = (u, path, method = 'GET', body) => fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, 'content-type': 'application/json', Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
async function until(fn, ms = 240_000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(5000); } }
const slackSigned = (raw) => { const ts = String(Math.floor(Date.now() / 1000)); return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${raw}`).digest('hex')}` }; };

const alice = await login('alice@collab.test'), bob = await login('bob@collab.test'), vera = await login('vera@collab.test');
const dest = sql(`select id from public.hub_destinations where project_id = '${P}' and provider = 'slack' and label = '#clearspace_test' and status = 'active'`);
assert.ok(dest, 'the live Slack destination must be active');
console.log(`run tag ${TAG}; scheduler jobs: ${sql(`select string_agg(jobname, ',') from cron.job where active`)}`);

// ---------- 1. project notifications through the REAL scheduler: task created by bob, then completed (digest per destination per minute)
const card = `${P}-${TAG.toLowerCase()}`;
assert.ok((await rest(bob, 'cards', 'POST', { id: card, column_id: `${P}-column-1`, title: `${TAG} Ověřit doručení plánovačem` })).status < 300, 'bob creates a card');
// ---------- 2. personal notifications (RUN 05): bob assigns alice + due date tomorrow (assignment + due_soon -> alice's real Slack DM + Telegram chat)
const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date(Date.now() + 86_400_000));
assert.ok((await rest(bob, 'card_assignees', 'POST', { card_id: card, member_id: `member-owner-${alice.id}` })).status < 300, 'bob assigns alice');
assert.ok((await rest(bob, `cards?id=eq.${card}`, 'PATCH', { due_date: tomorrow })).status < 300, 'bob sets a due date');
const created = await until(async () => history().some((m) => m.by === 'bot' && m.text.includes(`${TAG} Ověřit doručení plánovačem`)) && history().find((m) => m.text.includes(TAG)));
ok(Boolean(created), '[LIVE]', `1a. "task created" by the scheduler appeared in Slack #clearspace_test (read back via Slack API)${created ? `: ${JSON.stringify(created.text.split('\n')[0])}` : ''}`);
ok(await until(async () => sql(`select count(*) from public.hub_outbox where destination_id = '${dest}' and card_id = '${card}' and kind = 'task_created' and status = 'sent'`) === '1', 90_000), '[LIVE-DB]', '1b. outbox item marked sent by the scheduler (pg_cron -> pg_net -> app -> Slack -> result applied)');
assert.ok((await rest(bob, `cards?id=eq.${card}`, 'PATCH', { column_id: `${P}-column-4` })).status < 300, 'bob completes the card');
const done = await until(async () => history().some((m) => m.by === 'bot' && /dokončil\(a\) úkol/.test(m.text) && m.text.includes(TAG)));
ok(Boolean(done), '[LIVE]', '1c. "task completed" delivered to Slack by the scheduler');
ok(await until(async () => sql(`select string_agg(status, ',') from public.hub_outbox where destination_id = '${dest}' and card_id = '${card}' and kind = 'due_soon'`) === 'sent', 120_000), '[LIVE-DB]', '1d. due-date reminder (due tomorrow, window from 09:00 the day before) delivered to the project channel');
ok(sql(`select count(*) from public.hub_outbox where destination_id = '${dest}' and card_id = '${card}' and kind = 'due_soon'`) === '1', '[LIVE-DB]', '1e. exactly one reminder per task and due date (dedupe across scheduler runs)');

// personal deliveries for alice
const pers = await until(async () => {
  const r = sql(`select string_agg(c.provider || ':' || d.kind || ':' || d.status, ',' order by c.provider, d.kind) from public.notification_deliveries d join public.notification_channels c on c.id = d.channel_id
                  where d.card_id = '${card}' and d.user_id = '${alice.id}'`);
  return r && !/pending|sending/.test(r) ? r : null;
});
ok(Boolean(pers) && /slack:assignment:sent/.test(pers) && /telegram:assignment:sent/.test(pers), '[LIVE]', `2a. personal "assigned to you" accepted by Slack (DM) and Telegram (ok:true): ${pers}`);
ok(Boolean(pers) && !/failed|cancelled.*assignment/.test(pers ?? ''), '[LIVE-DB]', '2b. no failed personal deliveries');

// ---------- 3. ClearSpace -> Slack thread: comment by alice on the task created from Slack by the owner (real thread post)
const slackTask = sql(`select card_id from public.hub_messages where project_id = '${P}' and kind = 'task_source' and provider = 'slack' order by created_at limit 1`);
const cid = `cm-${TAG.toLowerCase()}`;
assert.ok((await rest(alice, 'task_comments', 'POST', { id: cid, card_id: slackTask, author_name: 'x', content: `${TAG} Komentář z ClearSpace do vlákna (test RUN 08) <!channel> & <@U000>` })).status < 300, 'alice comments');
const inThread = await until(async () => history().find((m) => m.reply && m.by === 'bot' && m.text.includes(`${TAG} Komentář z ClearSpace`)));
ok(Boolean(inThread), '[LIVE]', '3a. ClearSpace comment appeared as a reply in the Slack thread of its task');
ok(Boolean(inThread) && !inThread.text.includes('<!channel>') && inThread.text.includes('&lt;!channel&gt;'), '[LIVE]', '3b. mention syntax arrived escaped (no @channel ping)');
ok(await until(async () => sql(`select direction from public.hub_comment_links where comment_id = '${cid}'`) === 'outbound', 90_000), '[LIVE-DB]', '3c. comment linked as outbound (loop guard)');
await sleep(15000);   // Slack sends the bot's own reply back as a REAL event -> must be ignored
ok(sql(`select count(*) from public.task_comments where card_id = '${slackTask}' and content like '%${TAG} Komentář z ClearSpace%'`) === '1', '[LIVE]', '3d. the real Slack event for our own reply was ignored (no echo comment)');
const evs = sql(`select count(*) || ':' || count(*) filter (where status = 'completed') from public.hub_inbox where provider = 'slack' and received_at > now() - interval '10 minutes'`);
ok(/^[1-9][0-9]*:/.test(evs) && evs.split(':')[0] === evs.split(':')[1], '[LIVE]', `3e. real Slack events received through the tunnel and processed (received:completed = ${evs})`);

// ---------- 4. the app itself posts into the channel (real Slack message.channels event with bot_id) -> never stored, never a task/comment
const before = sql(`select count(*) from public.hub_messages where project_id = '${P}'`);
probe('slack-post-as-bot', `${TAG} zpráva samotné aplikace – nesmí se uložit`);
await sleep(15000);
ok(sql(`select count(*) from public.hub_messages where project_id = '${P}'`) === before, '[LIVE]', '4. a real message by the app in the channel is not ingested (loop / bot filter)');

// ---------- 5. dedupe + forged events through the real tunnel [SIMULATED provider events]
const thread = sql(`select thread_ref from public.hub_conversations c where card_id = '${slackTask}' limit 1`);
const teamChan = JSON.parse(execFileSync('node', ['-e', `
  const {createDecipheriv,createHash}=require('crypto');const fs=require('fs');
  const acc=k=>(fs.readFileSync(process.env.D+'/collab-accounts.env','utf8').match(new RegExp('^'+k+'=(.*)$','m'))||[])[1];
  const raw=Buffer.from(acc('HUB_TOKEN_ENCRYPTION_KEY'),'base64');const env=process.env.E;const m=/^v1\\.([0-9a-f]{8})\\.([^.]+)\\.([^.]+)\\.([^.]+)$/.exec(env);
  const d=createDecipheriv('aes-256-gcm',raw,Buffer.from(m[2],'base64url'));d.setAAD(Buffer.from('clearspace:hub:destination:'+process.env.I));d.setAuthTag(Buffer.from(m[4],'base64url'));
  process.stdout.write(Buffer.concat([d.update(Buffer.from(m[3],'base64url')),d.final()]).toString())`], { encoding: 'utf8',
  env: { ...process.env, D: DIR, I: dest, E: sql(`select ext_ref_enc from public.hub_destinations where id = '${dest}'`) } }));
const ownerUser = 'U0SIMULATED';   // a NON-linked user id: an external author
const ev = (id, text, user = ownerUser) => JSON.stringify({ type: 'event_callback', team_id: teamChan.teamId, event_id: id,
  event: { type: 'message', channel: teamChan.channelId, user, ts: `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1e6).padStart(6, '0')}`, thread_ts: thread, text } });
const EVT = TAG.replace(/[^A-Za-z0-9]/g, '');
const raw1 = ev(`Ev${EVT}A`, `${TAG} simulovaná odpověď externího autora`);
const r1 = await fetch(`${PUBLIC}/api/hub/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...slackSigned(raw1) }, body: raw1 });
const r2 = await fetch(`${PUBLIC}/api/hub/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...slackSigned(raw1) }, body: raw1 });
await sleep(4000);
ok(r1.status === 200 && r2.status === 200 && sql(`select count(*) from public.hub_messages where text like '${TAG} simulovaná odpověď%'`) === '1', '[SIMULATED]', '5a. the same Slack event delivered twice through the tunnel -> one record');
ok(sql(`select verified::text || ':' || (author_user_id is null)::text from public.hub_messages where text like '${TAG} simulovaná odpověď%'`) === 'false:true', '[SIMULATED]', '5b. a non-linked author is recorded as unverified and creates no comment');
const forged = await fetch(`${PUBLIC}/api/hub/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': `v0=${'0'.repeat(64)}` }, body: ev(`Ev${EVT}F`, 'forged') });
ok(forged.status === 401, '[SIMULATED]', '5c. forged signature through the tunnel -> 401');

// ---------- 6. isolation + permissions (real app API, real DB rules)
const other = `p-r08-${TAG.toLowerCase()}`;
assert.ok((await rest(bob, 'projects', 'POST', { id: other, name: `${TAG} Jiný projekt (Bob)` })).status < 300);
await rest(bob, 'columns', 'POST', { id: `${other}-a`, project_id: other, name: 'A', position: 0 });
await rest(bob, 'project_members', 'POST', { project_id: other, member_id: `member-owner-${bob.id}` });
await rest(bob, 'cards', 'POST', { id: `${other}-k`, column_id: `${other}-a`, title: `${TAG} úkol jiného projektu` });
await sleep(75000);
ok(!history().some((m) => m.text.includes(`${TAG} úkol jiného projektu`)), '[LIVE]', '6a. a task of another project never reaches the linked Slack channel');
const appUrl = 'http://127.0.0.1:3471';
const vr = await fetch(`${appUrl}/api/hub/projects/${P}`, { method: 'POST', headers: { Authorization: `Bearer ${vera.token}`, 'content-type': 'application/json' }, body: '{"provider":"slack"}' });
const br = await fetch(`${appUrl}/api/hub/destinations/${dest}`, { method: 'PATCH', headers: { Authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: '{"notify":false,"interactive":false,"intelligence":false,"eventTypes":[]}' });
ok(vr.status === 403 && br.status === 403, '[LIVE-DB]', `6b. viewer cannot create a link code (${vr.status}), editor cannot change the destination (${br.status})`);

console.log(`\nLIVE ACCEPTANCE (this driver): ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
