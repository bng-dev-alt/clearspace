/* eslint-disable @typescript-eslint/no-explicit-any -- REST/GoTrue JSON of arbitrary shape in a verification spec */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Real-application verification against the HOSTED "ClearSpace V1" Supabase project, with "Confirm email" ON.
 * Skipped unless E2E_HOSTED=1. It is started by frontend/scripts/hosted-verify.sh, which creates the DISPOSABLE
 * accounts (already confirmed, plus one unconfirmed), passes their credentials in, and deletes them afterwards;
 * the privileged key never reaches this process. The app under test must run on loopback WITHOUT a Gemini key.
 *
 * Sign-up with e-mail delivery cannot be exercised on the hosted project (the built-in mailer only reaches
 * team members and the address domain is validated), so registration + e-mail link are covered on the local
 * stack (supabase-confirm-email.spec.ts); here we prove the hosted project REFUSES unconfirmed sign-ins.
 */
const URL_ = process.env.E2E_HOSTED_URL ?? '';
const ANON = process.env.E2E_HOSTED_ANON ?? '';
const PW = process.env.E2E_PASSWORD ?? '';
const A_EMAIL = process.env.E2E_A_EMAIL ?? '';
const B_EMAIL = process.env.E2E_B_EMAIL ?? '';
const D_EMAIL = process.env.E2E_D_EMAIL ?? '';
const EXPECTED_REF = 'twjlnsxjtuntujarwner';
test.skip(process.env.E2E_HOSTED !== '1' || !URL_ || !ANON || !PW || !A_EMAIL || !B_EMAIL, 'needs the hosted verification harness (scripts/hosted-verify.sh)');
test.describe.configure({ mode: 'serial' });

const supabaseHosts = new Set<string>();
const run = Date.now().toString(36);

async function api(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${URL_}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json: json as any, headers: res.headers() };
}
async function tokenFor(request: APIRequestContext, email: string): Promise<string> {
  const r = await api(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email, password: PW } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.access_token as string;
}
async function uiLogin(page: Page, email: string, password = PW) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
}
async function loginAs(page: Page, email: string) {
  await uiLogin(page, email);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();
}
async function openBoard(page: Page) {
  await page.goto('/projects/project-default');
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  // wait for the DATABASE board (project-scoped ids), not the first paint
  await expect(page.locator('[data-testid^="column-project-default-"]').first()).toBeVisible();
}
function watch(page: Page) {
  page.on('request', (r) => { try { const h = new URL(r.url()).hostname; if (h.endsWith('supabase.co')) supabaseHosts.add(h); } catch { /* ignore */ } });
  page.on('pageerror', (e) => console.log('BROWSER ERROR:', e.message));
  // Surface refused Supabase calls (a failed persistence call otherwise only shows up as a vanished card).
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('.supabase.co/rest/')) {
      const body = (await r.text().catch(() => '')).slice(0, 220);
      console.log(`REST ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 60)} -> ${body} | req=${(r.request().postData() ?? '').slice(0, 260)}`);
    }
  });
}

let tokenA = '';
let projectId = '';
let cols: { id: string; name: string; position: number }[] = [];
let cardId = '';

