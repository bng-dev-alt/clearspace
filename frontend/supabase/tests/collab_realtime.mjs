// RUN 01 + 01B -- multi-user collaboration against a REAL local Supabase stack (GoTrue, PostgREST, Realtime).
// Separately signed-in clients (no shared session/storage): owner A (+ a second tab A2), editor B, viewer V, member R
// (removed half-way, then behaves NON-COOPERATIVELY: keeps its sockets), outsider C, and D (member of a second project).
// Realtime model (01B): the database broadcasts content-free signals on PRIVATE topics `project:<id>:<key>` / `user:<uid>`;
// clients may only track presence; postgres_changes is retired for collaboration tables.
//   RT_URL=http://127.0.0.1:55531 RT_ANON=<local anon key> node supabase/tests/collab_realtime.mjs   (run from frontend/)
import { createClient } from '@supabase/supabase-js';

const { RT_URL, RT_ANON } = process.env;
if (!RT_URL || !RT_ANON) { console.error('missing RT_URL / RT_ANON'); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RT_URL)) { console.error('refusing non-local RT_URL'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);
let failed = 0; let passed = 0;
const ok = (m) => { passed += 1; console.log('ok -', m); };
const bad = (m) => { failed += 1; console.log('FAIL -', m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));
async function waitFor(pred, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(150); } return pred(); }
const PASS = 'Collab-Pass-123';

async function user(tag, name) {
  const c = createClient(RT_URL, RT_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `${tag}-${run}@example.test`;
  const { data, error } = await c.auth.signUp({ email, password: PASS, options: { data: { display_name: name } } });
  if (error || !data.session) throw new Error(`signup ${tag}: ${error?.message ?? 'no session'}`);
  c.realtime.setAuth(data.session.access_token);
  return { c, id: data.user.id, email, name };
}
const keyOf = async (u, project) => (await u.c.from('projects').select('realtime_key').eq('id', project).maybeSingle()).data?.realtime_key ?? null;

/** Join a topic; collects broadcasts + presence. Resolves with the join status (SUBSCRIBED / CHANNEL_ERROR / ...). */
function join(client, topic, bucket, { priv = true, presenceKey } = {}) {
  const ch = client.channel(topic, { config: { private: priv, ...(presenceKey ? { presence: { key: presenceKey } } : {}) } });
  ch.on('broadcast', { event: '*' }, (m) => (bucket.msgs ??= []).push({ event: m.event, payload: m.payload }));
  ch.on('presence', { event: 'sync' }, () => { bucket.presence = ch.presenceState(); });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ch, status: 'NO-STATUS' }), 10000);
    ch.subscribe((s) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) { clearTimeout(t); resolve({ ch, status: s }); } });
  });
}
const cardSignals = (b, id) => (b.msgs ?? []).filter((m) => m.event === 'change' && m.payload?.t === 'card' && m.payload.id === id);

