// RUN 01 -- multi-user collaboration against a REAL local Supabase stack (GoTrue, PostgREST, Realtime).
// Five independently signed-in clients (separate sessions, no shared storage): owner A, editor B, viewer V,
// member R (removed half-way) and outsider C. Verifies realtime delivery + isolation, presence authorization,
// notifications, activity, optimistic concurrency, viewer write refusal, revocation and invitation rules.
//   RT_URL=http://127.0.0.1:55531 RT_ANON=<local anon key> node supabase/tests/collab_realtime.mjs
// Run from frontend/. Refuses non-local URLs. Creates throwaway users/projects (unique per run) and deletes the project.
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

async function user(tag, name) {
  const c = createClient(RT_URL, RT_ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `${tag}-${run}@example.test`;
  const { data, error } = await c.auth.signUp({ email, password: 'Collab-Pass-123', options: { data: { display_name: name } } });
  if (error || !data.session) throw new Error(`signup ${tag}: ${error?.message ?? 'no session (confirmations on?)'}`);
  c.realtime.setAuth(data.session.access_token);
  return { c, id: data.user.id, email, name };
}

function subscribe(client, topic, project, buckets, opts = {}) {
  let ch = client.channel(topic, opts.config ? { config: opts.config } : undefined);
  const f = `project_id=eq.${project}`;
  for (const table of opts.tables ?? []) {
    ch = ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: table === 'notifications' ? `recipient_id=eq.${opts.recipient}` : f },
      (p) => (buckets[table] ??= []).push(p));
  }
  if (opts.presence) ch = ch.on('presence', { event: 'sync' }, () => { buckets.presence = ch.presenceState(); });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ch, status: 'TIMEOUT' }), 12000);
    ch.subscribe((s) => { if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') { clearTimeout(t); resolve({ ch, status: s }); } });
  });
}
const rowsWithData = (list = []) => list.filter((p) => (p.new && Object.keys(p.new).length) || (p.old && Object.keys(p.old).length > 1));

