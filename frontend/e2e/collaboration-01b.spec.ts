import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

/**
 * RUN 01B in the browser, on the LOCAL collab stack (real GoTrue / PostgREST / Realtime, real SMTP into the stack's
 * Mailpit -- capture only). Every user has an own browser context; the invitee opens the link from the captured
 * e-mail in a context with no session and registers there.
 *   eval "$(frontend/scripts/collab-stack.sh env)"
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3431 npx playwright test e2e/collaboration-01b.spec.ts --workers=1
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const MAILPIT = process.env.E2E_MAILPIT_URL;
test.skip(!SB || !MAILPIT || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local collab stack (E2E_SUPABASE_URL, E2E_MAILPIT_URL) and its app');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Collab-01B-Pass-123';
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
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login?login=manual');
  await page.getByPlaceholder('jmeno@firma.cz').fill(u.email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
async function mailTo(request: APIRequestContext, addr: string): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 40; i++) {
    const s = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${addr}"`)}`)).json();
    if (s.messages?.length) {
      const m = await (await request.get(`${MAILPIT}/api/v1/message/${s.messages[0].ID}`)).json();
      return { subject: m.Subject, text: m.Text };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no e-mail for ${addr}`);
}
const card = (page: Page, title: string) => page.locator('[data-testid^="card-"]', { hasText: title }).first();

test('e-mail invitation, new account, conflicts, cross-project move and trusted history', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const P = `e2e-01b-${run}`; const P2 = `e2e-01b2-${run}`;
  const A = await signUp(request, 'own01b', 'Alena Vlastníková');
  const B = await signUp(request, 'ed01b', 'Bedřich Editor');
  for (const [path, data] of [
    ['/rest/v1/projects', [{ id: P, name: 'Stěhování kanceláře' }, { id: P2, name: 'Archiv' }]],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-b`, project_id: P, name: 'Hotovo', position: 1 }, { id: `${P2}-a`, project_id: P2, name: 'Archiv', position: 0 }]],
    ['/rest/v1/project_members', [{ project_id: P, member_id: `member-owner-${A.id}` }, { project_id: P2, member_id: `member-owner-${A.id}` }]],
    ['/rest/v1/cards', [{ id: `${P}-k1`, column_id: `${P}-a`, title: 'Objednat stěhováky' }, { id: `${P}-k2`, column_id: `${P}-a`, title: 'Přesunout do archivu' }]],
    ['/rest/v1/task_checklists', { id: `${P}-ch1`, card_id: `${P}-k1`, text: 'Zjistit ceny' }],
  ] as const) {
    const r = await rest(request, path, { method: 'POST', token: A.token, data, minimal: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  const invB = await rest(request, '/rest/v1/rpc/create_project_invitation', { method: 'POST', token: A.token, data: { p_project_id: P, p_email: B.email, p_role: 'member' } });
  await rest(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: B.token, data: { p_token: invB.json[0].token, p_display_name: B.name } });

  const a = await login(browser, A);
  const b = await login(browser, B);
  const NEW = `nova-${run}@example.test`;

  await test.step('owner sends an e-mail invitation from the members dialog; status is shown honestly', async () => {
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('toolbar-manage-team-btn').click();
    await a.page.getByTestId('project-invite-email').fill(NEW);
    await a.page.getByTestId('project-invite-role').selectOption('member');
    await a.page.getByTestId('project-invite-send').click();
    await expect(a.page.getByTestId('project-team-info')).toContainText(`Pozvánka odeslána na ${NEW}`);
    const row = a.page.locator('[data-testid^="project-invite-inv-"]').filter({ hasText: NEW });
    await expect(row).toHaveAttribute('data-state', 'pending');
    await expect(row).toHaveAttribute('data-delivery', 'accepted');
    await expect(row).toContainText('předán poštovnímu serveru');
    // an immediate resend is throttled with a Czech explanation
    await row.getByRole('button', { name: 'Poslat znovu' }).click();
    await expect(a.page.getByTestId('project-team-error')).toContainText('Zkuste to za minutu');
    await a.page.getByTestId('project-team-done-btn').click();
  });

  await test.step('the invitee opens the e-mailed link WITHOUT a session, registers and lands in the project', async () => {
    const mail = await mailTo(request, NEW);
    expect(mail.subject).toContain('vás zve do projektu Stěhování kanceláře');
    const link = /https?:\/\/\S+\/accept-invite\?token=[0-9a-f]{64}/.exec(mail.text)![0];
    expect(link.startsWith(process.env.PLAYWRIGHT_TEST_BASE_URL!)).toBe(true);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await expect(page.getByTestId('accept-invite-preview')).toContainText('Alena Vlastníková');
    await page.getByTestId('accept-invite-email-input').fill(NEW);
    await page.getByTestId('accept-invite-name-input').fill('Nová Kolegyně');
    await page.getByTestId('accept-invite-password-input').fill(PASSWORD);
    await page.getByTestId('accept-invite-submit-btn').click();
    await expect(page.getByTestId('accept-invite-success')).toBeVisible();
    await page.goto(`/projects/${P}`);
    await expect(card(page, 'Objednat stěhováky')).toBeVisible();
    // the same link cannot be used again
    const again = await ctx.newPage();
    await again.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await expect(again.getByTestId('accept-invite-unavailable')).toBeVisible();
    await ctx.close();
    await a.page.getByTestId('toolbar-manage-team-btn').click();
    await expect(a.page.locator('[data-testid^="project-invite-inv-"]').filter({ hasText: NEW })).toHaveAttribute('data-state', 'accepted');
    await a.page.getByTestId('project-team-done-btn').click();
  });

  await test.step('column rename against a colleague\'s concurrent rename: Czech notice, nothing overwritten', async () => {
    await b.page.goto(`/projects/${P}`);
    await b.page.getByTestId(`column-title-${P}-a`).click();
    const input = b.page.getByTestId(`column-input-${P}-a`);
    await expect(input).toBeVisible();
    const r = await rest(request, `/rest/v1/columns?id=eq.${P}-a`, { method: 'PATCH', token: A.token, data: { name: 'Rozpracováno' }, minimal: true });
    expect(r.status).toBe(204);
    await input.fill('Naplánováno');
    await input.press('Enter');
    await expect(b.page.getByTestId('collab-notice')).toContainText('Sloupec mezitím přejmenoval kolega na „Rozpracováno“');
    await expect(b.page.getByTestId(`column-title-${P}-a`)).toHaveText('Rozpracováno');
    await b.page.getByTestId('collab-notice-dismiss').click();
  });

  await test.step('checklist: concurrent toggle + rename keep both; stale rename gets a notice', async () => {
    await card(b.page, 'Objednat stěhováky').click();
    const item = b.page.getByTestId(`checklist-input-${P}-ch1`);
    await item.click();
    const r = await rest(request, `/rest/v1/task_checklists?id=eq.${P}-ch1`, { method: 'PATCH', token: A.token, data: { text: 'Zjistit ceny (3 firmy)' }, minimal: true });
    expect(r.status).toBe(204);
    await item.fill('Zjistit ceny do pátku');
    await item.blur();
    await expect(b.page.getByTestId('collab-notice')).toContainText('Položku checklistu mezitím přejmenoval kolega');
    await b.page.getByTestId('collab-notice-dismiss').click();
    await b.page.getByTestId(`checklist-checkbox-${P}-ch1`).click();
    await expect.poll(async () => (await rest(request, `/rest/v1/task_checklists?select=text,completed&id=eq.${P}-ch1`, { token: A.token })).json[0]).toEqual({ text: 'Zjistit ceny (3 firmy)', completed: true });
  });

  await test.step('trusted task history shows who did what', async () => {
    await b.page.getByTestId('drawer-activity-toggle').click();
    const h = b.page.getByTestId('activity-timeline');
    await expect(h).toContainText('Alena Vlastníková');
    await expect(h).toContainText('přejmenoval(a) položku checklistu „Zjistit ceny" na „Zjistit ceny (3 firmy)"');
    await expect(h).toContainText('splnil(a) položku checklistu');
    await b.page.keyboard.press('Escape');
    await expect(b.page.getByTestId('task-detail-drawer')).toHaveCount(0);
  });

  await test.step('a card moved to a project B cannot see disappears from B\'s board live', async () => {
    await expect(card(b.page, 'Přesunout do archivu')).toBeVisible();
    const r = await rest(request, `/rest/v1/cards?id=eq.${P}-k2`, { method: 'PATCH', token: A.token, data: { column_id: `${P2}-a` }, minimal: true });
    expect(r.status).toBe(204);
    await expect(card(b.page, 'Přesunout do archivu')).toHaveCount(0, { timeout: 10_000 });
    const rb = await rest(request, `/rest/v1/cards?select=id&id=eq.${P}-k2`, { token: B.token });
    expect(rb.json).toEqual([]);
  });

  for (const s of [a, b]) await s.ctx.close();
  for (const p of [P, P2]) await rest(request, `/rest/v1/projects?id=eq.${p}`, { method: 'DELETE', token: A.token, minimal: true });
});
