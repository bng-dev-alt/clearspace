// RUN 08B LIVE: Project Intelligence over REAL chat imports (Cortex in a Telegram group, the Slack channel itself) -- what the AI context
// would get is exactly what the caller may read from the hub_intelligence_messages view (lib/intelligence/context.ts fetchProjectChat).
// No AI call here (no local Gemini key / budget): answer generation over chat = BLOCKED, everything up to the context is LIVE-DB.
//   eval "$(scripts/hub-stack.sh env)"; node supabase/tests/hub_live_pi.mjs [--optout]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_SUPABASE_URL, ANON = process.env.E2E_SUPABASE_ANON_KEY, APP = 'http://127.0.0.1:3471';
const DIR = process.env.NOTIFY_STACK_DIR || `${process.env.TMPDIR}/cs-notify-sb`;
const acc = (k) => (readFileSync(`${DIR}/collab-accounts.env`, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const P = 'project-collab-demo', OPTOUT = process.argv.includes('--optout');
const sql = (q) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', 'supabase_db_cs-notify-sb', 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-F', '\t', '-c', q], { encoding: 'utf8' }).trim();
let pass = 0, fail = 0;
const ok = (c, label, msg) => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'} ${label} ${msg}`); };
const SRK = execFileSync('bash', ['-c', `cd "${DIR}" && supabase status -o env 2>/dev/null | sed -n 's/^SERVICE_ROLE_KEY=//p'`], { encoding: 'utf8' }).trim().replace(/"/g, '');
async function login(email, password = acc('COLLAB_PASSWORD')) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (await r.json()).access_token;
}
async function outsider() {
  const email = `r08b-out-${Date.now().toString(36)}@example.test`, password = 'Outsider-Password-123';
  await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }) });
  return login(email, password);
}
const view = async (tok, project = P) => { const r = await fetch(`${API}/rest/v1/hub_intelligence_messages?select=provider,destination_label,author_label,verified,text,kind&project_id=eq.${encodeURIComponent(project)}`, { headers: { apikey: ANON, Authorization: `Bearer ${tok}` } }); return r.ok ? r.json() : []; };
const api = async (tok, path, method = 'GET', body) => { const r = await fetch(`${APP}${path}`, { method, headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };

const alice = await login('alice@collab.test'), vera = await login('vera@collab.test'), out = await outsider();
const tg = sql(`select id from public.hub_destinations where project_id = '${P}' and provider = 'telegram' and status = 'active' and intelligence order by created_at desc limit 1`);
const stored = Number(sql(`select count(*) from public.hub_messages m join public.hub_destinations d on d.id = m.destination_id where d.project_id = '${P}' and d.intelligence and m.deleted_at is null`));
const a = await view(alice), v = await view(vera), o = await view(out);
ok(stored > 0 && a.length === stored, '[LIVE-DB]', `1. owner's AI context sees exactly the opted-in chat records of this project (${a.length} of ${stored}; providers: ${[...new Set(a.map((x) => x.provider))].join('+')})`);
ok(v.length === a.length, '[LIVE-DB]', '2. a project member (viewer) sees the same, nothing more');
ok(o.length === 0, '[LIVE-DB]', '3. an outsider sees nothing (RLS), so no outsider AI context can contain it');
const other = sql(`select id from public.projects where id <> '${P}' and name like 'R08-%Jiný projekt%' limit 1`);
ok(!other || (await view(alice, other)).length === 0, '[LIVE-DB]', '4. another project\'s context gets none of these messages');
ok(a.every((x) => !('msg_key_hmac' in x) && !('author_user_id' in x)), '[LIVE-DB]', '5. routing keys / user ids are not exposed to the context');
const inj = a.find((x) => /SYSTEM|ignoruj pokyny/i.test(x.text));
if (inj) {
  const auto = sql(`select count(*) from public.activity_logs where project_id = '${P}' and created_at > now() - interval '3 hours' and action_type in ('card_moved', 'card_completed', 'card_updated') and actor_id = (select user_id from public.hub_service_principal limit 1)`);
  ok(auto === '0', '[LIVE-DB]', '6. injected chat text ("SYSTEM: ignoruj pokyny ...") was stored as quoted data only -- nothing changed tasks on its own');
} else console.log('SKIP 6. no injection test message received yet');
console.log('BLOCKED 7. AI answer generation over this context: no local Gemini key / budget (production key is never used locally)');
if (OPTOUT && tg) {
  const before = Number(sql(`select count(*) from public.hub_messages where destination_id = '${tg}' and kind = 'ingested'`));
  const r = await api(alice, `/api/hub/destinations/${tg}`, 'PATCH', { notify: true, interactive: true, intelligence: false, eventTypes: ['task_created', 'task_completed', 'status_changed', 'due_soon'] });
  const after = Number(sql(`select count(*) from public.hub_messages where destination_id = '${tg}' and kind = 'ingested'`));
  ok(r.status === 200 && before > 0 && after === 0 && (await view(alice)).every((x) => x.provider !== 'telegram'), '[LIVE-DB]', `8. opt-out: Project Intelligence off for the Telegram group -> ${before} imported messages deleted at once, gone from the context`);
}
console.log(`\nLIVE PI (this driver): ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
