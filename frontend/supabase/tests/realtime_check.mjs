// Realtime behaviour (RUN 01B model): a project member receives the server's card signal on the PRIVATE topic
// `project:<id>:<realtime_key>`; a stranger and anon are refused on that topic, cannot read the key, and the
// retired postgres_changes path on `cards` delivers nothing (not even DELETE ids).
// Works against a throwaway local stack or a hosted project (disposable users only). Cleans up what it creates.
//   RT_URL=... RT_ANON=... RT_A_EMAIL=.. RT_A_PASS=.. RT_B_EMAIL=.. RT_B_PASS=.. [RT_SIGNUP=1] node realtime_check.mjs
// Run from frontend/ so @supabase/supabase-js resolves.
import { createClient } from '@supabase/supabase-js';

const { RT_URL, RT_ANON, RT_A_EMAIL, RT_A_PASS, RT_B_EMAIL, RT_B_PASS, RT_SIGNUP } = process.env;
if (!RT_URL || !RT_ANON || !RT_A_EMAIL || !RT_B_EMAIL) { console.error('missing env'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => createClient(RT_URL, RT_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
let failed = false;
const ok = (m) => console.log('ok -', m);
const bad = (m) => { console.log('FAIL -', m); failed = true; };

async function login(email, pass) {
  const c = mk();
  let { data, error } = await c.auth.signInWithPassword({ email, password: pass });
  if (error && RT_SIGNUP === '1') ({ data, error } = await c.auth.signUp({ email, password: pass }));
  if (error || !data.session) throw new Error(`login failed for ${email}: ${error?.message}`);
  c.realtime.setAuth(data.session.access_token);
  return c;
}
function join(client, topic, bucket, priv = true) {
  const ch = client.channel(topic, { config: { private: priv } }).on('broadcast', { event: '*' }, (m) => bucket.push(m));
  return new Promise((res) => {
    const t = setTimeout(() => res({ ch, status: 'NO-STATUS' }), 12000);
    ch.subscribe((s) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) { clearTimeout(t); res({ ch, status: s }); } });
  });
}

const run = Date.now().toString(36);
const P = `rt-${run}`;
const A = await login(RT_A_EMAIL, RT_A_PASS);
const B = await login(RT_B_EMAIL, RT_B_PASS);
const anon = mk();
const evA = [], evB = [], evAnon = [], pg = [];
const chs = [];
try {
  const e1 = await A.from('projects').insert({ id: P, name: 'Realtime check' }); if (e1.error) throw e1.error;
  const e2 = await A.from('columns').insert({ id: `${P}-c`, project_id: P, name: 'Todo', position: 0 }); if (e2.error) throw e2.error;
  const e3 = await A.from('cards').insert({ id: `${P}-k`, column_id: `${P}-c`, title: 'before' }); if (e3.error) throw e3.error;
  const key = (await A.from('projects').select('realtime_key').eq('id', P).single()).data?.realtime_key;
  if (key) ok('member reads the realtime key'); else bad('member cannot read the realtime key (migration 20261125001100 missing?)');
  const keyB = (await B.from('projects').select('realtime_key').eq('id', P).maybeSingle()).data;
  keyB ? bad('non-member can read the realtime key') : ok('non-member cannot read the realtime key');
  const topic = `project:${P}:${key}`;
  const a = await join(A, topic, evA); chs.push([A, a.ch]);
  if (a.status === 'SUBSCRIBED') ok('member joins the private project topic'); else bad(`member join: ${a.status}`);
  const b = await join(B, topic, evB); chs.push([B, b.ch]);
  if (b.status !== 'SUBSCRIBED') ok(`non-member is refused on the private topic (${b.status})`); else bad('non-member joined the private topic');
  const n = await join(anon, topic, evAnon); chs.push([anon, n.ch]);
  if (n.status !== 'SUBSCRIBED') ok(`anon is refused on the private topic (${n.status})`); else bad('anon joined the private topic');
  const pgch = B.channel(`pg-${run}`).on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, (p) => pg.push(p));
  await new Promise((res) => { const t = setTimeout(res, 8000); pgch.subscribe((s) => { if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR') { clearTimeout(t); res(); } }); }); chs.push([B, pgch]);
  await sleep(1000);
  const up = await A.from('cards').update({ title: 'after' }).eq('id', `${P}-k`); if (up.error) throw up.error;
  for (let i = 0; i < 40 && !evA.some((m) => m.payload?.id === `${P}-k`); i++) await sleep(250);
  if (evA.some((m) => m.event === 'change' && m.payload?.t === 'card' && m.payload?.id === `${P}-k`)) ok('member receives the card signal'); else bad(`member got no signal (${evA.length})`);
  const del = await A.from('cards').delete().eq('id', `${P}-k`); if (del.error) throw del.error;
  await sleep(3000); // give a leaking channel time to leak
  if (evB.length === 0 && evAnon.length === 0) ok('non-member and anon receive nothing'); else bad(`leak: B=${evB.length} anon=${evAnon.length}`);
  if (pg.length === 0) ok('postgres_changes on cards delivers nothing (no DELETE ids)'); else bad(`postgres_changes delivered ${pg.length} payload(s)`);
} catch (e) { bad(`error: ${e.message ?? e}`); }
finally {
  for (const [c, ch] of chs) { try { await c.removeChannel(ch); } catch { /* gone */ } }
  const d = await A.from('projects').delete().eq('id', P); // cascades columns/cards
  if (d.error) bad(`cleanup failed: ${d.error.message}`); else ok('cleanup: project deleted');
  A.realtime.disconnect(); B.realtime.disconnect(); anon.realtime.disconnect();
}
console.log(failed ? 'REALTIME CHECKS FAILED' : 'ALL REALTIME CHECKS PASSED');
process.exit(failed ? 1 : 0);
