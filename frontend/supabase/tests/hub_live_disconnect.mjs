// RUN 08 LIVE: Project Intelligence kill switch, disconnect -> reconnect, and (with --revoke, LAST) a REAL Slack token revocation.
// Same labels as hub_live_accept.mjs: [LIVE] real provider, [LIVE-DB] real scheduler/DB rules, [SIMULATED] an event WE signed and sent
// through the real public tunnel. Never prints a token, a person's id or a chat id.
//   eval "$(scripts/hub-stack.sh env)"; node supabase/tests/hub_live_disconnect.mjs [--revoke]
// After --revoke the project Slack app must be installed again (ClearSpace -> Nastavení -> Slack pro projekty) before further live tests.
import assert from 'node:assert/strict';
import { createDecipheriv, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL, ANON = process.env.E2E_SUPABASE_ANON_KEY, APP = process.env.HUB_APP_URL || 'http://127.0.0.1:3471';
const DIR = process.env.NOTIFY_STACK_DIR || `${process.env.TMPDIR}/cs-notify-sb`;
const acc = (k) => (readFileSync(`${DIR}/collab-accounts.env`, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const PUBLIC = process.env.HUB_PUBLIC_URL || 'https://cs-hub-live.luffast.com';
const P = 'project-collab-demo', TAG = `R08D-${Date.now().toString(36).slice(-5)}`, REVOKE = process.argv.includes('--revoke');
const SIGNING = execFileSync('security', ['find-generic-password', '-s', 'ClearSpace V1 - Hub dev (live)', '-a', 'slack_hub_signing_secret', '-w'], { encoding: 'utf8' }).trim();
let pass = 0, fail = 0;
const ok = (c, label, msg) => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'} ${label} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', 'supabase_db_cs-notify-sb', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' }).trim();
async function until(fn, ms = 150_000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(5000); } }
async function login(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: acc('COLLAB_PASSWORD') }) });
  const j = await r.json(); assert.ok(j.access_token, `login ${email}`); return { id: j.user.id, token: j.access_token };
}
const rest = (u, path, method = 'GET', body) => fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${u.token}`, 'content-type': 'application/json', Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
const api = async (u, path, method = 'GET', body) => { const r = await fetch(`${APP}${path}`, { method, headers: { Authorization: `Bearer ${u.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const open = (env, aad) => {
  const raw = Buffer.from(acc('HUB_TOKEN_ENCRYPTION_KEY'), 'base64'), m = /^v1\.([0-9a-f]{8})\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(env);
  const d = createDecipheriv('aes-256-gcm', raw, Buffer.from(m[2], 'base64url')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(m[4], 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString());
};
const signed = (raw) => { const ts = String(Math.floor(Date.now() / 1000)); return { 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${raw}`).digest('hex')}` }; };
const ALL = ['task_created', 'task_completed', 'status_changed', 'due_soon'];
const caps = { notify: true, interactive: true, intelligence: false, intelligenceAck: false, fullIngest: false, eventTypes: ALL };

const alice = await login('alice@collab.test'), bob = await login('bob@collab.test');
// the project app's own token (from the real installation, not from a destination: the channel gets disconnected on the way)
const [instId, secEnc] = sql(`select id, secret_enc from public.hub_slack_installations where status = 'active' and team_label not like '%(simulace)%' limit 1`).split('\t');
assert.ok(secEnc, 'the real Slack installation must be active');
const { botToken } = open(secEnc, `clearspace:hub:installation:${instId}`);
const slack = async (method, params = {}, post = false) => (await fetch(`https://slack.com/api/${method}${post ? '' : `?${new URLSearchParams(params)}`}`, post
  ? { method: 'POST', headers: { Authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) }
  : { headers: { Authorization: `Bearer ${botToken}` } })).json();
const teamId = (await slack('auth.test')).team_id;
const dest = sql(`select id from public.hub_destinations where project_id = '${P}' and provider = 'slack' and label = '#clearspace_test' and status = 'active'`);
// resume after a disconnect: the channel id is in the permalinks of real Slack messages stored earlier
const channelId = dest ? open(sql(`select ext_ref_enc from public.hub_destinations where id = '${dest}'`), `clearspace:hub:destination:${dest}`).channelId
  : sql(`select substring(permalink from '/archives/([A-Z0-9]+)/') from public.hub_messages where provider = 'slack' and permalink like 'https://%slack.com/archives/%' order by created_at desc limit 1`);
assert.ok(teamId && channelId, 'team + channel');
const history = async () => { const h = await slack('conversations.history', { channel: channelId, limit: 30 }); assert.ok(h.ok, `history: ${h.error}`); return h.messages.map((m) => ({ by: m.bot_id ? 'bot' : 'human', ts: m.ts, text: m.text })).reverse(); };
console.log(`run tag ${TAG}${REVOKE ? ' (with REAL revocation at the end)' : ''}${dest ? '' : ' – resuming after the disconnect'}`);

if (dest) {
// ---------- 7. Project Intelligence is switched off on this server (pilot rule): an owner cannot turn it on for the channel
const pi = await api(alice, `/api/hub/destinations/${dest}`, 'PATCH', { ...caps, intelligence: true, intelligenceAck: true });
ok(pi.status >= 400 && sql(`select intelligence::text from public.hub_destinations where id = '${dest}'`) === 'false', '[LIVE-DB]', `7. PI off on the server: switching it on for the channel is refused (${pi.status}) and nothing changes`);

// ---------- 8. disconnect: the binding goes at once, nothing more reaches the channel
const del = await api(alice, `/api/hub/destinations/${dest}`, 'DELETE');
ok(del.status === 200 && del.j.removed === true && sql(`select count(*) from public.hub_destinations where id = '${dest}'`) === '0', '[LIVE-DB]', '8a. owner disconnects the channel in ClearSpace -> binding removed');
const card = `${P}-${TAG.toLowerCase()}`;
assert.ok((await rest(bob, 'cards', 'POST', { id: card, column_id: `${P}-column-1`, title: `${TAG} po odpojení` })).status < 300);
await sleep(130_000);   // two scheduler runs
ok(sql(`select count(*) from public.hub_outbox where card_id = '${card}'`) === '0' && !(await history()).some((m) => m.text.includes(`${TAG} po odpojení`)), '[LIVE]', '8b. after disconnect: no outbox item and nothing in the Slack channel (read back) for a new task');
} else {
  // resumed: check the task the interrupted run created right after its disconnect (several scheduler runs have passed since)
  const prev = sql(`select id || '\t' || title from public.cards where title like 'R08D-% po odpojení' and created_at > now() - interval '2 hours' order by created_at desc limit 1`).split('\t');
  assert.ok(prev[1], 'the interrupted run created its task');
  ok(sql(`select count(*) from public.hub_outbox where card_id = '${prev[0]}'`) === '0' && !(await history()).some((m) => m.text.includes(prev[1])), '[LIVE]', '8b. after disconnect: no outbox item and nothing in the Slack channel (read back) for the task created after it');
}

// ---------- 9. reconnect with a fresh code: the code typed in the channel [SIMULATED slash command via the real tunnel], confirmed in ClearSpace
const code = await api(alice, `/api/hub/projects/${P}`, 'POST', { provider: 'slack' });
assert.equal(code.status, 200);
ok(code.j.command === `/clearspace propojit ${code.j.code}` && code.j.expiresInSeconds === 600 && code.j.openUrl === 'slack://open', '[LIVE-DB]', '9a. link code comes with the exact command to paste, its validity and an "open Slack" link');
const form = new URLSearchParams({ team_id: teamId, channel_id: channelId, user_id: 'U0RUN08DRV', user_name: 'run08-driver', channel_name: 'clearspace_test', team_domain: 'test', command: '/clearspace', text: `propojit ${code.j.code}` }).toString();
const cmd = await fetch(`${PUBLIC}/api/hub/slack/commands`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(form) }, body: form });
const cmdText = (await cmd.json().catch(() => ({}))).text ?? '';
ok(cmd.status === 200 && cmdText.includes('čeká na potvrzení'), '[SIMULATED]', '9b. "/clearspace propojit KÓD" through the tunnel -> channel waits for confirmation');
const replay = await fetch(`${PUBLIC}/api/hub/slack/commands`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(form) }, body: form });
const other = new URLSearchParams({ team_id: teamId, channel_id: 'C0RUN08OTHER', user_id: 'U0RUN08DRV', user_name: 'run08-driver', channel_name: 'jiny-kanal', team_domain: 'test', command: '/clearspace', text: `propojit ${code.j.code}` }).toString();
const elsewhere = await fetch(`${PUBLIC}/api/hub/slack/commands`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(other) }, body: other });
ok(replay.status === 200 && sql(`select count(*) from public.hub_destinations where project_id = '${P}' and provider = 'slack' and label = '#clearspace_test'`) === '1'
  && !((await elsewhere.json().catch(() => ({}))).text ?? '').includes('čeká na potvrzení') && sql(`select count(*) from public.hub_destinations where label = '#jiny-kanal'`) === '0',
  '[SIMULATED]', '9c. code is single-use: a provider retry from the same channel creates nothing new, the same code from another channel is refused');
