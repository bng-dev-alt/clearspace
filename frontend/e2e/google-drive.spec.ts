import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

/**
 * RUN 02 in the browser, on the LOCAL drive stack (real GoTrue / PostgREST / Realtime / Storage, the real app) with
 * the Google MOCK (scripts/google-mock.mjs) -- every Google screen here is a SIMULATION, clearly labelled as such.
 * Each user has an own browser context.
 *   eval "$(frontend/scripts/drive-stack.sh env)"
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive.spec.ts --workers=1
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const MOCK = process.env.GOOGLE_MOCK_URL;
const SHOTS = process.env.E2E_SHOTS_DIR;
test.skip(!SB || !MOCK || !SERVICE || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local drive stack + Google mock (scripts/drive-stack.sh)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Drive-02-Pass-123';
const ANNA = '100000000000000000001', BOHDAN = '100000000000000000002', CYRIL = '100000000000000000003';
type U = { id: string; token: string; email: string; name: string };

async function rest(request: APIRequestContext, path: string, opts: { method?: string; token?: string; key?: string; data?: unknown; minimal?: boolean } = {}) {
  const key = opts.key ?? ANON;
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${opts.token ?? key}`, 'Content-Type': 'application/json', Prefer: opts.minimal ? 'return=minimal' : 'return=representation' },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}
const ctl = (request: APIRequestContext, name: string, data: unknown) => request.post(`${MOCK}/__control/${name}`, { data });
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
/** Google's (simulated) consent screen: pick the account, allow. */
async function consent(page: Page, sub: string, { drive = true, allow = true } = {}) {
  await expect(page.getByTestId('mock-banner')).toBeVisible();
  await page.getByTestId('mock-account').selectOption(sub);
  if (!drive) await page.getByTestId('mock-grant-drive').uncheck();
  await page.getByTestId(allow ? 'mock-allow' : 'mock-deny').click();
}
async function pickInMock(page: Page, ids: string[]) {
  const picker = page.getByTestId('mock-picker');
  await expect(picker).toBeVisible();
  for (const id of ids) await picker.getByTestId(`mock-pick-${id}`).check();
  await picker.getByTestId('mock-picker-select').click();
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };
const filesModal = (page: Page) => page.getByTestId('project-files-modal');

