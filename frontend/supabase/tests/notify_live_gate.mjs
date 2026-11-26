// RUN 05 LIVE gate -- REAL Slack + Telegram (the owner's DEV app / DEV bot), local stack cs-notify-sb. Prints only codes, counts, booleans:
// never a token, chat id, Slack id or message text. Run through scripts/notify-live.sh (credentials from the Keychain).
//
//   notify-live.sh gate           -> per connected channel of the DEV-login owner (alice@collab.test):
//        Slack: auth.test OK for the stored bot token, token belongs to the same workspace as stored (HMAC), the stored user id is a
//               member of that workspace; the bot token has NO scope beyond chat:write (x-oauth-scopes header); the PRODUCT path
//               (scheduler tick -> /api/notify/dispatch -> chat.postMessage) delivers a gate message (ok:true)
//        Telegram: getMe OK (the configured bot), webhook NOT set (getUpdates mode), the product path delivers a gate message
//   notify-live.sh revoke-check   -> after "Odpojit" in the app: the last Slack bot token seen by this gate is dead AT SLACK (auth.test
//        invalid_auth / token_revoked) and no channel row remains; Telegram: no channel row remains
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const DBC = 'supabase_db_cs-notify-sb';
const KEY = Buffer.from((process.env.NOTIFY_TOKEN_ENCRYPTION_KEY ?? '').trim(), 'base64');
const SECRET = process.env.NOTIFY_SERVER_SECRET ?? '';
const STATE = `${process.env.TMPDIR ?? '/tmp'}/cs-notify-live-state.json`;   // mode 600; holds only a SHA-256 of the last token + the envelope
if (KEY.length !== 32 || SECRET.length < 32) { console.error('missing NOTIFY_* (run through notify-live.sh)'); process.exit(2); }
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', DBC, 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-q', '-F', '|', '-c', q], { encoding: 'utf8' }).trim();
const open = (env, aad) => {
  const m = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(env);
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(m[2], 'base64url'));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(m[4], 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString());
};
let passed = 0;
const ok = (m) => { passed++; console.log(`ok - ${m}`); };
const slack = async (method, token, body) => {
  const r = await fetch(`https://slack.com/api/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body ?? {}) });
  return { json: await r.json(), scopes: r.headers.get('x-oauth-scopes') };
};
const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, json: await r.json() };
};
const owner = sql(`select id from auth.users where email = 'alice@collab.test'`);
const channels = () => sql(`select id, provider, status, coalesce(secret_enc, ''), coalesce(team_hmac, '') from public.notification_channels where user_id = '${owner}'`)
  .split('\n').filter(Boolean).map((l) => { const [id, provider, status, env, team] = l.split('|'); return { id, provider, status, env, team }; });

if (process.argv[2] === 'revoke-check') {
  assert.ok(existsSync(STATE), 'run the gate before disconnecting');
  const st = JSON.parse(readFileSync(STATE, 'utf8'));
  assert.equal(channels().length, 0, 'no channel row remains for the owner');
  ok('no channel row remains after "Odpojit" (credentials deleted)');
  if (st.slackEnv) {
    const tok = open(st.slackEnv, `clearspace:notify:slack:${st.slackChannel}`).botToken;
    assert.equal(createHash('sha256').update(tok).digest('hex'), st.slackTokenSha);
    const r = await slack('auth.test', tok);
    assert.equal(r.json.ok, false); assert.ok(['invalid_auth', 'token_revoked', 'account_inactive'].includes(r.json.error), r.json.error);
    ok(`the disconnected Slack bot token is dead AT SLACK (auth.test -> ${r.json.error})`);
  }
  writeFileSync(STATE, '{}', { mode: 0o600 });
  console.log(`\nLIVE revoke-check: ${passed} checks passed`);
  process.exit(0);
}

const chs = channels().filter((c) => c.status === 'active');
assert.ok(chs.length > 0, 'connect Slack and/or Telegram in the app first (https://localhost:3472/settings?login=auto)');
const state = {};
for (const c of chs) {
  if (c.provider === 'slack') {
    const s = open(c.env, `clearspace:notify:slack:${c.id}`);
    const a = await slack('auth.test', s.botToken);
    assert.equal(a.json.ok, true, `auth.test: ${a.json.error}`);
    assert.equal(createHmac('sha256', SECRET).update(`slack-team:${a.json.team_id}`).digest('hex'), c.team, 'token workspace == stored workspace HMAC');
    const scopes = (a.scopes ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(scopes, ['chat:write'], `bot token scopes: ${scopes.length} (expected exactly chat:write)`);
    assert.match(s.userId, /^[UW][A-Z0-9]+$/);
    ok('Slack: stored bot token valid at Slack, same workspace as stored, scopes == [chat:write] (least privilege)');
    state.slackEnv = c.env; state.slackChannel = c.id; state.slackTokenSha = createHash('sha256').update(s.botToken).digest('hex');
  } else {
    const me = await tg('getMe');
    assert.equal(me.json.ok, true); assert.equal(me.json.result.username, process.env.TELEGRAM_BOT_USERNAME);
    const wh = await tg('getWebhookInfo');
    assert.equal(wh.json.result.url, '', 'no webhook (getUpdates mode, nothing public)');
    assert.equal(typeof open(c.env, `clearspace:notify:telegram:${c.id}`).chatId, 'number');
    ok('Telegram: the configured DEV bot answers getMe, no webhook is set (getUpdates only), stored chat decrypts');
  }
}
// product path: a real in-app assignment notification -> outbox -> tick -> /api/notify/dispatch -> provider
const card = sql(`select c.id from public.cards c where c.project_id = 'project-collab-demo' and not coalesce(c.archived, false) order by c.id limit 1`);
sql(`delete from public.card_assignees where card_id = '${card}' and member_id = 'member-owner-${owner}'`);
sql(`insert into public.card_assignees (card_id, member_id) values ('${card}', 'member-owner-${owner}')`);
const queued = Number(sql(`select count(*) from public.notification_deliveries where user_id = '${owner}' and card_id = '${card}' and status = 'pending'`));
assert.equal(queued, chs.length, 'one delivery per active channel');
const t1 = JSON.parse(sql('select public.notify_scheduler_tick()'));
assert.ok(t1.request, `tick sent a batch: ${JSON.stringify(t1)}`);
for (let i = 0; i < 120 && sql(`select count(*) from net._http_response where id = ${t1.request}`) !== '1'; i++) await new Promise((r) => setTimeout(r, 500));
sql('select public.notify_scheduler_tick()');
const res = sql(`select provider || ':' || d.status || ':' || coalesce(d.last_error_code, '') from public.notification_deliveries d join public.notification_channels c on c.id = d.channel_id where d.user_id = '${owner}' and d.card_id = '${card}' order by provider`);
for (const line of res.split('\n')) assert.match(line, /^(slack|telegram):sent:$/, line);
ok(`product path LIVE: in-app assignment -> outbox -> pg_net tick -> /api/notify/dispatch -> ${chs.map((c) => c.provider).join(' + ')} accepted (status sent)`);
writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
console.log(`\nLIVE gate: ${passed} checks passed (REAL Slack / Telegram dev)`);