const P = `collab-${run}`; const P2 = `collab2-${run}`;
const A = await user('owner', 'Alena Owner');
const B = await user('editor', 'Bohdan Editor');
const V = await user('viewer', 'Vera Viewer');
const R = await user('removed', 'Radek Removed');
const C = await user('outsider', 'Cyril Outsider');
const D = await user('second', 'Dana Second');
const A2 = createClient(RT_URL, RT_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
{ const { data } = await A2.auth.signInWithPassword({ email: A.email, password: PASS }); A2.realtime.setAuth(data.session.access_token); }
const channels = [];
const keep = (c, r) => { channels.push([c, r.ch]); return r; };
try {
  for (const q of [
    A.c.from('projects').insert([{ id: P, name: 'Spolupráce E2E' }, { id: P2, name: 'Druhý projekt' }]),
    A.c.from('columns').insert([{ id: `${P}-todo`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-done`, project_id: P, name: 'Hotovo', position: 1 }, { id: `${P2}-a`, project_id: P2, name: 'Příjem', position: 0 }]),
    A.c.from('project_members').insert([{ project_id: P, member_id: `member-owner-${A.id}` }, { project_id: P2, member_id: `member-owner-${A.id}` }]),
    A.c.from('workspace_members').insert({ id: `contact-${run}`, owner_id: A.id, full_name: 'Tajný Klient', initials: 'TK', email: `klient-${run}@example.test` }),
  ]) { const { error } = await q; if (error) throw error; }

  const invite = async (who, role, project = P) => {
    const { data, error } = await A.c.rpc('create_project_invitation', { p_project_id: project, p_email: who.email, p_role: role });
    if (error) throw error; return Array.isArray(data) ? data[0] : data;
  };
  const invB = await invite(B, 'member'); const invV = await invite(V, 'viewer'); const invR = await invite(R, 'member'); const invD = await invite(D, 'member', P2);
  { const { error } = await C.c.rpc('accept_workspace_invitation', { p_token: invB.token, p_display_name: 'x' }); check(Boolean(error), 'outsider cannot accept an invitation addressed to someone else'); }
  { const { error } = await C.c.rpc('accept_workspace_invitation', { p_token: 'f'.repeat(64), p_display_name: 'x' }); check(Boolean(error), 'invalid token is rejected'); }
  for (const [u, inv] of [[B, invB], [V, invV], [R, invR], [D, invD]]) {
    const { error } = await u.c.rpc('accept_workspace_invitation', { p_token: inv.token, p_display_name: u.name }); if (error) throw error;
  }
  { const { error } = await B.c.rpc('accept_workspace_invitation', { p_token: invB.token, p_display_name: 'again' }); check(Boolean(error), 'a used invitation token cannot be reused'); }
  for (const [u, role] of [[A, 'owner'], [B, 'member'], [V, 'viewer'], [R, 'member'], [C, null]]) {
    const { data } = await u.c.rpc('project_role', { p_project_id: P });
    check(data === role, `role of ${u.name} is ${role}`);
  }

  // ---- B1 contact privacy over REST ---------------------------------------------------------------
  { const { data } = await B.c.from('workspace_members').select('id, email').eq('owner_id', A.id);
    check(!(data ?? []).some((m) => m.id === `contact-${run}`), 'collaborator cannot list the owner\'s unrelated contacts over REST');
    check((data ?? []).some((m) => m.id === `member-owner-${A.id}`), 'but sees the project owner as a co-member'); }
  { const { data } = await B.c.from('workspace_members').select('id').ilike('email', `klient-${run}%`); check((data ?? []).length === 0, 'nor find them by e-mail search'); }
  { const { data } = await C.c.from('workspace_members').select('id').eq('owner_id', A.id); check((data ?? []).length === 0, 'outsider sees no contact at all'); }

  // ---- subscriptions -----------------------------------------------------------------------------------
  const k = await keyOf(A, P);
  check(typeof k === 'string' && k.length === 36, 'members read the project realtime key');
  check((await keyOf(C, P)) === null, 'outsider cannot read the key');
  const ev = { A: {}, A2: {}, B: {}, V: {}, R: {}, C: {}, D: {}, Cpub: {}, Cguess: {}, BN: {}, VN: {}, CN: {} };
  const topic = `project:${P}:${k}`;
  const a = keep(A.c, await join(A.c, topic, ev.A, { presenceKey: A.id }));
  const a2 = keep(A2, await join(A2, topic, ev.A2, { presenceKey: A.id }));
  const b = keep(B.c, await join(B.c, topic, ev.B, { presenceKey: B.id }));
  const r = keep(R.c, await join(R.c, topic, ev.R, { presenceKey: R.id }));
  check(b.status === 'SUBSCRIBED' && r.status === 'SUBSCRIBED', 'members join the private keyed project channel');
  keep(D.c, await join(D.c, `project:${P2}:${await keyOf(D, P2)}`, ev.D));
  // outsider: guessed topic (no key), stolen key, and a PUBLIC twin of the real topic
  const cg = keep(C.c, await join(C.c, `project:${P}`, ev.Cguess));
  check(cg.status !== 'SUBSCRIBED', `guessed (unkeyed) private topic is refused (${cg.status})`);
  const cs = keep(C.c, await join(C.c, topic, ev.C, { presenceKey: C.id }));
  check(cs.status !== 'SUBSCRIBED', `outsider with a stolen key is refused on the private topic (${cs.status})`);
  const cp = keep(C.c, await join(C.c, topic, ev.Cpub, { priv: false, presenceKey: C.id }));
  if (cp.status === 'SUBSCRIBED') await cp.ch.track({ name: 'spy' });
  // the retired postgres_changes path: an outsider listening to cards gets nothing, not even DELETE ids
  const pgc = []; const pgch = C.c.channel(`pgc-${run}`).on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, (p) => pgc.push(p));
  await new Promise((res) => { const t = setTimeout(res, 8000); pgch.subscribe((s) => { if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR') { clearTimeout(t); res(); } }); }); channels.push([C.c, pgch]);
  keep(B.c, await join(B.c, `user:${B.id}`, ev.BN)); keep(V.c, await join(V.c, `user:${V.id}`, ev.VN));
  const cn = keep(C.c, await join(C.c, `user:${B.id}`, ev.CN));
  check(cn.status !== 'SUBSCRIBED', `nobody can join someone else's notification topic (${cn.status})`);

  // ---- presence ------------------------------------------------------------------------------------
  await a.ch.track({ name: A.name, idle: false });
  await a2.ch.track({ name: A.name, idle: true });
  await b.ch.track({ name: B.name, idle: false });
  await r.ch.track({ name: R.name, idle: false });
  check(await waitFor(() => ev.B.presence?.[A.id]?.length === 2), 'B sees A present with 2 sessions (two tabs)');
  await sleep(1000);
  check(!ev.B.presence?.[C.id], 'outsider never appears in the members\' presence');
  check(!ev.Cpub.presence?.[A.id] && !ev.Cpub.presence?.[B.id], 'the PUBLIC twin of the topic shows nobody from the private channel');
  { const t = await b.ch.send({ type: 'broadcast', event: 'change', payload: { t: 'card', op: 'removed', id: 'forged' } }); await sleep(1500);
    check(!(ev.A.msgs ?? []).some((m) => m.payload?.id === 'forged'), `clients cannot forge broadcasts on the project topic (send: ${t})`); }
  await A2.removeChannel(a2.ch);
  check(await waitFor(() => ev.B.presence?.[A.id]?.length === 1), 'closing a tab drops that session from presence');

  // ---- live board ------------------------------------------------------------------------------------
  const K = `${P}-k1`;
  { const { error } = await A.c.from('cards').insert({ id: K, column_id: `${P}-todo`, title: 'Navrhnout logo' }); if (error) throw error; }
  check(await waitFor(() => cardSignals(ev.B, K).some((m) => m.payload.op === 'upsert')), 'B receives the new-task signal');
  check(cardSignals(ev.B, K).every((m) => !('title' in m.payload)), 'signals carry no task content (re-read under RLS)');
  { const { error } = await B.c.from('cards').update({ column_id: `${P}-done` }).eq('id', K); if (error) throw error; }
  check(await waitFor(() => cardSignals(ev.A, K).length >= 2), 'A receives B\'s status change');
  const { data: bMember } = await A.c.from('workspace_members').select('id').eq('profile_id', B.id).eq('owner_id', A.id).single();
  { const { error } = await A.c.from('card_assignees').insert({ card_id: K, member_id: bMember.id, position: 0 }); if (error) throw error; }
  check(await waitFor(() => cardSignals(ev.B, K).some((m) => (m.payload.r ?? 0) >= 1)), 'assignment reaches B as a child_rev signal');
  check(await waitFor(() => (ev.BN.msgs ?? []).some((m) => m.event === 'notification')), 'B gets a notification signal on the private user topic');
  { const { data } = await B.c.from('notifications').select('type, card_id'); check((data ?? []).some((n) => n.type === 'assignment' && n.card_id === K), 'and the assignment notification is there'); }
  { const { error } = await A.c.from('task_comments').insert({ id: `${P}-c1`, card_id: K, author_name: 'spoof', content: 'Vero, @Vera Viewer koukni', mentions: [V.id, C.id], created_at: '2020-01-01' }); if (error) throw error; }
  check(await waitFor(() => (ev.VN.msgs ?? []).length > 0), 'mentioned viewer gets a notification signal');
  { const { data } = await C.c.from('notifications').select('id'); check((data ?? []).length === 0, 'mentioned OUTSIDER gets nothing'); }
  { const { data } = await B.c.from('task_comments').select('author_id, author_name, origin, created_at').eq('id', `${P}-c1`).single();
    check(data?.author_id === A.id && data?.author_name === 'Alena Owner' && data?.origin === 'app' && data?.created_at > '2026', 'comment author and time are server-set (spoofed name and backdating ignored)'); }
  check(await waitFor(() => (ev.B.msgs ?? []).some((m) => m.event === 'activity' && m.payload.action_type === 'comment_added')), 'activity events stream to members');

  // ---- concurrency ------------------------------------------------------------------------------------
  const { data: cur } = await A.c.from('cards').select('version').eq('id', K).single();
  const [ra, rb] = await Promise.all([
    A.c.from('cards').update({ title: 'Logo (A)' }).eq('id', K).eq('version', cur.version).select('id'),
    B.c.from('cards').update({ title: 'Logo (B)' }).eq('id', K).eq('version', cur.version).select('id'),
  ]);
  check([ra, rb].filter((x) => (x.data ?? []).length === 1).length === 1, 'simultaneous versioned card saves: exactly one wins');
  { const { error } = await A.c.from('task_checklists').insert({ id: `${P}-ch`, card_id: K, text: 'Krok' }); if (error) throw error; }
  const [ct, cr] = await Promise.all([
    B.c.from('task_checklists').update({ completed: true }).eq('id', `${P}-ch`).select('id'),
    A.c.from('task_checklists').update({ text: 'Krok (upraveno)' }).eq('id', `${P}-ch`).eq('text', 'Krok').select('id'),
  ]);
  { const { data } = await A.c.from('task_checklists').select('text, completed').eq('id', `${P}-ch`).single();
    check(!ct.error && !cr.error && data.completed === true && data.text === 'Krok (upraveno)', 'simultaneous checklist toggle + rename: field-level writes keep both'); }
  { const { data } = await B.c.from('task_checklists').update({ text: 'Krok B' }).eq('id', `${P}-ch`).eq('text', 'Krok').select('id');
    check((data ?? []).length === 0, 'a rename based on a stale text is detected (0 rows) instead of overwriting'); }
  const [n1, n2] = await Promise.all([
    A.c.from('columns').update({ name: 'Rozpracováno' }).eq('id', `${P}-todo`).eq('name', 'K řešení').select('id'),
    B.c.from('columns').update({ name: 'Doing' }).eq('id', `${P}-todo`).eq('name', 'K řešení').select('id'),
  ]);
  check([n1, n2].filter((x) => (x.data ?? []).length === 1).length === 1, 'simultaneous column renames: one wins, the other is detected');
  { const { error } = await B.c.rpc('reorder_columns', { p_project_id: P, p_ordered_ids: [`${P}-done`] });
    check(error?.code === 'PT409', `reorder based on a stale column set is refused as a conflict (${error?.code} ${error?.message})`); }
  { const [x, y] = await Promise.all([
      A.c.rpc('reorder_columns', { p_project_id: P, p_ordered_ids: [`${P}-done`, `${P}-todo`] }),
      B.c.rpc('reorder_columns', { p_project_id: P, p_ordered_ids: [`${P}-todo`, `${P}-done`] }),
    ]);
    const { data } = await A.c.from('columns').select('id, position').eq('project_id', P).order('position');
    check(!x.error && !y.error && new Set(data.map((c) => c.position)).size === data.length, 'simultaneous reorders serialize: positions stay a consistent permutation'); }
  { const ins = await Promise.all([1, 2, 3].map((i) => B.c.from('cards').insert({ id: `${P}-pos${i}`, column_id: `${P}-done`, title: `p${i}`, position: 0 })));
    const { data } = await A.c.from('cards').select('position').eq('column_id', `${P}-done`);
    check(ins.every((x) => !x.error) && new Set(data.map((c) => c.position)).size === data.length, 'concurrent task inserts get distinct server-assigned positions'); }

  // ---- viewer + task history ------------------------------------------------------------------------
  { const { error } = await V.c.from('cards').insert({ id: `${P}-v`, column_id: `${P}-done`, title: 'x' }); check(error?.code === '42501', 'viewer cannot create a task'); }
  { const { error } = await V.c.from('task_activities').insert({ id: `${P}-va`, card_id: K, text: 'falešná historie' }); check(error?.code === '42501', 'viewer cannot write task history'); }
  { const { error } = await B.c.from('task_activities').insert({ id: `${P}-ba`, card_id: K, text: 'falešná historie' }); check(error?.code === '42501', 'editor cannot fabricate task history either'); }
  { const { data } = await B.c.from('activity_logs').select('action_type').eq('card_id', K);
    const t = new Set((data ?? []).map((x) => x.action_type));
    check(['card_created', 'card_moved', 'card_assigned', 'comment_added', 'checklist_item_added', 'checklist_item_completed', 'checklist_item_renamed'].every((x) => t.has(x)), `trusted task history has the real changes (${[...t].sort().join(',')})`); }
  { const { data } = await C.c.from('cards').select('id').eq('project_id', P); check((data ?? []).length === 0, 'outsider cannot read tasks'); }

  // ---- C1 cross-project move ----------------------------------------------------------------------------
  const K2 = `${P}-move`;
  { const { error } = await A.c.from('cards').insert({ id: K2, column_id: `${P}-todo`, title: 'Přesouvaný' }); if (error) throw error; }
  await waitFor(() => cardSignals(ev.B, K2).length > 0);
  { const { error } = await A.c.from('card_assignees').insert({ card_id: K2, member_id: bMember.id }); if (error) throw error; }
  { const { error } = await A.c.from('cards').update({ column_id: `${P2}-a` }).eq('id', K2); if (error) throw error; }
  check(await waitFor(() => cardSignals(ev.B, K2).some((m) => m.payload.op === 'removed')), 'source-board member gets "removed" for a card moved to another project');
  check(await waitFor(() => cardSignals(ev.D, K2).some((m) => m.payload.op === 'upsert')), 'destination-board member gets the card');
  await sleep(1000);
  check(!(ev.B.msgs ?? []).some((m) => m.event === 'activity' && m.payload.project_id === P2), 'source member receives no destination metadata');
  check((ev.B.msgs ?? []).some((m) => m.event === 'activity' && m.payload.action_type === 'card_moved_out'), 'source board logs card_moved_out');
  { const { data } = await B.c.from('cards').select('id').eq('id', K2); check((data ?? []).length === 0, 'and can no longer read it'); }
  { const { data } = await D.c.from('card_assignees').select('member_id').eq('card_id', K2); check((data ?? []).length === 0, 'assignee who is not in the destination project was unassigned'); }

  // ---- B3: deletes leak nothing to outsiders -----------------------------------------------------------
  { const { error } = await A.c.from('cards').delete().eq('id', `${P}-pos1`); if (error) throw error; }
  check(await waitFor(() => cardSignals(ev.B, `${P}-pos1`).some((m) => m.payload.op === 'removed')), 'members learn about the deletion');
  await sleep(2000);
  check(pgc.length === 0, `outsider on postgres_changes(cards) received nothing, not even DELETE ids (${pgc.length})`);
  check((ev.Cpub.msgs ?? []).length === 0 && (ev.C.msgs ?? []).length === 0 && (ev.Cguess.msgs ?? []).length === 0 && (ev.CN.msgs ?? []).length === 0, 'outsider channels received no broadcast at all');

  // ---- B2: removal + NON-cooperative client ------------------------------------------------------------
  const { data: rMember } = await A.c.from('workspace_members').select('id').eq('profile_id', R.id).eq('owner_id', A.id).single();
  { const { error } = await A.c.rpc('remove_project_member', { p_project_id: P, p_member_id: rMember.id }); if (error) throw error; }
  const k2 = await keyOf(A, P);
  check(k2 && k2 !== k, 'removing a member rotates the project key');
  check(await waitFor(() => (ev.R.msgs ?? []).some((m) => m.payload?.t === 'membership')), 'the old topic got a content-free membership signal (no key in it)');
  check((ev.R.msgs ?? []).every((m) => !JSON.stringify(m.payload).includes(k2)), 'the new key never travels over the old topic');
  // cooperative members move to the new topic (as the app does on the membership signal); R does NOT
  const evA3 = {}; const evB3 = {};
  const a3 = keep(A.c, await join(A.c, `project:${P}:${k2}`, evA3, { presenceKey: A.id }));
  const b3 = keep(B.c, await join(B.c, `project:${P}:${k2}`, evB3, { presenceKey: B.id }));
  await a3.ch.track({ name: A.name }); await b3.ch.track({ name: B.name });
  await A.c.removeChannel(a.ch); await B.c.removeChannel(b.ch);
  const rCount = (ev.R.msgs ?? []).length;
  { const { error } = await A.c.from('cards').update({ title: 'Po odebrání' }).eq('id', K); if (error) throw error; }
  check(await waitFor(() => cardSignals(evB3, K).length > 0), 'members keep receiving signals on the new topic');
  await sleep(2000);
  check((ev.R.msgs ?? []).length === rCount, 'the removed, non-cooperative client receives no further signals on its old channel');
  const rPresenceBefore = JSON.stringify(Object.keys(ev.R.presence ?? {}).sort());
  await waitFor(() => !ev.R.presence?.[A.id] && !ev.R.presence?.[B.id], 6000);
  console.log('  (removed client presence keys: before', rPresenceBefore, 'after', JSON.stringify(Object.keys(ev.R.presence ?? {}).sort()), ')');
  check(!Object.keys(ev.R.presence ?? {}).some((k) => !JSON.parse(rPresenceBefore).includes(k)), 'its presence view gains nobody new after removal');
  check(!evB3.presence?.[R.id], 'the removed client is not in the members\' new presence list');
  const rj = keep(R.c, await join(R.c, `project:${P}:${k2}`, {}));
  check(rj.status !== 'SUBSCRIBED', `even with the new key the removed member cannot join (${rj.status})`);
  { const { data } = await R.c.from('cards').select('id').eq('project_id', P); check((data ?? []).length === 0, 'removed member can no longer read tasks'); }

  // ---- reconnect: offline changes are reconciled by the re-read ----------------------------------------
  { const { error } = await A.c.from('cards').update({ title: 'Změna během výpadku' }).eq('id', K); if (error) throw error; }
  { const { data } = await B.c.from('cards').select('title').eq('id', K).single(); check(data?.title === 'Změna během výpadku', 'after reconnecting, the re-read shows the change made while offline'); }
} catch (e) {
  bad(`error: ${e?.message ?? JSON.stringify(e)}`);
} finally {
  for (const [c, ch] of channels) { try { await c.removeChannel(ch); } catch { /* gone */ } }
  for (const p of [P, P2]) { const d = await A.c.from('projects').delete().eq('id', p); if (d.error) bad(`cleanup failed: ${d.error.message}`); }
  await A.c.from('workspace_members').delete().eq('id', `contact-${run}`);
  for (const c of [A.c, A2, B.c, V.c, R.c, C.c, D.c]) c.realtime.disconnect();
}
console.log(`${passed} passed, ${failed} failed`);
console.log(failed ? 'COLLABORATION REALTIME CHECKS FAILED' : 'ALL COLLABORATION REALTIME CHECKS PASSED');
process.exit(failed ? 1 : 0);
