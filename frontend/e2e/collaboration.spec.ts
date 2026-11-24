import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

/**
 * RUN 01 -- multi-user collaboration in the browser, against a THROWAWAY local Supabase stack with Realtime
 * (scripts/collab-stack.sh). Every user has their OWN browser context (separate cookies/localStorage), signs in
 * through the real login form, and talks to the real GoTrue / PostgREST / Realtime. Nothing is shared or mocked.
 *
 *   frontend/scripts/collab-stack.sh up && frontend/scripts/collab-stack.sh app   # app on 127.0.0.1:3431
 *   eval "$(frontend/scripts/collab-stack.sh env)"
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3431 npx playwright test e2e/collaboration.spec.ts --workers=1
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
test.skip(!SB || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local collab stack (E2E_SUPABASE_URL) and its app (PLAYWRIGHT_TEST_BASE_URL)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Collab-E2E-Pass-123';
const P = `e2e-collab-${run}`;
const TODO = `${P}-todo`;
const DONE = `${P}-done`;

type U = { id: string; token: string; email: string; name: string };

async function rest(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; minimal?: boolean } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', Prefer: opts.minimal ? 'return=minimal' : 'return=representation' },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}

async function signUp(request: APIRequestContext, tag: string, name: string): Promise<U> {
  const email = `${tag}-${run}@example.test`;
  const r = await rest(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD, data: { display_name: name } } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.user.id, token: r.json.access_token, email, name };
}

async function login(browser: Browser, u: U): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(); // separate storage per user
  const page = await ctx.newPage();
  await page.goto('/login?login=manual');
  await page.getByPlaceholder('jmeno@firma.cz').fill(u.email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}

const card = (page: Page, title: string) => page.locator('[data-testid^="card-"]', { hasText: title }).first();
/** Close the task drawer and wait until it is really gone (its close animation runs ~230 ms). */
async function closeDrawer(page: Page) {
  if (await page.getByTestId('task-detail-drawer').count()) {
    await page.keyboard.press('Escape');
  }
  await expect(page.getByTestId('task-detail-drawer')).toHaveCount(0);
}