test('anonymous visitors are redirected away from protected routes', async ({ page }) => {
  watch(page);
  for (const p of ['/team', '/ai-history', '/ai-control-center']) {
    await page.goto(p);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test('Confirm email is ON: an unconfirmed account cannot sign in (API and UI)', async ({ page, request }) => {
  test.skip(!D_EMAIL, 'no unconfirmed account supplied');
  watch(page);
  const r = await api(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: D_EMAIL, password: PW } });
  expect(r.status).toBe(400);
  expect(r.json.error_code).toBe('email_not_confirmed');
  await uiLogin(page, D_EMAIL);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toHaveCount(0);
});

test('login -> session survives reload -> logout -> protected route blocked -> wrong password refused', async ({ page, request }) => {
  watch(page);
  await uiLogin(page, A_EMAIL);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible(); // persisted session
  await page.getByTestId('navbar-avatar-btn').click();
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/team');
  await expect(page).toHaveURL(/\/login$/);
  await uiLogin(page, A_EMAIL, 'definitely-wrong-password');
  await expect(page).toHaveURL(/\/login$/);
  tokenA = await tokenFor(request, A_EMAIL);
});

test('workspace + default project are created for a new account (signup trigger, RLS-visible)', async ({ page, request }) => {
  watch(page);
  const ws = await api(request, '/rest/v1/workspace_members?select=workspace_role,email', { token: tokenA });
  expect(ws.status).toBe(200);
  expect(ws.json.length).toBe(1);
  expect(ws.json[0].workspace_role).toBe('owner');
  await loginAs(page, A_EMAIL);
  await page.goto('/projects/project-default');
  await expect(page.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
  await expect.poll(async () => {
    const pr = await api(request, '/rest/v1/projects?select=id,name', { token: tokenA });
    if (pr.json?.length) projectId = pr.json[0].id;
    if (!projectId) return 0;
    const c = await api(request, `/rest/v1/columns?select=id,name,position&project_id=eq.${projectId}&order=position`, { token: tokenA });
    cols = c.json ?? [];
    return cols.length;
  }, { timeout: 15_000 }).toBe(5); // the default board is seeded in the DATABASE on first open
});

test('create task (UI) -> persisted in the database', async ({ page, request }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await openBoard(page);
  await page.locator('[data-testid^="add-card-btn-"]').first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#card-title').fill(`Hosted smoke ${run}`);
  await modal.locator('#card-details').fill('created by the hosted verification run');
  await modal.locator('button[type="submit"]').click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByText(`Hosted smoke ${run}`).first()).toBeVisible();
  await expect.poll(async () => {
    const r = await api(request, `/rest/v1/cards?select=id,column_id,title&title=eq.${encodeURIComponent(`Hosted smoke ${run}`)}`, { token: tokenA });
    if (r.json?.length) cardId = r.json[0].id;
    return r.json?.length ?? 0;
  }, { timeout: 10_000 }).toBe(1);
});

test('edit task in the drawer: checklist, comment, assignee, status (move) -> all persisted', async ({ page, request }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await openBoard(page);
  await page.getByTestId(`card-${cardId}`).click();
  await expect(page.getByTestId('drawer-title-input')).toBeVisible();

  await page.getByTestId('checklist-add-input').fill('first step');
  await page.getByTestId('checklist-add-submit').click();
  await expect(page.getByTestId('checklist-items').locator('input[type="text"]').first()).toHaveValue('first step'); // items are editable inputs

  await page.getByTestId('comment-add-input').fill('looks good');
  await page.getByTestId('comment-add-submit').click();
  await expect(page.getByTestId('comments-list')).toContainText('looks good');

  await page.getByTestId('multi-assignee-trigger').click();
  await page.getByTestId('multi-assignee-dropdown').locator('button').first().click();

  const target = cols[cols.length - 1];
  await page.getByTestId('drawer-status-select').selectOption(target.id);

  await expect.poll(async () => (await api(request, `/rest/v1/task_checklists?select=text&card_id=eq.${cardId}`, { token: tokenA })).json.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await api(request, `/rest/v1/task_comments?select=content&card_id=eq.${cardId}`, { token: tokenA })).json.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await api(request, `/rest/v1/card_assignees?select=card_id&card_id=eq.${cardId}`, { token: tokenA })).json.length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => (await api(request, `/rest/v1/cards?select=column_id&id=eq.${cardId}`, { token: tokenA })).json[0]?.column_id, { timeout: 10_000 }).toBe(target.id);
});

test('drag a card between columns -> persisted', async ({ page, request }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await openBoard(page);
  const card = page.getByTestId(`card-${cardId}`);
  const target = page.getByTestId(`column-${cols[1].id}`);
  await expect(card).toBeVisible();
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: dt });
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
  await card.dispatchEvent('dragend', { dataTransfer: dt });
  await expect.poll(async () => (await api(request, `/rest/v1/cards?select=column_id&id=eq.${cardId}`, { token: tokenA })).json[0]?.column_id, { timeout: 10_000 }).toBe(cols[1].id);
});

