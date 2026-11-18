// HTTP-level auth / isolation / invitation / AI-quota / restore regression against a REAL
// local Supabase stack (GoTrue + PostgREST behind Kong). Zero dependencies (Node fetch).
// No Gemini, no e-mail delivery. Run via real_stack.sh (it refuses non-local URLs).
//
//   API_URL=http://127.0.0.1:55421 ANON_KEY=... [SERVICE_ROLE_KEY=...] node http_regression.mjs
import assert from 'node:assert/strict';

const API = process.env.API_URL;
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_ROLE_KEY;
if (!API || !ANON || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(API)) {
  console.error('refusing to run: API_URL must be a local http://127.0.0.1:<port> stack');
  process.exit(2);
}

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`ok - ${msg}`); };

async function call(path, { method = 'GET', token, key = ANON, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function signUp(email) {
  // With the local service role the account is created CONFIRMED through GoTrue's admin API, which works whether
  // or not "Confirm email" is enabled; the browser specs cover the real sign-up (incl. the confirmation mail).
  if (SERVICE) {
    const c = await call('/auth/v1/admin/users', { method: 'POST', key: SERVICE, body: { email, password: PASSWORD, email_confirm: true } });
    assert.equal(c.status, 200, `admin create ${email}: ${JSON.stringify(c.json)}`);
    const l = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    return { id: l.json.user.id, email, token: l.json.access_token, refresh: l.json.refresh_token };
  }
  const r = await call('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, `signup ${email}: ${JSON.stringify(r.json)}`);
  assert.ok(r.json.access_token, 'signup returned a session (needs auto-confirm, or pass SERVICE_ROLE_KEY)');
  return { id: r.json.user.id, email, token: r.json.access_token, refresh: r.json.refresh_token };
}
const rpc = (name, args, token) => call(`/rest/v1/rpc/${name}`, { method: 'POST', token, body: args });
const denied = (r) => [401, 403].includes(r.status) && (r.json?.code === '42501' || /permission denied|row-level security/i.test(r.json?.message ?? ''));

// ---------------------------------------------------------------- authentication
const A = await signUp(`a-${run}@example.test`);
const B = await signUp(`b-${run}@example.test`);
const C = await signUp(`c-${run}@example.test`);
ok('three isolated, confirmed test accounts created through real GoTrue (local stack, no e-mail leaves the machine)');

{
  const bad = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: A.email, password: 'wrong-password' } });
  assert.equal(bad.status, 400);
  const good = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: A.email, password: PASSWORD } });
  assert.equal(good.status, 200);
  assert.ok(good.json.access_token);
  ok('login: wrong password rejected, correct password returns a session');

  const me = await call('/auth/v1/user', { token: good.json.access_token });
  assert.equal(me.json.email, A.email);
  ok('session token identifies the user (auth.getUser, the call the AI gateway makes)');

  const refreshed = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: good.json.refresh_token } });
  assert.equal(refreshed.status, 200);
  ok('session persistence: a refresh token yields a new access token');

  const out = await call('/auth/v1/logout', { method: 'POST', token: refreshed.json.access_token });
  assert.ok([200, 204].includes(out.status));
  const again = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshed.json.refresh_token } });
  assert.notEqual(again.status, 200);
  ok('logout revokes the refresh token (session cannot be silently renewed)');
}

// ---------------------------------------------------------------- anonymous surface
for (const t of ['profiles', 'projects', 'columns', 'cards', 'workspace_members', 'invitations', 'ai_requests']) {
  const r = await call(`/rest/v1/${t}?select=*`);
  assert.ok(denied(r), `anon must not read ${t}: ${r.status} ${JSON.stringify(r.json)}`);
}
ok('anon (public key only) is denied on every table, incl. profiles/invitations/ai_requests');
{
  const r = await rpc('invitation_preview', { p_token: 'x'.repeat(64) });
  assert.equal(r.status, 200);
  assert.equal(r.json[0].state, 'invalid');
  assert.equal(r.json[0].masked_email, null);
  const acc = await rpc('accept_workspace_invitation', { p_token: 'x'.repeat(64), p_display_name: 'x' });
  assert.ok(denied(acc), 'anon cannot accept');
  const make = await rpc('create_workspace_invitation', { p_email: 'x@example.test' });
  assert.ok(denied(make), 'anon cannot create invitations');
  ok('anon may only call invitation_preview (and learns nothing from an unknown token)');
}