const nd = sql(`select id from public.hub_destinations where project_id = '${P}' and provider = 'slack' and label = '#clearspace_test' and status = 'pending'`);
assert.ok(nd, 'pending destination');
const conf = await api(alice, `/api/hub/destinations/${nd}`, 'PATCH', { decision: 'confirm' });
const cfg = await api(alice, `/api/hub/destinations/${nd}`, 'PATCH', caps);
ok(conf.status === 200 && cfg.status === 200 && sql(`select status || ':' || interactive from public.hub_destinations where id = '${nd}'`) === 'active:true', '[LIVE-DB]', '9d. owner confirms in ClearSpace -> active again, tasks from chat on');
const t = await api(alice, `/api/hub/destinations/${nd}`, 'POST');
await sleep(3000);
const testMsg = (await history()).filter((m) => m.by === 'bot').at(-1);
ok(t.j.outcome === 'sent' && Boolean(testMsg) && /^Společný projekt: zkušební zpráva/.test(testMsg.text), '[LIVE]', `9e. test message after reconnect read back from Slack: ${JSON.stringify(testMsg?.text ?? '')}`);
const again = await api(alice, `/api/hub/destinations/${nd}`, 'POST');
ok(again.status === 429 || again.status >= 400, '[LIVE-DB]', `9f. a second test within 30 s is refused (${again.status}) – no duplicate test messages`);

