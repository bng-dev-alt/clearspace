// Realtime (postgres_changes) behaviour: a project member receives card changes, a stranger and anon receive none.
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
async function listen(client, name, bucket) {
  const ch = client.channel(name).on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, (p) => bucket.push(p));
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('subscribe timeout')), 15000); ch.subscribe((s, e) => { if (s === 'SUBSCRIBED') { clearTimeout(t); res(); } if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { clearTimeout(t); rej(e ?? new Error(s)); } }); });
  return ch;
}

const run = Date.now().toString(36);
const P = `rt-${run}`;
const A = await login(RT_A_EMAIL, RT_A_PASS);
const B = await login(RT_B_EMAIL, RT_B_PASS);
const anon = mk();
const evA = [], evB = [], evAnon = [];
try {
  const e1 = await A.from('projects').insert({ id: P, name: 'Realtime check' }); if (e1.error) throw e1.error;
  const e2 = await A.from('columns').insert({ id: `${P}-c`, project_id: P, name: 'Todo', position: 0 }); if (e2.error) throw e2.error;
  const e3 = await A.from('cards').insert({ id: `${P}-k`, column_id: `${P}-c`, title: 'before' }); if (e3.error) throw e3.error;

  const chs = [await listen(A, `a-${run}`, evA), await listen(B, `b-${run}`, evB), await listen(anon, `n-${run}`, evAnon)];
  await sleep(1500);
  const up = await A.from('cards').update({ title: 'after' }).eq('id', `${P}-k`); if (up.error) throw up.error;
  for (let i = 0; i < 20 && evA.length === 0; i++) await sleep(500);
  await sleep(3000); // give a leaking channel time to leak
  evA.some((p) => p.eventType === 'UPDATE' && p.new?.title === 'after') ? ok('member receives the card UPDATE via Realtime') : bad(`member got no UPDATE (events: ${evA.length})`);
  const leaks = (list) => list.filter((p) => (p.new && Object.keys(p.new).length) || (p.old && Object.keys(p.old).length));
  evB.length && console.log('  (non-member payload kinds:', evB.map((p) => (p.errors ? 'errors:' + JSON.stringify(p.errors) : 'data')).join(','), ')');
  leaks(evB).length === 0 ? ok('non-member receives NO row data via Realtime (RLS applies)') : bad(`non-member received row data (${leaks(evB).length})`);
  // Realtime may deliver an ERROR notice (payload.errors, empty new/old) to a role that may not read the table;
  // that is a refusal, not a leak. A leak is any payload carrying row data.
  evAnon.length && console.log('  (anon payload kinds:', evAnon.map((p) => (p.errors ? 'errors:' + JSON.stringify(p.errors) : 'data')).join(','), ')');
  leaks(evAnon).length === 0 ? ok('anon receives NO row data via Realtime') : bad(`anon received row data (${leaks(evAnon).length})`);
  for (const c of chs) await c.unsubscribe();
} catch (e) { bad(`error: ${e.message ?? e}`); }
finally {
  const d = await A.from('projects').delete().eq('id', P); // cascades columns/cards
  d.error ? bad(`cleanup failed: ${d.error.message}`) : ok('cleanup: project deleted');
  A.realtime.disconnect(); B.realtime.disconnect(); anon.realtime.disconnect();
}
console.log(failed ? 'REALTIME CHECKS FAILED' : 'ALL REALTIME CHECKS PASSED');
process.exit(failed ? 1 : 0);