// ---------------------------------------------------------------- isolation (RLS through PostgREST)
const P = `p-${run}`;
{
  // The app inserts projects WITHOUT RETURNING. With `Prefer: return=representation` PostgREST also
  // applies the SELECT policy to the new row, and is_project_member() (a STABLE function) cannot see
  // a row of the statement that is still running -> 403. Pre-existing behaviour of the baseline,
  // documented in docs/MIGRATION_RUNBOOK.md; do not add .select() to project inserts.
  const proj = await call('/rest/v1/projects', { method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' }, body: { id: P, name: 'A project' } });
  assert.equal(proj.status, 201, JSON.stringify(proj.json));
  const created = await call(`/rest/v1/projects?id=eq.${P}&select=user_id`, { token: A.token });
  assert.equal(created.json[0].user_id, A.id, 'user_id defaults to the caller');
  await call('/rest/v1/columns', { method: 'POST', token: A.token, body: { id: `${P}-c`, project_id: P, name: 'Todo', position: 0 } });
  const card = await call('/rest/v1/cards', { method: 'POST', token: A.token, body: { id: `${P}-k`, column_id: `${P}-c`, title: 'A secret card' } });
  assert.equal(card.status, 201, JSON.stringify(card.json));
  ok('owner creates project / column / card');

  const bProjects = await call('/rest/v1/projects?select=*', { token: B.token });
  assert.deepEqual(bProjects.json, []);
  const bCards = await call('/rest/v1/cards?select=*', { token: B.token });
  assert.deepEqual(bCards.json, []);
  const bProfiles = await call('/rest/v1/profiles?select=id,email', { token: B.token });
  assert.deepEqual(bProfiles.json.map((p) => p.id), [B.id]);
  const bMembers = await call(`/rest/v1/workspace_members?owner_id=eq.${A.id}&select=*`, { token: B.token });
  assert.deepEqual(bMembers.json, []);
  ok('cross-workspace: B sees none of A\'s projects/cards/members and only its own profile');

  const forged = await call('/rest/v1/cards', { method: 'POST', token: B.token, body: { id: `${P}-evil`, column_id: `${P}-c`, title: 'x' } });
  assert.ok(denied(forged), `B must not write into A's column: ${forged.status}`);
  const patch = await call(`/rest/v1/cards?id=eq.${P}-k`, { method: 'PATCH', token: B.token, headers: { Prefer: 'return=representation' }, body: { title: 'hacked' } });
  assert.deepEqual(patch.json, []);
  const del = await call(`/rest/v1/projects?id=eq.${P}`, { method: 'DELETE', token: B.token, headers: { Prefer: 'return=representation' } });
  assert.deepEqual(del.json, []);
  const aStill = await call(`/rest/v1/cards?id=eq.${P}-k&select=title`, { token: A.token });
  assert.equal(aStill.json[0].title, 'A secret card');
  ok('B cannot insert into / update / delete A\'s data; A\'s card is unchanged');

  const force = await call('/rest/v1/workspace_members', { method: 'POST', token: A.token, body: { id: `m-force-${run}`, owner_id: A.id, profile_id: B.id, full_name: 'Victim', initials: 'V' } });
  assert.ok(denied(force), 'cannot link another account to a member row');
  ok('forced membership (linking another account) is refused');
}

// ---------------------------------------------------------------- invitations (real accounts)
{
  const make = await rpc('create_workspace_invitation', { p_email: B.email }, A.token);
  assert.equal(make.status, 200, JSON.stringify(make.json));
  const { id: invId, token: invToken } = make.json[0];
  assert.match(invToken, /^[0-9a-f]{64}$/);
  ok('invitation created: 256-bit token returned once');

  const listAll = await call('/rest/v1/invitations?select=*', { token: A.token });
  assert.ok(denied(listAll), 'select=* is refused (token_hash is column-protected)');
  const list = await call('/rest/v1/invitations?select=id,email,status,expires_at', { token: A.token });
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].status, 'pending');
  const direct = await call('/rest/v1/invitations', { method: 'POST', token: A.token, body: { id: 'inv-x', workspace_id: A.id, email: 'q@example.test', token_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 1e8).toISOString() } });
  assert.ok(denied(direct), 'direct INSERT refused');
  ok('invitation table: no token material readable, no direct insert');

  const prev = await rpc('invitation_preview', { p_token: invToken });
  assert.equal(prev.json[0].state, 'valid');
  assert.match(prev.json[0].masked_email, /^b\*\*\*@example\.test$/);
  ok('anonymous preview exposes only state + masked e-mail + inviter name');

  const wrong = await rpc('accept_workspace_invitation', { p_token: invToken, p_display_name: 'C' }, C.token);
  assert.equal(wrong.status >= 400, true);
  assert.match(wrong.json.message, /jiný e-mail/);
  ok('a different account cannot accept (e-mail binding)');

  const accept = await rpc('accept_workspace_invitation', { p_token: invToken, p_display_name: 'Bee' }, B.token);
  assert.equal(accept.status, 200, JSON.stringify(accept.json));
  assert.equal(accept.json, A.id);
  const again = await rpc('accept_workspace_invitation', { p_token: invToken, p_display_name: 'Bee' }, B.token);
  assert.match(again.json.message, /použita/);
  ok('invitee accepts; the token is single-use');

  const bBefore = await call('/rest/v1/projects?select=id', { token: B.token });
  assert.deepEqual(bBefore.json, []);
  const myMember = await call(`/rest/v1/workspace_members?owner_id=eq.${A.id}&profile_id=eq.${B.id}&select=id,workspace_role`, { token: A.token });
  assert.equal(myMember.json[0].workspace_role, 'member');
  const link = await call('/rest/v1/project_members', { method: 'POST', token: A.token, body: { project_id: P, member_id: myMember.json[0].id } });
  assert.equal(link.status, 201, JSON.stringify(link.json));
  const bAfter = await call('/rest/v1/projects?select=id', { token: B.token });
  assert.deepEqual(bAfter.json.map((p) => p.id), [P]);
  ok('accepting grants no data by itself; access starts when the owner adds the member to a project');

  const bDel = await call(`/rest/v1/projects?id=eq.${P}`, { method: 'DELETE', token: B.token, headers: { Prefer: 'return=representation' } });
  assert.deepEqual(bDel.json, []);
  const bAddM = await call('/rest/v1/project_members', { method: 'POST', token: B.token, body: { project_id: P, member_id: myMember.json[0].id } });
  assert.ok(denied(bAddM));
  ok('a member cannot delete the project or manage its roster');

  // revoked
  const m2 = await rpc('create_workspace_invitation', { p_email: C.email }, A.token);
  // (return=minimal like the app's `.update(...)`: a RETURNING * would need SELECT on token_hash, which clients lack)
  const rev = await call(`/rest/v1/invitations?id=eq.${m2.json[0].id}`, { method: 'PATCH', token: A.token, headers: { Prefer: 'return=minimal' }, body: { status: 'rejected' } });
  assert.equal(rev.status, 204, JSON.stringify(rev.json));
  const revNow = await call(`/rest/v1/invitations?id=eq.${m2.json[0].id}&select=status`, { token: A.token });
  assert.equal(revNow.json[0].status, 'rejected');
  const revAcc = await rpc('accept_workspace_invitation', { p_token: m2.json[0].token, p_display_name: 'C' }, C.token);
  assert.match(revAcc.json.message, /použita nebo zrušena/);
  ok('a revoked invitation cannot be accepted');

  // expired (the client cannot set expiry; use the local service role to age the row)
  if (SERVICE) {
    const m3 = await rpc('create_workspace_invitation', { p_email: C.email }, A.token);
    const age = await call(`/rest/v1/invitations?id=eq.${m3.json[0].id}`, { method: 'PATCH', key: SERVICE, headers: { Prefer: 'return=representation' }, body: { expires_at: new Date(Date.now() - 60_000).toISOString() } });
    assert.equal(age.json.length, 1, JSON.stringify(age.json));
    const pv = await rpc('invitation_preview', { p_token: m3.json[0].token });
    assert.equal(pv.json[0].state, 'expired');
    const expAcc = await rpc('accept_workspace_invitation', { p_token: m3.json[0].token, p_display_name: 'C' }, C.token);
    assert.match(expAcc.json.message, /vypršela/);
    ok('an expired invitation previews as expired and cannot be accepted');
  } else {
    console.log('skip - expiry check needs SERVICE_ROLE_KEY');
  }
}