test('calendar, dashboard and Project Intelligence render from the real database', async ({ page }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await openBoard(page);
  await page.getByTestId('view-switch-calendar').click();
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  await page.getByTestId('view-switch-dashboard').click();
  await expect(page.getByTestId('project-dashboard-view')).toBeVisible();
  await page.getByTestId('view-switch-board').click();
  await page.getByTestId('project-intelligence-btn').click();
  await expect(page.getByTestId('project-intelligence-drawer')).toBeVisible();
  await expect(page.getByTestId('pi-health-score')).toBeVisible();
});

test('create a project from the dashboard -> persisted with its owner as member', async ({ page, request }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await page.goto('/');
  await page.getByTestId('classic-new-project-cta').click();
  await page.getByTestId('project-name-input').fill(`Hosted project ${run}`);
  await page.getByTestId('project-submit-btn').click();
  await expect.poll(async () => (await api(request, `/rest/v1/projects?select=id&name=eq.${encodeURIComponent(`Hosted project ${run}`)}`, { token: tokenA })).json.length, { timeout: 10_000 }).toBe(1);
});

test('team page lists the workspace and sends an invitation (UI) -> pending row, no plaintext token', async ({ page, request }) => {
  watch(page);
  await loginAs(page, A_EMAIL);
  await page.goto('/team');
  await expect(page.getByTestId('members-table')).toBeVisible();
  const invitee = `invitee-${run}@example.test`;
  await page.getByTestId('workspace-invite-email-input').fill(invitee);
  await page.getByTestId('workspace-invite-send-btn').click();
  await expect(page.getByTestId('workspace-pending-invitations-list')).toContainText(invitee);
  const rows = await api(request, '/rest/v1/invitations?select=email,status', { token: tokenA });
  expect(rows.json.some((r: any) => r.email === invitee && r.status === 'pending')).toBe(true);
  expect((await api(request, '/rest/v1/invitations?select=token_hash', { token: tokenA })).status).toBe(403);
  expect((await api(request, '/rest/v1/invitations?select=token', { token: tokenA })).status).toBe(403);
});

test('cross-user isolation: B sees and changes NOTHING of A', async ({ request }) => {
  const tokenB = await tokenFor(request, B_EMAIL);
  for (const t of ['projects', 'columns', 'cards', 'task_checklists', 'task_comments', 'card_assignees', 'task_activities', 'activity_logs', 'project_members', 'task_resources']) {
    const r = await api(request, `/rest/v1/${t}?select=*&limit=5`, { token: tokenB });
    expect(r.status, t).toBe(200);
    expect(r.json.length, `B must see no ${t} of A`).toBe(0);
  }
  const wm = await api(request, '/rest/v1/workspace_members?select=email', { token: tokenB });
  expect(wm.json.every((m: any) => m.email === B_EMAIL), 'B sees only its own workspace roster').toBe(true);

  const upd = await api(request, `/rest/v1/cards?id=eq.${cardId}`, { method: 'PATCH', token: tokenB, headers: { Prefer: 'return=representation' }, data: { title: 'hijacked' } });
  expect(upd.json?.length ?? 0).toBe(0);
  const del = await api(request, `/rest/v1/cards?id=eq.${cardId}`, { method: 'DELETE', token: tokenB, headers: { Prefer: 'return=representation' } });
  expect(del.json?.length ?? 0).toBe(0);
  const ins = await api(request, '/rest/v1/cards', { method: 'POST', token: tokenB, data: { id: `${projectId}-evil-${run}`, column_id: cols[0].id, title: 'evil' } });
  expect([401, 403]).toContain(ins.status);
  const rest = await api(request, '/rest/v1/rpc/restore_project_board', { method: 'POST', token: tokenB, data: { p_project_id: projectId, p_board: { columns: [] } } });
  expect(rest.status).not.toBe(200);

  const still = await api(request, `/rest/v1/cards?select=title&id=eq.${cardId}`, { token: tokenA });
  expect(still.json[0].title).toBe(`Hosted smoke ${run}`);
});

