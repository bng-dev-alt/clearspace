// Synthetic collaboration fixture for the LOCAL collab stack only (scripts/collab-stack.sh seed). Idempotent.
// alice (owner) shares "Společný projekt" with bob (editor) and vera (viewer) through the real invitation flow.
import { createClient } from '@supabase/supabase-js';

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY, COLLAB_PASSWORD } = process.env;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API_URL ?? '')) { console.error('refusing: not a local stack'); process.exit(2); }
if (!ANON_KEY || !SERVICE_ROLE_KEY || !COLLAB_PASSWORD) { console.error('missing env'); process.exit(2); }

const admin = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const people = [
  { email: 'alice@collab.test', name: 'Alice Owner' },
  { email: 'bob@collab.test', name: 'Bob Editor' },
  { email: 'vera@collab.test', name: 'Vera Viewer' },
];
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
for (const p of people) {
  const existing = list.users.find((u) => u.email === p.email);
  if (existing) await admin.auth.admin.updateUserById(existing.id, { password: COLLAB_PASSWORD });
  else {
    const { error } = await admin.auth.admin.createUser({ email: p.email, password: COLLAB_PASSWORD, email_confirm: true, user_metadata: { display_name: p.name } });
    if (error) throw error;
  }
}
const signIn = async (email) => {
  const c = createClient(API_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: COLLAB_PASSWORD });
  if (error) throw error;
  return { c, id: data.user.id };
};
const alice = await signIn('alice@collab.test');
const P = 'project-collab-demo';
const { data: exists } = await alice.c.from('projects').select('id').eq('id', P).maybeSingle();
if (!exists) {
  for (const q of [
    alice.c.from('projects').insert({ id: P, name: 'Společný projekt' }),
    alice.c.from('columns').insert([
      { id: `${P}-column-0`, project_id: P, name: 'Nápady', position: 0 },
      { id: `${P}-column-1`, project_id: P, name: 'Naplánováno', position: 1 },
      { id: `${P}-column-2`, project_id: P, name: 'V průběhu', position: 2 },
      { id: `${P}-column-3`, project_id: P, name: 'K revizi', position: 3 },
      { id: `${P}-column-4`, project_id: P, name: 'Hotovo', position: 4 },
    ]),
    alice.c.from('project_members').insert({ project_id: P, member_id: `member-owner-${alice.id}` }),
    alice.c.from('cards').insert({ id: `${P}-card-1`, column_id: `${P}-column-1`, title: 'Připravit podklady pro klienta', details: '' }),
  ]) { const { error } = await q; if (error) throw error; }
  for (const [email, role] of [['bob@collab.test', 'member'], ['vera@collab.test', 'viewer']]) {
    const { data, error } = await alice.c.rpc('create_project_invitation', { p_project_id: P, p_email: email, p_role: role });
    if (error) throw error;
    const u = await signIn(email);
    const r = await u.c.rpc('accept_workspace_invitation', { p_token: (Array.isArray(data) ? data[0] : data).token, p_display_name: people.find((p) => p.email === email).name });
    if (r.error) throw r.error;
  }
}
console.log(`seeded: project ${P} (http://127.0.0.1:${process.env.PORT ?? 3431}/projects/${P})`);