// ---------------------------------------------------------------- AI quota over real HTTP concurrency
{
  const args = { p_feature: 'chat', p_project_id: null, p_reserved_tokens: 10, p_limit_per_minute: 3, p_global_limit_per_minute: 1000, p_daily_token_budget: 100000 };
  const results = await Promise.all(Array.from({ length: 8 }, () => rpc('ai_reserve', args, C.token)));
  const allowed = results.filter((r) => r.json?.[0]?.allowed === true).length;
  const limited = results.filter((r) => r.json?.[0]?.reason === 'rate_limited').length;
  assert.equal(allowed, 3, `exactly 3 reservations must pass, got ${allowed}`);
  assert.equal(limited, 5);
  ok('8 parallel HTTP reservations at a limit of 3 => exactly 3 allowed (no race bypass)');

  const forbidden = await rpc('ai_reserve', { ...args, p_project_id: P, p_limit_per_minute: 50 }, C.token);
  assert.equal(forbidden.json[0].reason, 'forbidden');
  ok('a stranger cannot reserve AI quota against someone else\'s project');

  const direct = await call('/rest/v1/ai_requests', { method: 'POST', token: C.token, body: { user_id: C.id, feature: 'x' } });
  assert.ok(denied(direct));
  const own = await call('/rest/v1/ai_requests?select=feature,status', { token: C.token });
  assert.equal(own.json.length, 3);
  const bSees = await call('/rest/v1/ai_requests?select=id', { token: B.token });
  assert.deepEqual(bSees.json, []);
  ok('the ledger is read-only for clients and visible only to its owner');
}

