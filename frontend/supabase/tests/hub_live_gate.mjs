// RUN 07B live gate (hub-live.sh gate): REAL providers, booleans only -- never a token, id or message text in the output.
//  - tunnel scoping: the public URL reaches only the 5 signed webhook paths (UI, DEV login, user APIs -> 404; unsigned webhooks -> 401)
//  - Telegram: project bot privacy mode ON (can_read_all_group_messages=false), PI bot privacy OFF, webhooks point at this tunnel, no errors
//  - Slack: an installation of the project app exists with exactly the 4 bot scopes
import { execFileSync } from 'node:child_process';
const URL_ = process.env.HUB_LIVE_URL, DBC = 'supabase_db_cs-notify-sb';
let failed = 0;
const res = (ok, m) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} - ${m}`); };
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', DBC, 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-q', '-c', q], { encoding: 'utf8' }).trim();
const tg = async (token, method) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST' })).json().catch(() => ({}));

if (URL_ && /^https:\/\/[a-z0-9.-]+$/.test(URL_)) {
  for (const [m, p] of [['GET', '/'], ['GET', '/?login=auto'], ['GET', '/settings'], ['GET', '/login'], ['POST', '/api/dev/login'], ['GET', '/api/dev/login'], ['GET', '/api/hub/projects/x'],
    ['POST', '/api/hub/identity'], ['POST', '/api/hub/dispatch'], ['GET', '/api/hub/slack/install/callback'], ['POST', '/api/hub/slack/install/complete'], ['GET', '/api/notify/status'],
    ['POST', '/api/notify/dispatch'], ['GET', '/_next/static/chunks/main.js'], ['GET', '/api/hub/telegram/webhook'], ['POST', '/api/hub/telegram/webhook/../../../api/dev/login'],
    ['POST', '/api/hub/slack/events/'], ['GET', '/rest/v1/'], ['GET', '/auth/v1/settings']]) {
    const r = await fetch(`${URL_}${p}`, { method: m, redirect: 'manual' }).catch(() => null);
    res(r?.status === 404, `tunnel: ${m} ${p.split('?')[0]} is not reachable (404)`);
  }
  for (const p of ['/api/hub/slack/events', '/api/hub/slack/events?x=1', '/api/hub/slack/commands', '/api/hub/slack/interactivity', '/api/hub/telegram/webhook']) {
    const r = await fetch(`${URL_}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    res(r?.status === 401 || r?.status === 503, `tunnel: unsigned POST ${p} refused (${r?.status})`);
  }
  // a forged Telegram secret and a forged / stale Slack signature are refused; a valid-looking but unsigned PI webhook too
  const tgf = await fetch(`${URL_}/api/hub/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'x'.repeat(48) }, body: '{"update_id":1}' }).catch(() => null);
  res(tgf?.status === 401, `tunnel: forged Telegram secret refused (${tgf?.status})`);
  const ts = Math.floor(Date.now() / 1000) - 600;
  const slf = await fetch(`${URL_}/api/hub/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + 'a'.repeat(64) }, body: '{"type":"url_verification","challenge":"x"}' }).catch(() => null);
  res(slf?.status === 401, `tunnel: forged + stale Slack signature refused (${slf?.status})`);
  const big = await fetch(`${URL_}/api/hub/telegram/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) }).catch(() => null);
  res(big?.status === 413 || big?.status === 401, `tunnel: oversized body refused (${big?.status})`);
  const pi = await fetch(`${URL_}/api/hub/telegram/pi-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  res(pi?.status === 401 || pi?.status === 503, `tunnel: unsigned PI webhook refused (${pi?.status})`);
} else res(false, 'no running tunnel (start: hub-live.sh app)');

// local UI path (RUN 08 defect: the page hung because the HTTPS proxy dropped WebSocket upgrades -> Next dev HMR socket never opened)
{
  const tls = await import('node:tls');
  const code = await new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: 3472, servername: 'localhost', rejectUnauthorized: false }, () => {
      s.write('GET /_next/webpack-hmr HTTP/1.1\r\nHost: localhost:3472\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    s.once('data', (d) => { resolve(Number(/HTTP\/1\.1 (\d{3})/.exec(d.toString())?.[1] ?? 0)); s.destroy(); });
    s.on('error', () => resolve(0)); setTimeout(() => { resolve(0); s.destroy(); }, 5000);
  });
  res(code === 101, `local UI: WebSocket upgrade through the HTTPS proxy works (${code}) -- the page can finish loading`);
}
if (process.env.TELEGRAM_HUB_BOT_TOKEN) {
  const me = await tg(process.env.TELEGRAM_HUB_BOT_TOKEN, 'getMe');
  res(me.ok === true && me.result?.username === process.env.TELEGRAM_HUB_BOT_USERNAME, 'project bot token valid, username matches');
  res(me.result?.can_read_all_group_messages === false, 'project bot privacy mode ON (reads only commands + replies to itself)');
  const wh = await tg(process.env.TELEGRAM_HUB_BOT_TOKEN, 'getWebhookInfo');
  res(wh.result?.url === `${URL_}/api/hub/telegram/webhook`, 'project bot webhook points at this tunnel');
  res(!wh.result?.last_error_message, 'project bot webhook: no delivery error reported by Telegram');
  if (process.env.TELEGRAM_BOT_TOKEN) res(process.env.TELEGRAM_BOT_TOKEN !== process.env.TELEGRAM_HUB_BOT_TOKEN, 'project bot != personal notification bot');
} else res(false, 'project Telegram bot not configured (hub-live.sh set-telegram)');
if (process.env.TELEGRAM_HUB_PI_BOT_TOKEN) {
  const me = await tg(process.env.TELEGRAM_HUB_PI_BOT_TOKEN, 'getMe');
  res(me.ok === true && me.result?.can_read_all_group_messages === true, 'PI bot valid with privacy mode OFF (required for full-group ingestion)');
  const wh = await tg(process.env.TELEGRAM_HUB_PI_BOT_TOKEN, 'getWebhookInfo');
  res(wh.result?.url === `${URL_}/api/hub/telegram/pi-webhook`, 'PI bot webhook points at this tunnel');
} else console.log('skip - optional PI bot not configured');
const inst = sql(`select count(*) || ':' || coalesce(bool_and(scopes @> array['chat:write','commands','channels:history','groups:history'] and cardinality(scopes) = 4)::text, 'none') from public.hub_slack_installations where status = 'active' and team_label not like '%(simulace)%'`);
res(/^[1-9][0-9]*:true$/.test(inst), `Slack project app installed with exactly the 4 bot scopes (${inst.split(':')[0]} active)`);
console.log(failed ? `\nLIVE GATE: ${failed} FAIL` : '\nLIVE GATE: PASS');
process.exit(failed ? 1 : 0);