// ---------- 10. REAL revocation (only with --revoke; it cuts the installation off, a reinstall is needed afterwards)
if (REVOKE) {
  const inst = sql(`select installation_id from public.hub_destinations where id = '${nd}'`);
  const before = Number(sql(`select count(*) from public.hub_inbox where provider = 'slack'`));
  const rv = await slack('auth.revoke', {}, true);
  ok(rv.ok === true && rv.revoked === true, '[LIVE]', '10a. Slack auth.revoke of the project app token accepted by Slack');
  const cut = await until(async () => sql(`select i.status || ':' || d.status from public.hub_slack_installations i join public.hub_destinations d on d.installation_id = i.id where d.id = '${nd}'`) === 'revoked:revoked');
  ok(Boolean(cut), '[LIVE]', `10b. Slack's own tokens_revoked event arrived through the tunnel -> installation and channel cut off (new inbound events: ${Number(sql(`select count(*) from public.hub_inbox where provider = 'slack'`)) - before})`);
  ok(sql(`select count(*) from public.hub_slack_installations where id = '${inst}' and status = 'active'`) === '0', '[LIVE-DB]', '10c. the revoked installation is no longer active');
  const card2 = `${P}-${TAG.toLowerCase()}-r`;
  assert.ok((await rest(bob, 'cards', 'POST', { id: card2, column_id: `${P}-column-1`, title: `${TAG} po zrušení přístupu` })).status < 300);
  await sleep(130_000);
  ok(sql(`select count(*) from public.hub_outbox where card_id = '${card2}' and status = 'sent'`) === '0', '[LIVE-DB]', '10d. after revocation nothing is sent (no outbox item delivered)');
  const t2 = await api(alice, `/api/hub/destinations/${nd}`, 'POST');
  // the database already knows the installation is revoked -> refused before any provider call, with the reinstall hint
  ok(t2.status === 400 && /Nainstalujte Slack aplikaci znovu/.test(t2.j.message ?? ''), '[LIVE-DB]', `10e. test after revocation refused without calling Slack; the owner sees "${t2.j.message ?? t2.status}"`);
}

console.log(`\nLIVE DISCONNECT/REVOKE (this driver): ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