// ---------------------------------------------------------------- restore (atomicity + authorisation)
{
  const board = { columns: [{ id: `${P}-n1`, name: 'Restored', cards: [{ id: `${P}-nk1`, title: 'Restored card' }] }] };
  const bRestore = await rpc('restore_project_board', { p_project_id: P, p_board: board }, B.token);
  assert.ok(bRestore.status >= 400);
  assert.equal(bRestore.json.code, '42501');
  ok('a plain project member cannot restore (wipe) the board');

  const bad = { columns: [{ id: `${P}-bad`, name: 'X', cards: [{ id: 'dup-' + run, title: 'a' }, { id: 'dup-' + run, title: 'b' }] }] };
  const fail = await rpc('restore_project_board', { p_project_id: P, p_board: bad }, A.token);
  assert.ok(fail.status >= 400);
  const intact = await call(`/rest/v1/cards?id=eq.${P}-k&select=title`, { token: A.token });
  assert.equal(intact.json[0].title, 'A secret card');
  ok('a failing restore rolls back completely (original card still there)');

  const good = await rpc('restore_project_board', { p_project_id: P, p_board: board }, A.token);
  assert.equal(good.status, 200, JSON.stringify(good.json));
  const after = await call(`/rest/v1/cards?select=id&column_id=like.${P}-*`, { token: A.token });
  assert.deepEqual(after.json.map((c) => c.id), [`${P}-nk1`]);
  ok('the owner can restore: board replaced atomically');
}

