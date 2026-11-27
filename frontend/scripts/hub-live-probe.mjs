#!/usr/bin/env node
/**
 * RUN 08 live probe: reads what REALLY happened at the providers for the linked TEST destinations of the isolated live stack (never prints a
 * token or id): the project Slack app's own view of the linked test channel (conversations.history / replies with the bot token), and the
 * Telegram webhook state. Read-only towards the providers except where a subcommand says otherwise.
 *
 *   node scripts/hub-live-probe.mjs slack-history [N]          # last N messages of the linked test channel (+ thread replies)
 *   node scripts/hub-live-probe.mjs slack-post-as-bot "<text>" # a message by the APP itself (real Slack event; the hub must ignore it)
 *   node scripts/hub-live-probe.mjs slack-revoke               # auth.revoke of the project app's bot token (REAL revocation test)
 * Env: run via `hub-live.sh probe ...` (stack + keys), PROJECT (default project-collab-demo).
 */
import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DIR = process.env.NOTIFY_STACK_DIR || `${process.env.TMPDIR}/cs-notify-sb`;
const acc = (k) => (readFileSync(`${DIR}/collab-accounts.env`, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const raw = Buffer.from(acc('HUB_TOKEN_ENCRYPTION_KEY') || '', 'base64');
const ring = { id: createHash('sha256').update(raw).digest('hex').slice(0, 8), key: raw };
const open = (env, aad) => {
  const m = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(env);
  if (!m || m[1] !== ring.id) throw new Error('cannot open envelope');
  const d = createDecipheriv('aes-256-gcm', ring.key, Buffer.from(m[2], 'base64url'));
  d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(m[4], 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString('utf8'));
};
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', 'supabase_db_cs-notify-sb', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' }).trim();
const PROJECT = process.env.PROJECT || 'project-collab-demo';
const row = sql(`select d.id, d.ext_ref_enc, i.id, i.secret_enc from public.hub_destinations d join public.hub_slack_installations i on i.id = d.installation_id
  where d.project_id = '${PROJECT}' and d.provider = 'slack' and d.label = '${(process.env.CHANNEL || '#clearspace_test').replace(/'/g, "''")}' limit 1`);
if (!row) { console.error('no linked Slack test channel'); process.exit(2); }
const [destId, refEnc, instId, secEnc] = row.split('\t');
const { channelId } = open(refEnc, `clearspace:hub:destination:${destId}`);
const { botToken } = open(secEnc, `clearspace:hub:installation:${instId}`);
const slack = async (method, params, post = false) => {
  const r = await fetch(`https://slack.com/api/${method}${post ? '' : `?${new URLSearchParams(params)}`}`, post
    ? { method: 'POST', headers: { Authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) }
    : { headers: { Authorization: `Bearer ${botToken}` } });
  return r.json();
};
const [cmd, arg] = process.argv.slice(2);
const fmt = (m) => ({ ts: m.ts, by: m.bot_id ? 'bot' : 'human', thread: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : (m.reply_count ? `root(${m.reply_count})` : ''), text: m.text,
  blocks: (m.blocks || []).length, attachments: (m.attachments || []).length });
if (cmd === 'slack-history') {
  const h = await slack('conversations.history', { channel: channelId, limit: Number(arg || 15) });
  if (!h.ok) { console.log(JSON.stringify({ ok: false, error: h.error })); process.exit(1); }
  for (const m of h.messages.reverse()) {
    console.log(JSON.stringify(fmt(m)));
    if (m.reply_count) {
      const r = await slack('conversations.replies', { channel: channelId, ts: m.ts, limit: 20 });
      for (const x of (r.messages || []).slice(1)) console.log('   ↳ ' + JSON.stringify(fmt(x)));
    }
  }
} else if (cmd === 'slack-post-as-bot') {
  const r = await slack('chat.postMessage', { channel: channelId, text: arg || 'ClearSpace RUN 08 – zpráva samotné aplikace (test smyček)', mrkdwn: false }, true);
  console.log(JSON.stringify({ ok: r.ok, ts: r.ts, error: r.error }));
} else if (cmd === 'slack-revoke') {
  const r = await slack('auth.revoke', {}, true);
  console.log(JSON.stringify({ ok: r.ok, revoked: r.revoked, error: r.error }));
} else { console.error('usage: slack-history [N] | slack-post-as-bot "<text>" | slack-revoke'); process.exit(2); }
