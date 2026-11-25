// RUN 01B -- invitation e-mail lifecycle end to end on the LOCAL collab stack: the real app route
// (/api/collab/invitations), real SMTP to the stack's Mailpit (capture only, nothing leaves the machine), real GoTrue
// accounts. No mocked provider.
//   APP_URL=http://127.0.0.1:3431 RT_URL=... RT_ANON=... MAILPIT_URL=http://127.0.0.1:55534 DB_CONTAINER=supabase_db_cs-collab-sb \
//   APP_LOG=<path of the app's log> node supabase/tests/invite_email.mjs        (run from frontend/)
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const { APP_URL, RT_URL, RT_ANON, MAILPIT_URL, DB_CONTAINER, APP_LOG } = process.env;
for (const [k, v] of Object.entries({ APP_URL, RT_URL, RT_ANON, MAILPIT_URL, DB_CONTAINER })) if (!v) { console.error(`missing ${k}`); process.exit(2); }
for (const u of [APP_URL, RT_URL, MAILPIT_URL]) if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(u)) { console.error(`refusing non-local ${u}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36);
let passed = 0, failed = 0;
const check = (c, m) => { if (c) { passed += 1; console.log('ok -', m); } else { failed += 1; console.log('FAIL -', m); } };
const PASS = 'Invite-Pass-123';
const sql = (q) => execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', q]).toString().trim();

async function account(tag, name) {
  const c = createClient(RT_URL, RT_ANON, { auth: { persistSession: false } });
  const email = `${tag}-${run}@example.test`;
  const { data, error } = await c.auth.signUp({ email, password: PASS, options: { data: { display_name: name } } });
  if (error || !data.session) throw new Error(`signup ${tag}: ${error?.message}`);
  return { c, id: data.user.id, email, token: data.session.access_token };
}
async function api(path, token, body) {
  const res = await fetch(`${APP_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function mailsTo(addr) {
  const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${addr}"`)}`);
  const j = await res.json();
  return j.messages ?? [];
}
async function message(id) { return (await fetch(`${MAILPIT_URL}/api/v1/message/${id}`)).json(); }
const tokenFrom = (text) => /accept-invite\?token=([0-9a-f]{64})/.exec(text)?.[1] ?? null;
async function waitMails(addr, n, ms = 10000) { const end = Date.now() + ms; let m = []; while (Date.now() < end) { m = await mailsTo(addr); if (m.length >= n) break; await sleep(300); } return m; }
const preview = async (c, t) => (await c.rpc('invitation_preview', { p_token: t })).data?.[0]?.state;

const P = `mail-${run}`;
const A = await account('mail-owner', 'Alžběta Vlastníková');
const Bm = await account('mail-editor', 'Bořek Editor');
try {
  await A.c.from('projects').insert({ id: P, name: 'Rekonstrukce kanceláře' });
  await A.c.from('columns').insert({ id: `${P}-c`, project_id: P, name: 'K řešení', position: 0 });
  await A.c.from('project_members').insert({ project_id: P, member_id: `member-owner-${A.id}` });
  // B becomes an editor (cannot invite)
  { const { data } = await A.c.rpc('create_project_invitation', { p_project_id: P, p_email: Bm.email, p_role: 'member' });
    await Bm.c.rpc('accept_workspace_invitation', { p_token: data[0].token, p_display_name: 'Bořek' }); }

  // ---- authorization ----
  check((await api('/api/collab/invitations', null, { projectId: P, email: 'x@firma.test', role: 'member' })).status === 401, 'unauthenticated invite -> 401');
  check((await api('/api/collab/invitations', Bm.token, { projectId: P, email: 'x@firma.test', role: 'member' })).status === 403, 'editor cannot invite -> 403');
  check((await api('/api/collab/invitations', A.token, { projectId: P, email: 'x@firma.test', role: 'owner' })).status === 400, 'role owner cannot be invited -> 400');
  check((await api('/api/collab/invitations', A.token, { projectId: 'nope', email: 'x@firma.test', role: 'member' })).status === 403, 'unknown/foreign project -> 403');

  // ---- new account: invite -> real e-mail -> register -> accept ----
  const N = `novy-${run}@example.test`;
  const r1 = await api('/api/collab/invitations', A.token, { projectId: P, email: N, role: 'member' });
  check(r1.status === 201 && r1.json.delivery?.status === 'accepted', `invite created and accepted by the mail server (${r1.status} ${r1.json.delivery?.status})`);
  check(!JSON.stringify(r1.json).includes('"token"') || r1.json.link === null, 'the response carries the link only (no separate raw token) when APP_BASE_URL is set');
  const m1 = await waitMails(N, 1);
  check(m1.length === 1, 'exactly one e-mail captured for the recipient');
  const d1 = await message(m1[0].ID);
  check(d1.To?.[0]?.Address === N, 'correct recipient');
  check(/vás zve do projektu Rekonstrukce kanceláře v ClearSpace/.test(d1.Subject), `Czech subject (${d1.Subject})`);
  check(/Alžběta Vlastníková vás zve ke spolupráci na projektu „Rekonstrukce kanceláře“/.test(d1.Text) && /Vaše role: editor/.test(d1.Text) && /Odkaz platí do/.test(d1.Text) && /Pokud pozvánku nečekáte/.test(d1.Text), 'Czech plain-text body: inviter, project, role, expiry, unexpected-invitation note');
  check(/Přijmout pozvánku/.test(d1.HTML) && /clearspace/.test(d1.HTML), 'HTML part with the accept button');
  check(d1.Text.includes(`${APP_URL}/accept-invite?token=`), `link uses the configured app URL (${APP_URL})`);
  check(/ClearSpace/.test(d1.From?.Name ?? '') && /pozvanky@/.test(d1.From?.Address ?? ''), 'From: ClearSpace sender');
  const t1 = tokenFrom(d1.Text);
  check(t1 && t1 === tokenFrom(r1.json.link), 'the e-mailed link is the same single-use link the inviter can copy');

  // duplicate send + throttled resend
  const dup = await api('/api/collab/invitations', A.token, { projectId: P, email: N.toUpperCase(), role: 'viewer' });
  check(dup.status === 429, `duplicate invite within a minute is refused (${dup.status})`);
  const early = await api(`/api/collab/invitations/${r1.json.id}/resend`, A.token);
  check(early.status === 429, `resend right after sending is throttled (${early.status})`);
  check((await mailsTo(N)).length === 1, 'still exactly one e-mail (no duplicates)');
  check((await api(`/api/collab/invitations/${r1.json.id}/resend`, Bm.token)).status === 403, 'editor cannot resend');

  // resend after a minute (simulated): new e-mail, new link, old link dead
  sql(`update public.invitation_deliveries set created_at = now() - interval '2 minutes' where invitation_id = '${r1.json.id}'`);
  const rs = await api(`/api/collab/invitations/${r1.json.id}/resend`, A.token);
  check(rs.status === 200 && rs.json.delivery?.status === 'accepted', `resend works after the throttle window (${rs.status})`);
  const m2 = await waitMails(N, 2);
  const t2 = tokenFrom((await message(m2.find((m) => m.ID !== m1[0].ID).ID)).Text);
  check(t2 && t2 !== t1, 'the re-sent e-mail carries a NEW token');
  check((await preview(A.c, t1)) === 'invalid' && (await preview(A.c, t2)) === 'valid', 'the previous link stops working, the new one is valid');
  check(sql(`select count(*) from public.invitation_deliveries where invitation_id = '${r1.json.id}' and status = 'accepted'`) === '2', 'delivery log: two accepted attempts');

  const Nc = createClient(RT_URL, RT_ANON, { auth: { persistSession: false } });
  { const { data } = await Nc.auth.signUp({ email: N, password: PASS, options: { data: { display_name: 'Nový Člen' } } }); check(Boolean(data.session), 'recipient registers a NEW account with the invited address'); }
  { const { error } = await Nc.rpc('accept_workspace_invitation', { p_token: t2, p_display_name: 'Nový Člen' }); check(!error, 'new account accepts the e-mailed invitation'); }
  check((await Nc.rpc('project_role', { p_project_id: P })).data === 'member', 'and gets the invited role');
  { const { error } = await Nc.rpc('accept_workspace_invitation', { p_token: t2, p_display_name: 'x' }); check(Boolean(error), 'the token cannot be reused'); }
  check((await api(`/api/collab/invitations/${r1.json.id}/resend`, A.token)).status === 400, 'an accepted invitation cannot be re-sent');

  // ---- existing account + wrong account ----
  const E = await account('mail-existing', 'Eva Existující');
  const W = await account('mail-wrong', 'Walter Cizí');
  const r2 = await api('/api/collab/invitations', A.token, { projectId: P, email: E.email, role: 'viewer' });
  const t3 = tokenFrom((await message((await waitMails(E.email, 1))[0].ID)).Text);
  check(r2.status === 201 && Boolean(t3), 'existing account receives the invitation e-mail');
  { const { error } = await W.c.rpc('accept_workspace_invitation', { p_token: t3, p_display_name: 'W' }); check(Boolean(error) && /jiný e-mail/.test(error.message), 'a different signed-in account cannot use the link'); }
  { const { error } = await E.c.rpc('accept_workspace_invitation', { p_token: t3, p_display_name: 'Eva' }); check(!error, 'the existing account accepts'); }
  check((await E.c.rpc('project_role', { p_project_id: P })).data === 'viewer', 'with the invited role (viewer)');
  { const { data } = await E.c.from('notifications').select('type'); check(!(data ?? []).some((n) => n.type === 'invitation'), 'its in-app invitation notification is cleared after acceptance'); }

  // ---- expired + revoked ----
  const X = `expiruje-${run}@example.test`;
  const r3 = await api('/api/collab/invitations', A.token, { projectId: P, email: X, role: 'member' });
  const t4 = tokenFrom((await message((await waitMails(X, 1))[0].ID)).Text);
  sql(`update public.invitations set expires_at = now() - interval '1 minute' where id = '${r3.json.id}'`);
  const Xc = createClient(RT_URL, RT_ANON, { auth: { persistSession: false } });
  await Xc.auth.signUp({ email: X, password: PASS });
  { const { error } = await Xc.rpc('accept_workspace_invitation', { p_token: t4, p_display_name: 'X' }); check(Boolean(error) && /vypršela/.test(error.message), 'an expired link is refused'); }
  sql(`update public.invitation_deliveries set created_at = now() - interval '2 minutes' where invitation_id = '${r3.json.id}'`);
  const rx = await api(`/api/collab/invitations/${r3.json.id}/resend`, A.token);
  check(rx.status === 200, 'an expired invitation can be re-sent (new link, new 7-day validity)');
  const Y = `zrusena-${run}@example.test`;
  const r4 = await api('/api/collab/invitations', A.token, { projectId: P, email: Y, role: 'member' });
  const t5 = tokenFrom((await message((await waitMails(Y, 1))[0].ID)).Text);
  await A.c.rpc('revoke_invitation', { p_invitation_id: r4.json.id });
  const Yc = createClient(RT_URL, RT_ANON, { auth: { persistSession: false } });
  await Yc.auth.signUp({ email: Y, password: PASS });
  { const { error } = await Yc.rpc('accept_workspace_invitation', { p_token: t5, p_display_name: 'Y' }); check(Boolean(error), 'a revoked link is refused'); }
  check((await api(`/api/collab/invitations/${r4.json.id}/resend`, A.token)).status === 400, 'a revoked invitation cannot be re-sent');

  // ---- provider failure ----
  // the Mailpit of THIS stack (derived from DB_CONTAINER, so a second isolated stack never stops another one's)
  const box = execFileSync('docker', ['ps', '--filter', `name=${DB_CONTAINER.replace(/^supabase_db_/, 'supabase_inbucket_')}`, '--format', '{{.Names}}']).toString().trim();
  execFileSync('docker', ['stop', box]);
  try {
    const F = `selhani-${run}@example.test`;
    const rf = await api('/api/collab/invitations', A.token, { projectId: P, email: F, role: 'member' });
    check(rf.status === 201 && rf.json.delivery?.status === 'failed', `mail server down: invitation exists, delivery reported as FAILED (${rf.json.delivery?.status})`);
    check(sql(`select d.status || ':' || d.error_code from public.invitation_deliveries d join public.invitations i on i.id = d.invitation_id where i.email = '${F}'`) === 'failed:smtp_unreachable', 'the failure is recorded with a reason');
    check(Boolean(rf.json.link), 'the inviter still gets the link to pass on manually');
  } finally {
    execFileSync('docker', ['start', box]);
  }
  await sleep(3000);

  // ---- demo-style placeholder contacts never get mail ----
  const before = (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=1`).then((r) => r.json())).messages_count;
  await A.c.from('workspace_members').insert({ id: `demo-${run}`, owner_id: A.id, full_name: 'Dana Whitfield', initials: 'DW', email: `dana.whitfield.${run}@example.com` });
  await A.c.from('project_members').insert({ project_id: P, member_id: `demo-${run}` });
  await sleep(2000);
  const after = (await fetch(`${MAILPIT_URL}/api/v1/messages?limit=1`).then((r) => r.json())).messages_count;
  check(after === before, 'adding demo placeholder members (example.com) sends no e-mail');

  // ---- tokens never in the app log ----
  if (APP_LOG && existsSync(APP_LOG)) {
    const log = readFileSync(APP_LOG, 'utf8');
    check(![t1, t2, t3, t4, t5].some((t) => t && log.includes(t)), 'no raw invitation token in the application log');
  } else console.log('  (APP_LOG not given: log check NOT TESTED)');
} catch (e) {
  failed += 1; console.log('FAIL - error:', e?.message ?? e);
} finally {
  await A.c.from('projects').delete().eq('id', P);
}
console.log(`${passed} passed, ${failed} failed`);
console.log(failed ? 'INVITATION E-MAIL CHECKS FAILED' : 'ALL INVITATION E-MAIL CHECKS PASSED');
process.exit(failed ? 1 : 0);