const P = `collab-${run}`;
const A = await user('owner', 'Alena Owner');
const B = await user('editor', 'Bohdan Editor');
const V = await user('viewer', 'Vera Viewer');
const R = await user('removed', 'Radek Removed');
const C = await user('outsider', 'Cyril Outsider');
const A2 = createClient(RT_URL, RT_ANON, { auth: { persistSession: false, autoRefreshToken: false } }); // A's second tab
{ const { data } = await A2.auth.signInWithPassword({ email: A.email, password: 'Collab-Pass-123' }); A2.realtime.setAuth(data.session.access_token); }
const channels = [];
try {
  // ---- project + invitations -------------------------------------------------------------
  for (const q of [
    A.c.from('projects').insert({ id: P, name: 'Spolupráce E2E' }),
    A.c.from('columns').insert([{ id: `${P}-todo`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-done`, project_id: P, name: 'Hotovo', position: 1 }]),
    A.c.from('project_members').insert({ project_id: P, member_id: `member-owner-${A.id}` }),
  ]) { const { error } = await q; if (error) throw error; }

  const invite = async (who, role) => {
    const { data, error } = await A.c.rpc('create_project_invitation', { p_project_id: P, p_email: who.email, p_role: role });
    if (error) throw error; return Array.isArray(data) ? data[0] : data;
  };
  const invB = await invite(B, 'member'); const invV = await invite(V, 'viewer'); const invR = await invite(R, 'member');
  { const { error } = await C.c.rpc('accept_workspace_invitation', { p_token: invB.token, p_display_name: 'x' }); check(Boolean(error), 'outsider cannot accept an invitation addressed to someone else'); }
  { const { error } = await C.c.rpc('accept_workspace_invitation', { p_token: 'f'.repeat(64), p_display_name: 'x' }); check(Boolean(error), 'invalid token is rejected'); }
  for (const [u, inv] of [[B, invB], [V, invV], [R, invR]]) {
    const { error } = await u.c.rpc('accept_workspace_invitation', { p_token: inv.token, p_display_name: u.name }); if (error) throw error;
  }
  { const { error } = await B.c.rpc('accept_workspace_invitation', { p_token: invB.token, p_display_name: 'again' }); check(Boolean(error), 'a used invitation token cannot be reused'); }
  for (const [u, role] of [[A, 'owner'], [B, 'member'], [V, 'viewer'], [R, 'member'], [C, null]]) {
    const { data } = await u.c.rpc('project_role', { p_project_id: P });
    check(data === role, `role of ${u.name} is ${role}`);
  }

  // ---- subscriptions (separate sessions) ---------------------------------------------------
  const ev = { A: {}, B: {}, V: {}, R: {}, C: {} };
  const boardTables = ['cards', 'columns', 'activity_logs', 'project_members'];
  for (const [k, u] of [['A', A], ['B', B], ['R', R], ['C', C]]) {
    const s = await subscribe(u.c, `board:${P}:${k}`, P, ev[k], { tables: boardTables });
    channels.push([u.c, s.ch]); if (s.status !== 'SUBSCRIBED') throw new Error(`${k} board subscribe ${s.status}`);
  }
  for (const [k, u] of [['B', B], ['V', V]]) {
    const s = await subscribe(u.c, `notifications:${u.id}`, P, ev[k], { tables: ['notifications'], recipient: u.id });
    channels.push([u.c, s.ch]); if (s.status !== 'SUBSCRIBED') throw new Error(`${k} notifications subscribe ${s.status}`);
  }

  // ---- presence on the PRIVATE project channel ---------------------------------------------
  const pres = {};
  const pA = await subscribe(A.c, `project:${P}`, P, pres, { presence: true, config: { private: true, presence: { key: A.id } } });
  const pA2 = await subscribe(A2, `project:${P}`, P, {}, { presence: true, config: { private: true, presence: { key: A.id } } });
  const presB = {};
  const pB = await subscribe(B.c, `project:${P}`, P, presB, { presence: true, config: { private: true, presence: { key: B.id } } });
  channels.push([A.c, pA.ch], [A2, pA2.ch], [B.c, pB.ch]);
  check(pA.status === 'SUBSCRIBED' && pB.status === 'SUBSCRIBED', 'members join the private presence channel');
  await pA.ch.track({ user_id: A.id, name: A.name, idle: false });
  await pA2.ch.track({ user_id: A.id, name: A.name, idle: true });
  await pB.ch.track({ user_id: B.id, name: B.name, idle: false });
  check(await waitFor(() => presB.presence && presB.presence[A.id]?.length === 2), 'B sees A as present with 2 sessions (two tabs)');
  const presC = {};
  const pC = await subscribe(C.c, `project:${P}`, P, presC, { presence: true, config: { private: true, presence: { key: C.id } } });
  channels.push([C.c, pC.ch]);
  check(pC.status !== 'SUBSCRIBED', `outsider is refused on the private presence channel (${pC.status})`);
  if (pC.status === 'SUBSCRIBED') await pC.ch.track({ user_id: C.id, name: 'spy' });
  await sleep(1500);
  check(!presB.presence?.[C.id], 'outsider never appears in the presence list');
  check(!presC.presence || !presC.presence[A.id], 'outsider cannot see who is present');
  await A2.removeChannel(pA2.ch);
  check(await waitFor(() => presB.presence && presB.presence[A.id]?.length === 1), 'closing a tab drops that session from presence');

  // ---- 2. A creates a task -> B sees it without refreshing ---------------------------------
  const K = `${P}-k1`;
  { const { error } = await A.c.from('cards').insert({ id: K, column_id: `${P}-todo`, title: 'Navrhnout logo' }); if (error) throw error; }
  check(await waitFor(() => (ev.B.cards ?? []).some((p) => p.eventType === 'INSERT' && p.new.id === K)), 'B receives the new task in realtime');
  // ---- 3. B changes status -> A sees it ----------------------------------------------------
  { const { error } = await B.c.from('cards').update({ column_id: `${P}-done` }).eq('id', K); if (error) throw error; }
  check(await waitFor(() => (ev.A.cards ?? []).some((p) => p.eventType === 'UPDATE' && p.new.id === K && p.new.column_id === `${P}-done`)), 'A receives B\'s status change in realtime');
  // ---- 4. assignment + deadline ------------------------------------------------------------
  const { data: bMember } = await A.c.from('workspace_members').select('id').eq('profile_id', B.id).eq('owner_id', A.id).single();
  { const { error } = await A.c.from('card_assignees').insert({ card_id: K, member_id: bMember.id, position: 0 }); if (error) throw error; }
  { const { error } = await A.c.from('cards').update({ due_date: '2026-12-15' }).eq('id', K); if (error) throw error; }
  check(await waitFor(() => (ev.B.cards ?? []).some((p) => p.eventType === 'UPDATE' && p.new.id === K && p.new.child_rev >= 1)), 'assignment reaches B as a card child_rev signal');
  check(await waitFor(() => (ev.B.cards ?? []).some((p) => p.new?.due_date === '2026-12-15')), 'deadline change reaches B');
  check(await waitFor(() => (ev.B.notifications ?? []).some((p) => p.new?.type === 'assignment' && p.new?.card_id === K)), 'B gets an assignment notification in realtime');

  // ---- 6/7. comment with mention -> realtime + notification for the right person only -------
  { const { error } = await A.c.from('task_comments').insert({ id: `${P}-c1`, card_id: K, author_name: 'spoof', content: 'Vero, @Vera Viewer koukni', mentions: [V.id, C.id] }); if (error) throw error; }
  check(await waitFor(() => (ev.V.notifications ?? []).some((p) => p.new?.type === 'mention')), 'mentioned viewer V gets a mention notification in realtime');
  const { data: cNotes } = await C.c.from('notifications').select('id');
  check((cNotes ?? []).length === 0, 'mentioned OUTSIDER gets nothing (mention filtered to project members)');
  const { data: comment } = await B.c.from('task_comments').select('author_id, author_name').eq('id', `${P}-c1`).single();
  check(comment?.author_id === A.id && comment?.author_name === 'Alena Owner', 'comment author is server-verified (spoofed name ignored)');
  check(await waitFor(() => (ev.B.cards ?? []).filter((p) => p.new?.id === K).length >= 4), 'comment change also signals B via the card');

  // ---- 5. activity visible to both ----------------------------------------------------------
  await sleep(500);
  for (const u of [A, B]) {
    const { data } = await u.c.from('activity_logs').select('action_type, actor_name').eq('project_id', P);
    const types = new Set((data ?? []).map((r) => r.action_type));
    check(['card_created', 'card_moved', 'card_assigned', 'card_due_changed', 'comment_added', 'member_added'].every((t) => types.has(t)), `${u.name} sees the project activity (${[...types].sort().join(',')})`);
  }
  check(await waitFor(() => (ev.B.activity_logs ?? []).some((p) => p.new?.action_type === 'comment_added')), 'activity events stream to B in realtime');

  // ---- 9. simultaneous edits: version check -------------------------------------------------
  const { data: cur } = await A.c.from('cards').select('version').eq('id', K).single();
  const [ra, rb] = await Promise.all([
    A.c.from('cards').update({ title: 'Logo (A)' }).eq('id', K).eq('version', cur.version).select('id'),
    B.c.from('cards').update({ title: 'Logo (B)' }).eq('id', K).eq('version', cur.version).select('id'),
  ]);
  const winners = [ra, rb].filter((r) => (r.data ?? []).length === 1).length;
  check(winners === 1, 'two simultaneous versioned saves: exactly one wins, the other is detected as a conflict (no silent overwrite)');

  // ---- 12. viewer cannot write --------------------------------------------------------------
  { const { error } = await V.c.from('cards').insert({ id: `${P}-v`, column_id: `${P}-todo`, title: 'x' }); check(error?.code === '42501', 'viewer cannot create a task'); }
  { const { error } = await V.c.from('cards').update({ title: 'hack' }).eq('id', K); check(error?.code === '42501', 'viewer cannot edit a task'); }
  { const { error } = await V.c.from('task_comments').insert({ id: `${P}-vc`, card_id: K, author_name: 'v', content: 'x' }); check(error?.code === '42501', 'viewer cannot comment'); }
  { const { error } = await V.c.rpc('set_project_member', { p_project_id: P, p_member_id: bMember.id, p_role: 'viewer' }); check(Boolean(error), 'viewer cannot change roles'); }
  { const { data } = await V.c.from('cards').select('id').eq('id', K); check((data ?? []).length === 1, 'viewer can read the task'); }

  // ---- 11. outsider: no data, no events ------------------------------------------------------
  { const { data } = await C.c.from('cards').select('id').eq('project_id', P); check((data ?? []).length === 0, 'outsider cannot read tasks'); }
  { const { data } = await C.c.from('activity_logs').select('id').eq('project_id', P); check((data ?? []).length === 0, 'outsider cannot read the activity'); }
  { const { error } = await C.c.from('cards').insert({ id: `${P}-c`, column_id: `${P}-todo`, title: 'x' }); check(Boolean(error), 'outsider cannot write'); }
  check(rowsWithData(Object.values(ev.C).flat()).length === 0, `outsider received NO row data over realtime (${Object.values(ev.C).flat().length} payloads)`);

  // ---- duplicates: one change = one event per subscriber -------------------------------------
  await sleep(1500); // let events of the concurrent saves above settle
  const isHigh = (p) => p.eventType === 'UPDATE' && p.new?.id === K && p.new?.priority === 'High' && p.old?.priority !== 'High';
  { const { error } = await B.c.from('cards').update({ priority: 'High' }).eq('id', K); if (error) throw error; }
  await waitFor(() => (ev.A.cards ?? []).some(isHigh)); await sleep(1500);
  const n = (ev.A.cards ?? []).filter((p) => p.eventType === 'UPDATE' && p.new?.id === K && p.new?.priority === 'High' && p.new?.version === (ev.A.cards ?? []).find(isHigh)?.new?.version).length;
  check(n === 1, `one update produces exactly one realtime event per subscriber (got ${n})`);

  // ---- 13. removal revokes access and realtime visibility ----------------------------------
  const { data: rMember } = await A.c.from('workspace_members').select('id').eq('profile_id', R.id).eq('owner_id', A.id).single();
  const rBefore = (ev.R.cards ?? []).length;
  check(rBefore > 0, `member R was receiving events before removal (${rBefore})`);
  { const { error } = await A.c.rpc('remove_project_member', { p_project_id: P, p_member_id: rMember.id }); if (error) throw error; }
  await sleep(800);
  const rAfterRemoval = (ev.R.cards ?? []).length;
  { const { error } = await A.c.from('cards').update({ title: 'Po odebrání' }).eq('id', K); if (error) throw error; }
  await waitFor(() => (ev.B.cards ?? []).some((p) => p.new?.title === 'Po odebrání'));
  await sleep(1500);
  check(rowsWithData((ev.R.cards ?? []).slice(rAfterRemoval)).length === 0, 'removed member receives no further task data in realtime');
  { const { data } = await R.c.from('cards').select('id').eq('project_id', P); check((data ?? []).length === 0, 'removed member can no longer read tasks'); }
  { const { data } = await R.c.rpc('project_role', { p_project_id: P }); check(data === null, 'removed member has no role'); }
  { const { data } = await R.c.from('notifications').select('type'); check((data ?? []).every((n) => n.type === 'project_removed') && (data ?? []).length === 1, 'removed member keeps only the removal notice'); }

  // ---- 10. reconnect: changes made while B was offline are reconciled by the re-read --------
  const bBoard = channels.find(([c, ch]) => c === B.c && ch.topic === `realtime:board:${P}:B`);
  await B.c.removeChannel(bBoard[1]);
  { const { error } = await A.c.from('cards').update({ title: 'Změna během výpadku' }).eq('id', K); if (error) throw error; }
  const evB2 = {};
  const s2 = await subscribe(B.c, `board:${P}:B2`, P, evB2, { tables: ['cards'] });
  channels.push([B.c, s2.ch]);
  { const { data } = await B.c.from('cards').select('title, version').eq('id', K).single(); check(s2.status === 'SUBSCRIBED' && data?.title === 'Změna během výpadku', 'after reconnecting, the re-read shows the change made while offline'); }
  { const { error } = await A.c.from('cards').update({ title: 'Po obnovení' }).eq('id', K); if (error) throw error; }
  check(await waitFor(() => (evB2.cards ?? []).some((p) => p.new?.title === 'Po obnovení')), 'live events resume after reconnecting');

  // ---- 15. refresh preserves authoritative state --------------------------------------------
  { const { data } = await B.c.from('cards').select('title, column_id, due_date, priority').eq('id', K).single();
    check(data?.title === 'Po obnovení' && data?.column_id === `${P}-done` && data?.due_date === '2026-12-15' && data?.priority === 'High', 'persisted state matches what was synchronized'); }
} catch (e) {
  bad(`error: ${e?.message ?? JSON.stringify(e)}`);
} finally {
  for (const [c, ch] of channels) { try { await c.removeChannel(ch); } catch { /* already gone */ } }
  const d = await A.c.from('projects').delete().eq('id', P);
  if (d.error) bad(`cleanup failed: ${d.error.message}`); else console.log('cleanup: project deleted');
  for (const c of [A.c, A2, B.c, V.c, R.c, C.c]) c.realtime.disconnect();
}
console.log(`${passed} passed, ${failed} failed`);
console.log(failed ? 'COLLABORATION REALTIME CHECKS FAILED' : 'ALL COLLABORATION REALTIME CHECKS PASSED');
process.exit(failed ? 1 : 0);
