// RUN 08B LIVE watcher: runs while the owner does the few human-only steps (Slack reinstall, private channel, Telegram group, Cortex) and
// does every follow-up ITSELF so the owner never has to: confirms new channels / groups as the project owner (alice), switches tasks-from-chat
// on, opts the group/channel into Project Intelligence (the owner asked for this test), sends a test message, triggers a real scheduler
// notification, answers a task created from chat with a ClearSpace comment (comment sync back into the thread / reply).
// One line per event (no tokens, no chat ids, no person ids). Stops itself after WATCH_MINUTES (default 90).
//   eval "$(scripts/hub-stack.sh env)"; node supabase/tests/hub_live_watch.mjs >> $TMPDIR/r08b-watch.log
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL, ANON = process.env.E2E_SUPABASE_ANON_KEY, APP = 'http://127.0.0.1:3471';
const DIR = process.env.NOTIFY_STACK_DIR || `${process.env.TMPDIR}/cs-notify-sb`;
const acc = (k) => (readFileSync(`${DIR}/collab-accounts.env`, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const P = 'project-collab-demo', END = Date.now() + Number(process.env.WATCH_MINUTES || 90) * 60_000;
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', 'supabase_db_cs-notify-sb', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' }).trim();
const rows = (q) => { const o = sql(q); return o ? o.split('\n').map((l) => l.split('\t')) : []; };
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: acc('COLLAB_PASSWORD') }) });
  return (await r.json()).access_token;
}
let alice = await login('alice@collab.test'), bob = await login('bob@collab.test'), lastLogin = Date.now();
const api = async (path, method = 'GET', body, tok = alice) => { const r = await fetch(`${APP}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const rest = (path, method, body, tok) => fetch(`${API}/rest/v1/${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'content-type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
const ALL = ['task_created', 'task_completed', 'status_changed', 'due_soon'];
const since = sql('select now()');
const seen = new Set();
const once = (k) => (seen.has(k) ? false : (seen.add(k), true));
log(`watcher started (project ${P}); waiting for the owner's steps`);

while (Date.now() < END) {
  try {
    if (Date.now() - lastLogin > 30 * 60_000) { alice = await login('alice@collab.test'); bob = await login('bob@collab.test'); lastLogin = Date.now(); }
    // 1. Slack app reinstalled -> re-check the revoked channel with a test message (reactivates it on a proven send)
    for (const [inst] of rows(`select id from public.hub_slack_installations where status = 'active' and team_label not like '%(simulace)%'`)) {
      if (!once(`inst:${inst}`)) continue;
      log('SLACK: project app installed again (active installation)');
      for (const [d] of rows(`select id from public.hub_destinations where project_id = '${P}' and provider = 'slack' and status = 'revoked' and installation_id = '${inst}'`)) {
        const t = await api(`/api/hub/destinations/${d}`, 'POST');
        log(`SLACK: revoked channel re-checked -> ${t.status} ${t.j.outcome ?? ''}${t.j.reactivated ? ' (reactivated)' : ''} ${t.j.message ?? ''}`);
      }
    }
    // 2. new channel / group linked by code -> confirm, tasks from chat on, Project Intelligence on (acknowledged), test message, notification
    for (const [d, prov, label, kind] of rows(`select id, provider, label, kind from public.hub_destinations where project_id = '${P}' and status = 'pending' and created_at > '${since}'`)) {
      if (!once(`dest:${d}`)) continue;
      log(`${prov.toUpperCase()}: new ${kind} "${label}" linked by code (pairing box should show it by itself)`);
      const c = await api(`/api/hub/destinations/${d}`, 'PATCH', { decision: 'confirm' });
      const caps = await api(`/api/hub/destinations/${d}`, 'PATCH', { notify: true, interactive: true, intelligence: true, intelligenceAck: true, fullIngest: prov === 'telegram', eventTypes: ALL });
      log(`${prov.toUpperCase()}: confirmed (${c.status} ${c.j.status ?? ''}), tasks from chat + Project Intelligence on (${caps.status} ${caps.j.message ?? ''})`);
      await sleep(1500);
      const t = await api(`/api/hub/destinations/${d}`, 'POST');
      log(`${prov.toUpperCase()}: test message -> ${t.j.outcome ?? t.status} ${t.j.message ?? ''}`);
      const card = `${P}-r08b-${prov}-${Date.now().toString(36).slice(-4)}`;
      const r = await rest('cards', 'POST', { id: card, column_id: `${P}-column-1`, title: `RUN 08B oznámení pro ${label}` }, bob);
      log(`${prov.toUpperCase()}: bob created a task for a real scheduler notification (${r.status}); delivery follows within ~1-2 min`);
    }
    // 3. scheduler deliveries to destinations linked in this run
    for (const [o, prov, label, kind, status, code] of rows(`select o.id, d.provider, d.label, o.kind, o.status, coalesce(o.last_error_code, '') from public.hub_outbox o join public.hub_destinations d on d.id = o.destination_id
        where o.created_at > '${since}' and o.status in ('sent', 'failed', 'cancelled')`)) {
      if (once(`out:${o}`)) log(`${prov.toUpperCase()}: scheduler ${kind} to "${label}" -> ${status}${code ? ` (${code})` : ''}`);
    }
    // 4. task created FROM chat -> answer it with a ClearSpace comment (goes back into the thread / as a Telegram reply)
    for (const [conv, card, prov, label] of rows(`select c.id, c.card_id, d.provider, d.label from public.hub_conversations c join public.hub_destinations d on d.id = c.destination_id
        where c.created_at > '${since}' and d.project_id = '${P}'`)) {
      if (!once(`conv:${conv}`)) continue;
      const title = sql(`select title from public.cards where id = '${card}'`);
      log(`${prov.toUpperCase()}: task created from chat in "${label}": "${title.slice(0, 80)}"`);
      const cid = `cm-r08b-${Date.now().toString(36)}`;
      const r = await rest('task_comments', 'POST', { id: cid, card_id: card, author_name: 'x', content: 'RUN 08B: odpověď z ClearSpace – vidíte ji ve vlákně / jako odpověď?' }, alice);
      log(`${prov.toUpperCase()}: ClearSpace comment on that task (${r.status}) -> comment sync to the chat follows`);
    }
    // 5. comments that came FROM chat (thread replies / replies to the bot)
    for (const [cm, prov, card] of rows(`select l.comment_id, l.provider, c.card_id from public.hub_comment_links l join public.task_comments c on c.id = l.comment_id where l.created_at > '${since}' and l.direction = 'inbound'`)) {
      if (once(`in:${cm}`)) log(`${prov.toUpperCase()}: reply in chat became a task comment (card ${card.slice(-12)})`);
    }
    for (const [cm, prov] of rows(`select comment_id, provider from public.hub_comment_links where created_at > '${since}' and direction = 'outbound'`)) {
      if (once(`outc:${cm}`)) log(`${prov.toUpperCase()}: ClearSpace comment delivered into the chat thread`);
    }
    // 6. Project Intelligence imports (Cortex in Telegram, the channel itself in Slack)
    for (const [m, prov, label, verified, len] of rows(`select id, provider, destination_label, verified, length(text) from public.hub_messages where created_at > '${since}' and kind = 'ingested'`)) {
      if (once(`pi:${m}`)) log(`${prov.toUpperCase()}: Project Intelligence imported a message from "${label}" (${len} chars, verified author: ${verified})`);
    }
  } catch (e) { log(`watcher error: ${String(e.message ?? e).slice(0, 160)}`); }
  await sleep(4000);
}
log('watcher stopped (time limit)');
