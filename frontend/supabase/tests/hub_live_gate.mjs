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
  for (const [m, p] of [['GET', '/'], ['GET', '/?login=auto'], ['GET', '/settings'], ['POST', '/api/dev/login'], ['GET', '/api/hub/projects/x'], ['POST', '/api/hub/identity'], ['POST', '/api/hub/dispatch'], ['GET', '/api/hub/slack/install/callback']]) {
    const r = await fetch(`${URL_}${p}`, { method: m, redirect: 'manual' }).catch(() => null);
    res(r?.status === 404, `tunnel: ${m} ${p.split('?')[0]} is not reachable (404)`);
  }
  for (const p of ['/api/hub/slack/events', '/api/hub/slack/commands', '/api/hub/slack/interactivity', '/api/hub/telegram/webhook']) {
    const r = await fetch(`${URL_}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
    res(r?.status === 401 || r?.status === 503, `tunnel: unsigned POST ${p} refused (${r?.status})`);
  }
} else res(false, 'no running tunnel (start: hub-live.sh app)');

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
const inst = sql(`select count(*) || ':' || coalesce(bool_and(scopes @> array['chat:write','commands','channels:history','groups:history'] and cardinality(scopes) = 4)::text, 'none') from public.hub_slack_installations where status = 'active'`);
res(/^[1-9][0-9]*:true$/.test(inst), `Slack project app installed with exactly the 4 bot scopes (${inst.split(':')[0]} active)`);
console.log(failed ? `\nLIVE GATE: ${failed} FAIL` : '\nLIVE GATE: PASS');
process.exit(failed ? 1 : 0);