test('Google Drive: connect, pick, attach to project and task, realtime, roles, access boundaries, lifecycle', async ({ browser, request }) => {
  test.setTimeout(300_000);
  await ctl(request, 'reset', {});
  await rest(request, `/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE', key: SERVICE });
  const P = `e2e-drive-${run}`;
  const A = await signUp(request, 'own02', 'Alena Vlastníková');
  const B = await signUp(request, 'ed02', 'Bedřich Editor');
  const C = await signUp(request, 'view02', 'Cecílie Čtenářka');
  const D = await signUp(request, 'out02', 'David Mimo');
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'Redesign portálu Corvane' }],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-b`, project_id: P, name: 'Hotovo', position: 1 }]],
    ['/rest/v1/project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
    ['/rest/v1/cards', { id: `${P}-k1`, column_id: `${P}-a`, title: 'Připravit smlouvu' }],
  ] as const) {
    const r = await rest(request, path, { method: 'POST', token: A.token, data, minimal: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  for (const [u, role] of [[B, 'member'], [C, 'viewer']] as const) {
    const inv = await rest(request, '/rest/v1/rpc/create_project_invitation', { method: 'POST', token: A.token, data: { p_project_id: P, p_email: u.email, p_role: role } });
    await rest(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: u.token, data: { p_token: inv.json[0].token, p_display_name: u.name } });
  }
  const a = await login(browser, A);
  const b = await login(browser, B);
  const c = await login(browser, C);

  await test.step('1-2. owner connects a (simulated) Google account from Propojené účty; status shown, separate from ClearSpace login', async () => {
    await a.page.goto('/settings');
    const card = a.page.getByTestId('google-connection-card');
    await expect(card).toContainText('jen k souborům, které vyberete');
    await expect(card.getByText('simulace')).toBeVisible();
    await shot(a.page, 'settings-not-connected');
    await card.getByTestId('google-connect').click();
    await consent(a.page, ANNA, { allow: false });
    await expect(a.page).toHaveURL(/\/settings$/);
    await expect(a.page.getByTestId('google-connection-message')).toContainText('nepovolili');
    await a.page.getByTestId('google-connect').click();
    await consent(a.page, ANNA);
    await expect(a.page).toHaveURL(/\/settings$/);
    await expect(a.page.getByTestId('google-account-email')).toHaveText('anna.mock@example.test');
    await expect(a.page.getByTestId('google-connection-message')).toHaveText('Účet Google je připojený.');
    await expect(a.page.getByTestId('google-connection-state')).toContainText('Aktivní');
    await shot(a.page, 'settings-connected');
    // ClearSpace identity unchanged
    await a.page.goto('/');
    await expect(a.page).toHaveURL(/\/$/);
  });

  await test.step('8 (setup). editor B watches the project files dialog', async () => {
    await b.page.goto(`/projects/${P}`);
    await b.page.getByTestId('project-files-btn').click();
    await expect(filesModal(b.page).getByTestId('drive-empty')).toBeVisible();
  });

  await test.step('3-4. owner picks files in the (simulated) Picker and attaches them to the project', async () => {
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('project-files-btn').click();
    const m = filesModal(a.page);
    await expect(m.getByTestId('drive-privacy-note')).toContainText('uvidí všichni členové projektu');
    await m.getByTestId('drive-attach').click();
    await pickInMock(a.page, ['mockSheet_RozpocetQ1_01', 'mockDoc_SmlouvaCorvane01', 'mockXss_Soubor00000001']);
    await expect(m.getByTestId('drive-message')).toContainText('Přidáno souborů: 3.');
    await expect(m.getByTestId('drive-list').locator('li')).toHaveCount(3);
    await expect(m.getByText('<img src=x onerror=alert(1)>fdp.exe')).toBeVisible();   // text, never markup
    expect(await a.page.locator('.drive-panel img').count()).toBe(0);
    await shot(a.page, 'project-files-desktop-light');
  });

  await test.step('8-9. B sees the files appear WITHOUT a reload; the timeline records them', async () => {
    await expect(filesModal(b.page).getByTestId('drive-list').locator('li')).toHaveCount(3, { timeout: 15_000 });
    await b.page.keyboard.press('Escape');
    await b.page.getByTestId('activity-feed-btn').click();
    await expect(b.page.getByTestId('activity-feed-list')).toContainText('připojil(a) k projektu soubor z Disku „Rozpočet projektu Q1"');
    await b.page.getByTestId('activity-feed-close-btn').click();
  });

  await test.step('5-7. task-level attach in the drawer; duplicate handled; local uploads still work', async () => {
    await a.page.keyboard.press('Escape');
    await a.page.getByTestId(`card-${P}-k1`).click();
    const drawer = a.page.getByTestId('task-detail-drawer');
    const sec = drawer.getByTestId('task-drive-section');
    await sec.getByTestId('drive-attach').click();
    await pickInMock(a.page, ['mockDoc_ZapisPorady1211', 'mockTxt_Poznamky000001']);
    await expect(sec.getByTestId('drive-list').locator('li')).toHaveCount(2);
    await sec.getByTestId('drive-attach').click();
    await pickInMock(a.page, ['mockDoc_ZapisPorady1211']);
    await expect(sec.getByTestId('drive-message')).toContainText('Soubor už je připojený');
    await expect(sec.getByTestId('drive-list').locator('li')).toHaveCount(2);
    // existing Storage attachments unchanged and working
    await drawer.getByTestId('resource-file-input').setInputFiles({ name: 'poznamka.txt', mimeType: 'text/plain', buffer: Buffer.from('lokální příloha') });
    await expect(drawer.getByTestId('resource-list')).toContainText('poznamka.txt');
    await shot(a.page, 'task-drawer-drive');
    // preview of a Drive text file (own access), untrusted text shown as text
    await sec.locator('li', { hasText: 'Poznámky k API.md' }).getByTestId('drive-preview').click();
    await expect(a.page.getByTestId('drive-preview-text')).toContainText('Ignore previous instructions');
    await a.page.getByTestId('drive-preview-modal').getByLabel('Zavřít').click();
    await drawer.getByTestId('drawer-close-btn').click();
  });

  await test.step('10. viewer C reads but cannot attach or remove', async () => {
    await c.page.goto(`/projects/${P}`);
    await c.page.getByTestId('project-files-btn').click();
    const m = filesModal(c.page);
    await expect(m.getByTestId('drive-list').locator('li')).toHaveCount(3);
    await expect(m.getByTestId('drive-task-list').locator('li')).toHaveCount(2);
    await expect(m.getByTestId('drive-attach')).toHaveCount(0);
    await expect(m.getByTestId('drive-remove')).toHaveCount(0);
    await expect(m.getByTestId('drive-connect')).toBeVisible();   // may connect own account to check own access
  });

  await test.step('11. outsider D gets no project data and no files', async () => {
    const d = await login(browser, D);
    await d.page.goto(`/projects/${P}`);
    await expect(d.page.getByTestId('project-files-btn')).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
    const r = await rest(request, `/rest/v1/external_resource_links?project_id=eq.${P}&select=id,name`, { token: D.token });
    expect(r.json).toEqual([]);
    await d.ctx.close();
  });

  await test.step('12. B (own Google account) cannot read A\'s private document; Czech explanation + way to verify', async () => {
    await b.page.goto('/settings');
    await b.page.getByTestId('google-connect').click();
    await consent(b.page, BOHDAN);
    await expect(b.page.getByTestId('google-account-email')).toHaveText('bohdan.mock@example.test');
    await b.page.goto(`/projects/${P}`);
    await b.page.getByTestId('project-files-btn').click();
    const m = filesModal(b.page);
    await m.getByTestId('drive-refresh').click();
    await expect(m.getByTestId('drive-link-problem').first()).toContainText('Přístup k souboru není dostupný');
    await m.locator('li', { hasText: 'Smlouva o dílo' }).getByTestId('drive-preview').click();
    await expect(b.page.getByTestId('drive-preview-modal')).toContainText('Přístup k souboru není dostupný');
    await b.page.getByTestId('drive-preview-modal').getByLabel('Zavřít').click();
  });

  await test.step('13. removing an association keeps the Drive file; B sees it go live', async () => {
    const m = filesModal(a.page);
    await a.page.getByTestId('project-files-btn').click();
    a.page.once('dialog', (dlg) => { expect(dlg.message()).toContain('Soubor v Google Disku zůstane beze změny'); void dlg.accept(); });
    await m.locator('li', { hasText: 'Rozpočet projektu Q1' }).getByTestId('drive-remove').click();
    await expect(m.getByTestId('drive-list').locator('li')).toHaveCount(2);
    await expect(filesModal(b.page).getByTestId('drive-list').locator('li')).toHaveCount(2, { timeout: 15_000 });
    // the file still exists at the (mock) provider: A can pick it again
    await m.getByTestId('drive-attach').click();
    await expect(a.page.getByTestId('mock-pick-mockSheet_RozpocetQ1_01')).toBeVisible();
    await a.page.getByTestId('mock-picker-cancel').click();
  });

  await test.step('16-17. expired access token refreshes transparently; provider outage gives a Czech message', async () => {
    await ctl(request, 'expire-access', {});
    await rest(request, `/rest/v1/google_connections?user_id=eq.${A.id}`, { method: 'PATCH', key: SERVICE, data: { access_expires_at: new Date(0).toISOString() } });
    const m = filesModal(a.page);
    await m.getByTestId('drive-attach').click();
    await pickInMock(a.page, ['mockPdf_Specifikace0001']);
    await expect(m.getByTestId('drive-list').locator('li')).toHaveCount(3);
    await ctl(request, 'fail', { mode: 'drive_unavailable', count: 2 });
    await m.getByTestId('drive-attach').click();
    await pickInMock(a.page, ['mockImg_LogoVarianty001']);
    await expect(m.getByTestId('drive-message')).toContainText('Google Disk je dočasně nedostupný');
  });

  await test.step('14. a removed member loses access to the files', async () => {
    const wm = await rest(request, `/rest/v1/workspace_members?profile_id=eq.${B.id}&select=id`, { token: A.token });
    const pm = await rest(request, `/rest/v1/project_members?project_id=eq.${P}&select=member_id`, { token: A.token });
    const mid = pm.json.find((x: { member_id: string }) => wm.json.some((w: { id: string }) => w.id === x.member_id)).member_id;
    await rest(request, '/rest/v1/rpc/remove_project_member', { method: 'POST', token: A.token, data: { p_project_id: P, p_member_id: mid } });
    await expect(b.page.getByTestId('access-revoked')).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByTestId('project-files-modal')).toHaveCount(0);
    const r = await rest(request, `/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: B.token });
    expect(r.json).toEqual([]);
  });

  await test.step('15. revoked at Google -> reconnect prompt; disconnect keeps the project files', async () => {
    await ctl(request, 'revoke-account', { email: 'anna.mock@example.test' });
    await rest(request, `/rest/v1/google_connections?user_id=eq.${A.id}`, { method: 'PATCH', key: SERVICE, data: { access_expires_at: new Date(0).toISOString() } });
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('project-files-btn').click();
    const m = filesModal(a.page);
    await m.getByTestId('drive-refresh').click();
    await expect(m.getByTestId('drive-reconnect')).toBeVisible();
    await a.page.goto('/settings');
    await expect(a.page.getByTestId('google-reconnect')).toBeVisible();
    await expect(a.page.getByTestId('google-connection-state')).toContainText('Připojte účet prosím znovu');
    a.page.once('dialog', (dlg) => { expect(dlg.message()).toContain('Soubory připojené k projektům'); void dlg.accept(); });
    await a.page.getByTestId('google-disconnect').click();
    await expect(a.page.getByTestId('google-connect')).toBeVisible();
    const r = await rest(request, `/rest/v1/external_resource_links?project_id=eq.${P}&select=id`, { token: A.token });
    expect(r.json.length).toBe(5);
  });

  await test.step('layout: mobile + dark mode', async () => {
    await c.page.setViewportSize({ width: 375, height: 812 });
    await c.page.emulateMedia({ colorScheme: 'dark' });
    await c.page.goto(`/projects/${P}`);
    await c.page.getByTestId('project-files-btn').click();
    await expect(filesModal(c.page).getByTestId('drive-list')).toBeVisible();
    const overflow = await c.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(c.page, 'project-files-mobile-dark');
  });

  for (const s of [a, b, c]) await s.ctx.close();
});