// ---------------------------------------------------------------- account erasure (B3a defect: GoTrue answered 500)
if (SERVICE) {
  const D = await signUp(`d-${run}@example.test`);
  const PD = `del-${run}`;
  const mk = await call('/rest/v1/projects', { method: 'POST', token: D.token, headers: { Prefer: 'return=minimal' }, body: { id: PD, name: 'Erasure' } });
  assert.equal(mk.status, 201, JSON.stringify(mk.json));
  const meet = await call('/rest/v1/meetings?select=id,created_by', { method: 'POST', token: D.token, headers: { Prefer: 'return=representation' }, body: { project_id: PD, title: 'Porada před smazáním účtu', source_kind: 'text' } });
  assert.equal(meet.status, 201, JSON.stringify(meet.json));
  const mid = meet.json[0].id;
  assert.equal(meet.json[0].created_by, D.id);
  // an ordinary user can neither wipe nor re-assign the author through PostgREST
  const wipe = await call(`/rest/v1/meetings?id=eq.${mid}`, { method: 'PATCH', token: D.token, body: { created_by: null } });
  assert.ok(wipe.status >= 400, 'a user must not be able to wipe created_by');
  ok('a user cannot change meetings.created_by over HTTP (column privilege)');
  const del = await call(`/auth/v1/admin/users/${D.id}`, { method: 'DELETE', key: SERVICE });
  assert.equal(del.status, 200, `GoTrue admin delete of a meeting author must succeed: ${JSON.stringify(del.json)}`);
  const left = await call(`/rest/v1/meetings?id=eq.${mid}&select=id,title,created_by`, { key: SERVICE });
  assert.equal(left.json.length, 0, 'the project (owned by the deleted user) and its meeting are removed with the account');
  ok('real GoTrue: deleting a user who created a meeting succeeds (HTTP 200, no 500)');
  // the author is deleted but the PROJECT stays: a member creates a meeting in A\'s project, then that member is deleted
  const mem = await signUp(`m-${run}@example.test`);
  const pm = `delm-${run}`;
  assert.equal((await call('/rest/v1/projects', { method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' }, body: { id: pm, name: 'Member erasure' } })).status, 201);
  const wmId = (await call(`/rest/v1/workspace_members?profile_id=eq.${mem.id}&select=id`, { key: SERVICE })).json[0].id;
  assert.equal((await call('/rest/v1/project_members', { method: 'POST', key: SERVICE, headers: { Prefer: 'return=minimal' }, body: { project_id: pm, member_id: wmId } })).status, 201);
  const m2 = await call('/rest/v1/meetings?select=id', { method: 'POST', token: mem.token, headers: { Prefer: 'return=representation' }, body: { project_id: pm, title: 'Porada člena', source_kind: 'text' } });
  assert.equal(m2.status, 201, JSON.stringify(m2.json));
  const del2 = await call(`/auth/v1/admin/users/${mem.id}`, { method: 'DELETE', key: SERVICE });
  assert.equal(del2.status, 200, JSON.stringify(del2.json));
  const kept = await call(`/rest/v1/meetings?id=eq.${m2.json[0].id}&select=title,created_by`, { token: A.token });
  assert.deepEqual(kept.json, [{ title: 'Porada člena', created_by: null }]);
  ok('real GoTrue: a deleted member\'s meeting stays in the owner\'s project with created_by = null');
}

console.log(`HTTP REGRESSION PASSED (${passed} checks)`);