test('invitation by RPC: preview valid -> invitee accepts -> joins the workspace roster only (not A\'s projects)', async ({ request }) => {
  const tokenB = await tokenFor(request, B_EMAIL);
  const inv = await api(request, '/rest/v1/rpc/create_workspace_invitation', { method: 'POST', token: tokenA, data: { p_email: B_EMAIL } });
  expect(inv.status, JSON.stringify(inv.json)).toBe(200);
  const token = inv.json[0].token as string;
  const preview = await api(request, '/rest/v1/rpc/invitation_preview', { method: 'POST', data: { p_token: token } });
  expect(preview.json[0].state).toBe('valid');
  expect(preview.json[0].masked_email).not.toContain(B_EMAIL.split('@')[0]);
  const wrong = await api(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: await tokenFor(request, A_EMAIL), data: { p_token: token, p_display_name: 'x' } });
  expect(wrong.status, 'a different e-mail cannot accept').not.toBe(200);
  const acc = await api(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: tokenB, data: { p_token: token, p_display_name: 'Invitee B' } });
  expect(acc.status, JSON.stringify(acc.json)).toBe(200);
  const again = await api(request, '/rest/v1/rpc/invitation_preview', { method: 'POST', data: { p_token: token } });
  expect(again.json[0].state).toBe('used');
  const projects = await api(request, '/rest/v1/projects?select=id', { token: tokenB });
  expect(projects.json.length, 'accepting a workspace invitation grants no project access').toBe(0);
});

test('AI History restore: owner restores a snapshot atomically; a non-member cannot', async ({ request }) => {
  const tokenB = await tokenFor(request, B_EMAIL);
  const snapshot = { columns: [{ id: `${projectId}-snap-c1`, name: 'Restored column', cards: [{ id: `${projectId}-snap-k1`, title: 'Restored card', checklist: [{ id: `${projectId}-snap-cl`, text: 'step', completed: true }] }] }] };
  const denied = await api(request, '/rest/v1/rpc/restore_project_board', { method: 'POST', token: tokenB, data: { p_project_id: projectId, p_board: snapshot } });
  expect(denied.status).not.toBe(200);
  const before = await api(request, `/rest/v1/columns?select=id&project_id=eq.${projectId}`, { token: tokenA });
  expect(before.json.length).toBe(5);
  const ok = await api(request, '/rest/v1/rpc/restore_project_board', { method: 'POST', token: tokenA, data: { p_project_id: projectId, p_board: snapshot } });
  expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  const after = await api(request, `/rest/v1/columns?select=id,name&project_id=eq.${projectId}`, { token: tokenA });
  expect(after.json.map((c: any) => c.name)).toEqual(['Restored column']);
  const cardsAfter = await api(request, `/rest/v1/cards?select=id,title&column_id=eq.${projectId}-snap-c1`, { token: tokenA });
  expect(cardsAfter.json[0].title).toBe('Restored card');
  // a malformed snapshot must change nothing
  const bad = await api(request, '/rest/v1/rpc/restore_project_board', { method: 'POST', token: tokenA, data: { p_project_id: projectId, p_board: { columns: [{ id: 'dup', name: 'x', cards: [{ id: 'k', title: 'a' }, { id: 'k', title: 'b' }] }] } } });
  expect(bad.status).not.toBe(200);
  const intact = await api(request, `/rest/v1/columns?select=name&project_id=eq.${projectId}`, { token: tokenA });
  expect(intact.json.map((c: any) => c.name)).toEqual(['Restored column']);
});

test('AI gateway on the hosted DB without a Gemini key: 401 without token, 503 fail-closed with one, ledger row written, no key in the response', async ({ request }) => {
  const post = (headers: Record<string, string>) => request.post('/api/ai/improve', { headers: { 'Content-Type': 'application/json', ...headers }, data: JSON.stringify({ projectId, card: { id: 'x', title: 'Improve me', details: '' } }) });
  expect((await post({})).status()).toBe(401);
  const r = await post({ Authorization: `Bearer ${tokenA}` });
  expect(r.status()).toBe(503);
  const body = await r.json();
  expect(body.code).toBe('ai_unavailable');
  expect(JSON.stringify(body)).not.toMatch(/GEMINI|API_KEY|AIza/);
  const ledger = await api(request, '/rest/v1/ai_requests?select=feature,status,error_code&order=created_at.desc&limit=1', { token: tokenA });
  expect(ledger.json[0]).toMatchObject({ feature: 'improve', status: 'failed', error_code: 'ai_unavailable' });
});

test('every browser request to Supabase went to the NEW project only', async () => {
  expect([...supabaseHosts]).toEqual([`${EXPECTED_REF}.supabase.co`]);
});