test('two independently signed-in users collaborate on one project in realtime', async ({ browser, request }) => {
  test.setTimeout(150_000);
  const A = await signUp(request, 'alice', 'Alice Owner');
  const B = await signUp(request, 'bob', 'Bob Editor');
  const V = await signUp(request, 'vera', 'Vera Viewer');
  const C = await signUp(request, 'cyril', 'Cyril Outsider');

  // Project owned by A (board created like the app does: project + columns + owner membership)
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'E2E spolupráce' }],
    ['/rest/v1/columns', [{ id: TODO, project_id: P, name: 'K řešení', position: 0 }, { id: DONE, project_id: P, name: 'Hotovo', position: 1 }]],
    ['/rest/v1/project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
  ] as const) {
    // return=minimal: like the app (projects' SELECT policy cannot see the row inside its own INSERT ... RETURNING)
    const r = await rest(request, path, { method: 'POST', token: A.token, data, minimal: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }

  const a = await login(browser, A);
  const b = await login(browser, B);
  const v = await login(browser, V);
  const c = await login(browser, C);

  await test.step('owner invites B as editor from the UI; B accepts the link', async () => {
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('toolbar-manage-team-btn').click();
    await a.page.getByTestId('project-invite-email').fill(B.email);
    await a.page.getByTestId('project-invite-role').selectOption('member');
    await a.page.getByTestId('project-invite-send').click();
    const link = await a.page.getByTestId('project-invite-link').inputValue();
    expect(link).toMatch(/\/accept-invite\?token=[0-9a-f]{64}$/);
    await a.page.getByTestId('project-team-done-btn').click();

    await b.page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await expect(b.page.getByTestId('accept-invite-preview')).toBeVisible();
    const nameInput = b.page.getByTestId('accept-invite-name-input');
    if (await nameInput.isVisible()) await nameInput.fill(B.name);
    await b.page.getByTestId('accept-invite-submit-btn').click();
    await expect(b.page.getByTestId('accept-invite-success')).toBeVisible();
  });

  await test.step('viewer V is invited with the viewer role (API) and accepts', async () => {
    const inv = await rest(request, '/rest/v1/rpc/create_project_invitation', { method: 'POST', token: A.token, data: { p_project_id: P, p_email: V.email, p_role: 'viewer' } });
    expect(inv.status).toBe(200);
    const acc = await rest(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: V.token, data: { p_token: inv.json[0].token, p_display_name: V.name } });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
  });

  await test.step('presence: both see each other, the outsider is nowhere', async () => {
    await b.page.goto(`/projects/${P}`);
    await expect(a.page.getByTestId(`presence-user-${B.id}`)).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByTestId(`presence-user-${A.id}`)).toBeVisible({ timeout: 15_000 });
    await c.page.goto(`/projects/${P}`);
    await expect(c.page.getByTestId('access-revoked')).toBeVisible({ timeout: 15_000 });
    await a.page.waitForTimeout(1500);
    await expect(a.page.getByTestId(`presence-user-${C.id}`)).toHaveCount(0);
  });

  await test.step('A creates a task -> B sees it without refreshing', async () => {
    await a.page.getByTestId(`add-card-btn-${TODO}`).click();
    await a.page.getByLabel('Název *').fill('Navrhnout logo');
    await a.page.getByRole('dialog').locator('button[type="submit"]').click();
    await expect(card(b.page, 'Navrhnout logo')).toBeVisible({ timeout: 10_000 });
  });

  await test.step('B moves it to Hotovo -> A sees the status change live', async () => {
    await card(b.page, 'Navrhnout logo').click();
    await b.page.getByTestId('drawer-status-select').selectOption(DONE);
    await expect(a.page.getByTestId(`cards-list-${DONE}`).getByText('Navrhnout logo')).toBeVisible({ timeout: 10_000 });
  });

  await test.step('B sets a deadline -> A sees it; A assigns B -> B gets a notification', async () => {
    await b.page.getByTestId('drawer-duedate-input').fill('2026-12-15');
    await b.page.getByTestId('drawer-duedate-input').blur();
    await a.page.waitForTimeout(500);
    await expect.poll(async () => (await card(a.page, 'Navrhnout logo').textContent()) ?? '', { timeout: 10_000 }).toMatch(/15/);
    const k = (await card(a.page, 'Navrhnout logo').getAttribute('data-testid'))!.replace(/^card-/, '');
    const bm = await rest(request, `/rest/v1/workspace_members?select=id&profile_id=eq.${B.id}&owner_id=eq.${A.id}`, { token: A.token });
    const asg = await rest(request, '/rest/v1/card_assignees', { method: 'POST', token: A.token, data: { card_id: k, member_id: bm.json[0].id, position: 0 }, minimal: true });
    expect(asg.status).toBe(201);
    await expect(b.page.getByTestId('notifications-unread')).toBeVisible({ timeout: 10_000 });
    await expect(card(a.page, 'Navrhnout logo').getByTestId(`card-avatar-${bm.json[0].id}`)).toBeVisible({ timeout: 10_000 });
  });

  await test.step('A comments with an @mention of V -> B sees it live, V gets the mention', async () => {
    await card(a.page, 'Navrhnout logo').click();
    const input = a.page.getByTestId('comment-add-input');
    await input.click();
    await input.pressSequentially('Prosím @Ve');
    await a.page.getByTestId(`mention-option-${V.id}`).click();
    await input.pressSequentially('mrkni na to');
    await a.page.getByTestId('comment-add-submit').click();
    await expect(b.page.getByTestId('comments-list').getByText(/mrkni na to/)).toBeVisible({ timeout: 10_000 });
    await v.page.goto('/');
    await v.page.getByTestId('notifications-bell').click();
    await expect(v.page.locator('[data-type="mention"]')).toContainText('zmínil(a)');
    const cn = await rest(request, '/rest/v1/notifications?select=id', { token: C.token });
    expect(cn.json).toEqual([]);
  });

  await test.step('activity timeline is shared and readable', async () => {
    await closeDrawer(b.page);
    await b.page.getByTitle('Aktivita projektu').click();
    const feed = b.page.getByTestId('activity-feed-list');
    await expect(feed).toContainText('přidal(a) úkol „Navrhnout logo"');
    await expect(feed).toContainText('dokončil(a) úkol „Navrhnout logo"');
    await expect(feed).toContainText('okomentoval(a) úkol');
    await expect(feed).toContainText('přiřadil(a) úkol');
    await b.page.getByTestId('activity-feed-close-btn').click();
  });

  await test.step('simultaneous title edits: the second writer gets a conflict notice, nothing silently lost', async () => {
    await closeDrawer(a.page);
    await closeDrawer(b.page);
    await card(a.page, 'Navrhnout logo').click();
    await card(b.page, 'Navrhnout logo').click();
    const ta = a.page.getByTestId('drawer-title-input');
    const tb = b.page.getByTestId('drawer-title-input');
    await ta.click(); await tb.click(); // both start from the same value
    await ta.fill('Logo verze A'); await ta.blur();
    await expect(card(b.page, 'Logo verze A')).toBeVisible({ timeout: 10_000 }); // arrives while B is still typing
    await tb.fill('Logo verze B'); await tb.blur();
    await expect(b.page.getByTestId('conflict-notice')).toBeVisible({ timeout: 10_000 });
    await b.page.getByTestId('conflict-keep-theirs').click();
    await expect(b.page.getByTestId('conflict-notice')).toHaveCount(0);
    const k = (await card(a.page, 'Logo verze A').getAttribute('data-testid'))!.replace(/^card-/, '');
    const row = await rest(request, `/rest/v1/cards?select=title&id=eq.${k}`, { token: A.token });
    expect(row.json[0].title).toBe('Logo verze A');
    await closeDrawer(a.page); await closeDrawer(b.page);
  });

  await test.step('viewer is read-only in the UI and refused by the backend', async () => {
    await v.page.goto(`/projects/${P}`);
    await expect(v.page.getByTestId('readonly-notice')).toBeVisible();
    await expect(v.page.getByTestId('add-column-board-btn')).toHaveCount(0);
    await card(v.page, 'Logo verze A').click();
    await expect(v.page.getByTestId('drawer-title-input')).toBeDisabled();
    await expect(v.page.getByTestId('comments-readonly')).toBeVisible();
    const vw = await rest(request, '/rest/v1/cards', { method: 'POST', token: V.token, data: { id: `${P}-v`, column_id: TODO, title: 'x' }, minimal: true });
    expect(vw.status).toBe(403);
    await closeDrawer(v.page);
  });

  await test.step('reconnect: B goes offline, misses a change, comes back and is reconciled', async () => {
    await b.ctx.setOffline(true);
    await b.page.waitForTimeout(1500);
    const k = (await card(a.page, 'Logo verze A').getAttribute('data-testid'))!.replace(/^card-/, '');
    const up = await rest(request, `/rest/v1/cards?id=eq.${k}`, { method: 'PATCH', token: A.token, data: { title: 'Změněno během výpadku' } });
    expect(up.status).toBe(200);
    await b.page.waitForTimeout(1000);
    await b.ctx.setOffline(false);
    await expect(card(b.page, 'Změněno během výpadku')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('removing V revokes access live; V cannot read via the API either', async () => {
    await a.page.getByTestId('toolbar-manage-team-btn').click();
    const vm = await rest(request, `/rest/v1/workspace_members?select=id&profile_id=eq.${V.id}&owner_id=eq.${A.id}`, { token: A.token });
    a.page.once('dialog', (d) => d.accept());
    await a.page.getByTestId(`project-team-remove-${vm.json[0].id}`).click();
    await expect(a.page.getByTestId(`project-team-member-${vm.json[0].id}`)).toHaveCount(0);
    await a.page.getByTestId('project-team-done-btn').click();
    await expect(v.page.getByTestId('access-revoked')).toBeVisible({ timeout: 15_000 });
    await expect(card(v.page, 'Změněno během výpadku')).toHaveCount(0);
    const vr = await rest(request, `/rest/v1/cards?select=id&project_id=eq.${P}`, { token: V.token });
    expect(vr.json).toEqual([]);
  });

  await test.step('a reload shows the persisted, authoritative state', async () => {
    await b.page.reload();
    await expect(b.page.getByTestId(`cards-list-${DONE}`).getByText('Změněno během výpadku')).toBeVisible();
    await card(b.page, 'Změněno během výpadku').click();
    await expect(b.page.getByTestId('comments-list')).toContainText('mrkni na to');
  });

  for (const s of [a, b, v, c]) await s.ctx.close();
  await rest(request, `/rest/v1/projects?id=eq.${P}`, { method: 'DELETE', token: A.token });
});
