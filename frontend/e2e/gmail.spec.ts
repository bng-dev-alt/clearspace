import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { answerConfirm } from './support/confirm';

/**
 * RUN 03 in the browser, on the LOCAL gmail stack (real GoTrue / PostgREST / Realtime, the real app) with the Google + Gmail
 * MOCK (scripts/google-mock.mjs) -- every Google screen here is a SIMULATION, clearly labelled as such. Own browser context per user.
 *   eval "$(frontend/scripts/gmail-stack.sh env)"
 *   [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3451 npx playwright test e2e/gmail.spec.ts --workers=1
 * The app must run with DEV_AUTO_LOGIN=0 (fresh contexts sign in themselves).
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const MOCK = process.env.GOOGLE_MOCK_URL;
const SHOTS = process.env.E2E_SHOTS_DIR;
const STYLE = process.env.E2E_STYLE === 'monograph' ? 'monograph' : 'existing';   // 'existing' = Classic
test.skip(!SB || !MOCK || !SERVICE || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local gmail stack + Google mock (scripts/gmail-stack.sh)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Gmail-03-Pass-123';
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
async function login(browser: Browser, u: U, viewport = { width: 1280, height: 800 }, colorScheme: 'light' | 'dark' = 'light'): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  await page.addInitScript((v) => localStorage.setItem('clearspace-style', v), STYLE);
  await page.goto('/login?login=manual');
  await page.getByPlaceholder('jmeno@firma.cz').fill(u.email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
/** Google's (simulated) consent screen. */
async function consent(page: Page, sub: string, { gmail = true, allow = true } = {}) {
  await expect(page.getByTestId('mock-banner')).toBeVisible();
  await page.getByTestId('mock-account').selectOption(sub);
  if (!gmail) await page.getByTestId('mock-grant-gmail').uncheck();
  await page.getByTestId(allow ? 'mock-allow' : 'mock-deny').click();
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${STYLE}-${name}.png`, fullPage: false }); };
const filesModal = (page: Page) => page.getByTestId('project-files-modal');
const gmailList = (page: Page) => filesModal(page).getByTestId('project-gmail-section').getByTestId('gmail-list');
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test(`Gmail (${STYLE}): incremental consent next to Drive, select + attach to project and task, owner-only preview, realtime, roles, removal`, async ({ browser, request }) => {
  test.setTimeout(300_000);
  await ctl(request, 'reset', {});
  await rest(request, `/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE', key: SERVICE });
  const P = `e2e-gmail-${run}`;
  const A = await signUp(request, 'own03', 'Alena Vlastníková');
  const B = await signUp(request, 'ed03', 'Bedřich Editor');
  const C = await signUp(request, 'view03', 'Cecílie Čtenářka');
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'Redesign portálu Corvane' }],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }]],
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
  const c = await login(browser, C, { width: 375, height: 812 }, 'dark');

  await test.step('Propojené účty: Drive first, then Gmail incrementally; refusing Gmail keeps Drive', async () => {
    await a.page.goto('/settings');
    const card = a.page.getByTestId('google-connection-card');
    await expect(card.getByTestId('gmail-service-state')).toContainText('Nepovoleno');
    await expect(card.getByText('simulace')).toBeVisible();
    await card.getByTestId('google-connect').click();
    await expect(a.page.getByTestId('mock-grant-gmail')).toHaveCount(0);              // Drive consent asks no Gmail
    await consent(a.page, ANNA);
    await expect(a.page.getByTestId('drive-service-state')).toContainText('Povoleno');
    await a.page.getByTestId('gmail-connect-settings').click();
    await expect(a.page.getByTestId('mock-grant-drive')).toHaveCount(0);              // Gmail consent asks only Gmail (+ identity)
    await expect(a.page.getByTestId('mock-account')).toHaveValue(ANNA);               // same account pre-selected (login_hint)
    await consent(a.page, ANNA, { gmail: false });
    await expect(a.page.getByTestId('google-connection-message')).toContainText('Ostatní propojení (Google Disk) zůstávají beze změny');
    await expect(a.page.getByTestId('drive-service-state')).toContainText('Povoleno');
    await expect(a.page.getByTestId('gmail-service-state')).toContainText('Nepovoleno');
    await a.page.getByTestId('gmail-connect-settings').click();
    await consent(a.page, ANNA);
    await expect(a.page.getByTestId('google-connection-message')).toContainText('Gmail je připojený (jen čtení)');
    await expect(a.page.getByTestId('gmail-service-state')).toContainText('Povoleno – jen čtení');
    await expect(a.page.getByTestId('google-account-email')).toHaveText('anna.mock@example.test');
    await noOverflow(a.page);
    await shot(a.page, 'settings-drive-gmail');
  });

  await test.step('project: everyone sees the e-mail section; editor without Google gets "Připojit Gmail", viewer no controls', async () => {
    for (const s of [a, b, c]) {
      await s.page.goto(`/projects/${P}`);
      await s.page.getByTestId('project-files-btn').click();
      await expect(filesModal(s.page).getByTestId('project-gmail-section')).toBeVisible();
      await expect(filesModal(s.page).getByTestId('gmail-empty')).toBeVisible();
    }
    await expect(filesModal(a.page).getByTestId('gmail-privacy-note')).toContainText('zůstávají jen ve vaší schránce');
    await expect(filesModal(a.page).getByTestId('drive-attach')).toBeVisible();        // Drive still available
    await expect(filesModal(b.page).getByTestId('gmail-connect')).toBeVisible();
    await expect(filesModal(b.page).getByTestId('gmail-attach')).toHaveCount(0);
    await expect(filesModal(c.page).getByTestId('gmail-attach')).toHaveCount(0);
    await expect(filesModal(c.page).getByTestId('gmail-connect')).toHaveCount(0);
  });

  await test.step('select a conversation (search), attach to the project; teammates see it live; duplicate reported', async () => {
    const m = filesModal(a.page);
    await m.getByTestId('gmail-attach').click();
    const picker = a.page.getByTestId('gmail-picker');
    await expect(picker.getByTestId('gmail-picker-privacy')).toContainText('nic nemění a neposílá');
    await expect(picker.getByTestId('gmail-results').locator('li').first()).toBeVisible();
    await expect(picker.getByTestId('gmail-page-next')).toBeEnabled();
    await picker.getByTestId('gmail-filter-text').fill('redesign');
    await picker.getByTestId('gmail-filter-from').fill('Jana');
    await picker.getByTestId('gmail-search-submit').click();
    await expect(picker.getByTestId('gmail-results').locator('li')).toHaveCount(1);
    await expect(picker.getByTestId('gmail-results')).toContainText('jana.dvorakova@corvane.example');   // the owner sees their own mail
    await shot(a.page, 'gmail-picker');
    await picker.locator('input[type="checkbox"]').first().check();
    await picker.getByTestId('gmail-attach-selected').click();
    await expect(m.getByTestId('gmail-message')).toContainText('Připojeno e-mailů: 1.');
    await expect(gmailList(a.page).locator('li')).toHaveCount(1);
    await expect(gmailList(a.page)).toContainText('Konverzace · 3 zprávy · od Jana Dvořáková (simulace)');
    // realtime: no reload for the editor and the viewer
    await expect(gmailList(b.page).locator('li')).toHaveCount(1, { timeout: 15_000 });
    await expect(gmailList(c.page).locator('li')).toHaveCount(1, { timeout: 15_000 });
    await expect(gmailList(b.page)).not.toContainText('@corvane.example');                // no address for teammates
    // duplicate
    await m.getByTestId('gmail-attach').click();
    await picker.getByTestId('gmail-filter-text').fill('redesign');
    await picker.getByTestId('gmail-search-submit').click();
    await expect(picker.getByTestId('gmail-results').locator('li')).toHaveCount(1);
    await picker.locator('input[type="checkbox"]').first().check();
    await picker.getByTestId('gmail-attach-selected').click();
    await expect(m.getByTestId('gmail-message')).toContainText('už byl připojený');
    await expect(gmailList(a.page).locator('li')).toHaveCount(1);
  });

  await test.step('a single message (HTML newsletter) is attached; owner-only preview shows safe text, nothing remote', async () => {
    const m = filesModal(a.page);
    await m.getByTestId('gmail-attach').click();
    const picker = a.page.getByTestId('gmail-picker');
    await picker.getByTestId('gmail-kind-message').click();
    await picker.getByTestId('gmail-filter-subject').fill('Newsletter');
    await picker.getByTestId('gmail-search-submit').click();
    await expect(picker.getByTestId('gmail-results').locator('li')).toHaveCount(1);
    await picker.locator('input[type="checkbox"]').first().check();
    await picker.getByTestId('gmail-attach-selected').click();
    await expect(gmailList(a.page).locator('li')).toHaveCount(2);
    const remote: string[] = [];
    a.page.on('request', (r) => { if (/tracker\.example|evil\.example/.test(r.url())) remote.push(r.url()); });
    const row = gmailList(a.page).locator('li', { hasText: 'Newsletter' });
    await row.getByTestId('gmail-preview').click();
    const pv = a.page.getByTestId('gmail-preview-modal');
    await expect(pv.getByTestId('gmail-preview-text')).toContainText('Novinky listopadu');
    await expect(pv).toContainText('Zobrazeno jako prostý text (z HTML)');
    expect(await pv.locator('img, iframe, script, form').count()).toBe(0);
    await expect(pv.getByTestId('gmail-open')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(remote).toEqual([]);
    await shot(a.page, 'gmail-preview');
    await pv.getByRole('button', { name: /zavřít/i }).first().click().catch(async () => { await a.page.keyboard.press('Escape'); });
    // teammates: no preview button on someone else's e-mail
    await expect(gmailList(b.page).locator('li')).toHaveCount(2, { timeout: 15_000 });
    await expect(gmailList(b.page).getByTestId('gmail-preview')).toHaveCount(0);
    await expect(gmailList(c.page).getByTestId('gmail-preview')).toHaveCount(0);
    await expect(gmailList(c.page).getByTestId('gmail-remove')).toHaveCount(0);
  });

  await test.step('timeline: activity without the subject', async () => {
    await b.page.keyboard.press('Escape');
    await b.page.getByTestId('activity-feed-btn').click();
    await expect(b.page.getByTestId('activity-feed-list')).toContainText('připojil(a) k projektu e-mailovou konverzaci z Gmailu');
    await expect(b.page.getByTestId('activity-feed-list')).toContainText('připojil(a) k projektu e-mail z Gmailu');
    await expect(b.page.getByTestId('activity-feed-list')).not.toContainText('Newsletter');
    await b.page.getByTestId('activity-feed-close-btn').click();
  });

  await test.step('task drawer: attach an e-mail to the task; the editor sees it in their drawer live', async () => {
    await a.page.keyboard.press('Escape');
    await a.page.getByTestId(`card-${P}-k1`).click();
    const sec = a.page.getByTestId('task-detail-drawer').getByTestId('task-gmail-section');
    await expect(a.page.getByTestId('task-detail-drawer').getByTestId('task-drive-section')).toBeVisible();   // Drive still there
    await b.page.getByTestId(`card-${P}-k1`).click();
    const bsec = b.page.getByTestId('task-detail-drawer').getByTestId('task-gmail-section');
    await expect(bsec.getByTestId('gmail-empty')).toBeVisible();
    await sec.getByTestId('gmail-attach').click();
    const picker = a.page.getByTestId('gmail-picker');
    await picker.getByTestId('gmail-kind-message').click();
    await picker.getByTestId('gmail-filter-from').fill('Účtárna');
    await picker.getByTestId('gmail-search-submit').click();
    await picker.locator('input[type="checkbox"]').first().check();
    await picker.getByTestId('gmail-attach-selected').click();
    await expect(sec.getByTestId('gmail-list').locator('li')).toHaveCount(1);
    await expect(sec.getByTestId('gmail-list')).toContainText('Faktura 2026-118');
    await expect(bsec.getByTestId('gmail-list').locator('li')).toHaveCount(1, { timeout: 15_000 });
    await sec.getByTestId('gmail-preview').click();
    await expect(a.page.getByTestId('gmail-preview-attachments')).toContainText('faktura-2026-118.pdf');
    await a.page.getByTestId('gmail-preview-modal').getByRole('button', { name: /zavřít/i }).first().click();   // not Escape: that would also close the drawer
    await expect(a.page.getByTestId('gmail-preview-modal')).toHaveCount(0);
    await expect(bsec.getByTestId('gmail-list')).toContainText('2 přílohy', { timeout: 15_000 });   // shared count refreshed live
    await shot(a.page, 'task-drawer-gmail');
  });

  await test.step('editor removes the owner\'s link (association only); disappears live for everyone', async () => {
    await b.page.getByTestId('task-detail-drawer').getByTestId('task-gmail-section').getByTestId('gmail-remove').click();
    await answerConfirm(b.page, { contains: 'Ve vaší schránce Gmail se nic nezmění' });
    await expect(b.page.getByTestId('task-detail-drawer').getByTestId('task-gmail-section').getByTestId('gmail-empty')).toBeVisible();
    await expect(a.page.getByTestId('task-detail-drawer').getByTestId('task-gmail-section').getByTestId('gmail-empty')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('layout: viewer on mobile in dark mode, no horizontal overflow; style applied', async () => {
    await c.page.goto(`/projects/${P}`);
    await c.page.getByTestId('project-files-btn').click();
    await expect(gmailList(c.page).locator('li')).toHaveCount(2);
    await noOverflow(c.page);
    expect(await c.page.evaluate(() => document.documentElement.dataset.style ?? 'existing')).toBe(STYLE);
    await shot(c.page, 'project-resources-mobile-dark');
  });

  for (const s of [a, b, c]) await s.ctx.close();
});
