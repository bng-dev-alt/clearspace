import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

/**
 * RUN 04 in the browser, on the LOCAL calendar stack (real GoTrue / PostgREST / Realtime, the real app) with the Google MOCK incl.
 * Calendar (scripts/google-mock.mjs) -- every Google screen here is a SIMULATION, clearly labelled as such. Own browser context per user.
 *   eval "$(frontend/scripts/calendar-stack.sh env)"
 *   [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3461 npx playwright test e2e/calendar.spec.ts --workers=1
 * The app must run with DEV_AUTO_LOGIN=0 (fresh contexts sign in themselves).
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const MOCK = process.env.GOOGLE_MOCK_URL;
const SHOTS = process.env.E2E_SHOTS_DIR;
const STYLE = process.env.E2E_STYLE === 'monograph' ? 'monograph' : 'existing';   // 'existing' = Classic
test.skip(!SB || !MOCK || !SERVICE || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local calendar stack + Google mock (scripts/calendar-stack.sh)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Calendar-04-Pass-123';
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
async function consent(page: Page, sub: string, { calendar = true, allow = true } = {}) {
  await expect(page.getByTestId('mock-banner')).toBeVisible();
  await page.getByTestId('mock-account').selectOption(sub);
  if (!calendar) await page.getByTestId('mock-grant-calendar').uncheck();
  await page.getByTestId(allow ? 'mock-allow' : 'mock-deny').click();
}
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${STYLE}-${name}.png`, fullPage: false }); };
/** Project calendar view on December 2026 (the synthetic events' month), whatever today is. */
async function calendarDecember(page: Page, P: string) {
  await page.evaluate(() => localStorage.setItem('board_view_mode', 'calendar'));
  await page.goto(`/projects/${P}`);
  const title = page.locator('.calendar-month-title');
  await expect(title).toBeVisible();
  for (let i = 0; i < 36; i++) {
    const t = (await title.textContent()) ?? '';
    const m = /(\d{4})/.exec(t); const y = Number(m?.[1] ?? 0);
    const months = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
    const mi = months.findIndex((x) => t.toLowerCase().startsWith(x + ' '));
    const diff = (2026 - y) * 12 + (11 - mi);
    if (diff === 0) return;
    await page.getByTestId(diff > 0 ? 'calendar-next' : 'calendar-prev').click();
    await expect(title).not.toHaveText(t);
  }
  throw new Error('could not reach December 2026');
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test(`Calendar (${STYLE}): incremental consent, personal layer (only me), attach own event to project and task, realtime, roles, privacy, removal`, async ({ browser, request }) => {
  test.setTimeout(300_000);
  await ctl(request, 'reset', {});
  await rest(request, `/rest/v1/google_connections?google_sub=in.(${ANNA},${BOHDAN},${CYRIL})`, { method: 'DELETE', key: SERVICE });
  const P = `e2e-cal-${run}`;
  const A = await signUp(request, 'own04', 'Alena Vlastníková');
  const B = await signUp(request, 'ed04', 'Bedřich Editor');
  const C = await signUp(request, 'view04', 'Cecílie Čtenářka');
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'Redesign portálu Corvane' }],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }]],
    ['/rest/v1/project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
    ['/rest/v1/cards', { id: `${P}-k1`, column_id: `${P}-a`, title: 'Připravit kickoff', due_date: '2026-12-01' }],
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

  await test.step('Propojené účty: Calendar alone (incremental, read-only); refusing it changes nothing', async () => {
    await a.page.goto('/settings');
    const card = a.page.getByTestId('google-connection-card');
    await expect(card.getByTestId('calendar-service-state')).toContainText('Nepovoleno');
    await card.getByTestId('calendar-connect-settings').click();
    await expect(a.page.getByTestId('mock-grant-drive')).toHaveCount(0);       // Calendar consent asks only Calendar (+ identity)
    await expect(a.page.getByTestId('mock-grant-gmail')).toHaveCount(0);
    await consent(a.page, ANNA, { calendar: false });
    await expect(a.page.getByTestId('google-connection-message')).toContainText('Přístup ke Google Kalendáři nebyl povolen');
    await a.page.getByTestId('calendar-connect-settings').click();
    await consent(a.page, ANNA);
    await expect(a.page.getByTestId('google-connection-message')).toContainText('Google Kalendář je připojený (jen čtení)');
    await expect(a.page.getByTestId('calendar-service-state')).toContainText('Povoleno – jen čtení');
    await expect(a.page.getByTestId('drive-service-state')).toContainText('Nepovoleno');
    await expect(card.getByTestId('google-privacy-calendar')).toContainText('Popis, místo, adresy účastníků a odkazy na schůzky se neukládají');
    await noOverflow(a.page);
    await shot(a.page, 'settings-calendar');
  });

  await test.step('project calendar: my layer only for me after I turn it on; editor without Google gets "connect"; viewer has no attach', async () => {
    for (const s of [a, b, c]) await calendarDecember(s.page, P);
    await expect(a.page.getByTestId('calendar-my-layer')).not.toBeChecked();
    await expect(a.page.locator('[data-testid^="calendar-event-m-"]')).toHaveCount(0);
    await a.page.getByTestId('calendar-my-layer').check();
    await expect(a.page.getByTestId('calendar-event-m-kickoffcorvane0001')).toBeVisible();
    await expect(a.page.getByTestId('calendar-event-m-pracovnimisto00001')).toHaveCount(0);                 // working-location marker
    await expect(a.page.locator('[data-testid="calendar-event-m-workshopbrno000001"]')).toHaveCount(3);      // 30. 11. - 2. 12. all-day
    await expect(a.page.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();          // untrusted title as text
    expect(await a.page.locator('.calendar-panel img').count()).toBe(0);
    await expect(b.page.getByTestId('calendar-layer-connect')).toBeVisible();
    await expect(b.page.getByTestId('calendar-layer-attach')).toHaveCount(0);
    await expect(b.page.locator('[data-testid^="calendar-event-m-"]')).toHaveCount(0);
    await expect(c.page.getByTestId('calendar-layer-attach')).toHaveCount(0);
    await shot(a.page, 'calendar-my-layer');
  });

  await test.step('private event: visible to me, cannot be attached', async () => {
    await a.page.getByTestId('calendar-event-m-lekarsoukrome00001').click();
    await expect(a.page.getByTestId('calendar-own-private')).toBeVisible();
    await expect(a.page.getByTestId('calendar-own-attach')).toHaveCount(0);
    await a.page.getByTestId('calendar-own-modal').getByRole('button', { name: /zavřít/i }).first().click();
  });

  await test.step('attach my event to the project; teammates see the shared metadata live, without my private details', async () => {
    await a.page.getByTestId('calendar-event-m-kickoffcorvane0001').click();
    await expect(a.page.getByTestId('calendar-own-modal')).toContainText('vidíte jen vy');
    await a.page.getByTestId('calendar-own-attach').click();
    const picker = a.page.getByTestId('calendar-picker');
    await expect(picker.getByText('simulace')).toBeVisible();
    await expect(picker.getByTestId('calendar-pick-kickoffcorvane0001')).toBeChecked();
    await expect(picker.getByTestId('calendar-pick-lekarsoukrome00001')).toBeDisabled();
    await picker.getByTestId('calendar-attach-selected').click();
    await expect(a.page.getByTestId('calendar-layer-message')).toContainText('Připojeno událostí: 1.');
    const linked = (p: Page) => p.locator('[data-testid^="calendar-event-l-"]');
    await expect(linked(a.page)).toHaveCount(1);
    await expect(linked(b.page)).toHaveCount(1, { timeout: 15_000 });      // realtime, no reload
    await expect(linked(c.page)).toHaveCount(1, { timeout: 15_000 });
    await linked(b.page).first().click();
    const modal = b.page.getByTestId('calendar-event-modal');
    await expect(modal.getByTestId('calendar-link-meta')).toContainText('4 účastníci · pořádá Jana Dvořáková (simulace) · připojil(a) Alena Vlastníková');
    const text = (await modal.textContent()) ?? '';
    for (const leak of ['SOUKROMÝ', 'Soukromá adresa', 'meet.google', 'ucastnik', '@']) expect(text).not.toContain(leak);
    await expect(modal.getByTestId('calendar-open')).toHaveCount(0);      // not his event
    await expect(modal.getByTestId('calendar-refresh')).toHaveCount(0);
    await expect(modal.getByTestId('calendar-remove')).toBeVisible();      // editor may remove the association
    await modal.getByRole('button', { name: /zavřít/i }).first().click();
    await linked(a.page).first().click();
    await expect(a.page.getByTestId('calendar-event-modal').getByTestId('calendar-open')).toBeVisible();   // the owner may open it
    await a.page.getByTestId('calendar-event-modal').getByRole('button', { name: /zavřít/i }).first().click();
  });

  await test.step('timeline: activity without the event title', async () => {
    await b.page.getByTestId('activity-feed-btn').click();
    await expect(b.page.getByTestId('activity-feed-list')).toContainText('připojil(a) k projektu událost z Google Kalendáře');
    await expect(b.page.getByTestId('activity-feed-list')).not.toContainText('Kickoff Corvane');
    await b.page.getByTestId('activity-feed-close-btn').click();
  });

  await test.step('task drawer: attach an event to the task (picker search); the editor sees it in the drawer live; editor removes it', async () => {
    for (const s of [a, b]) { await s.page.evaluate(() => localStorage.setItem('board_view_mode', 'board')); await s.page.goto(`/projects/${P}`); }
    await a.page.getByTestId(`card-${P}-k1`).click();
    const sec = a.page.getByTestId('task-detail-drawer').getByTestId('task-calendar-section');
    await expect(a.page.getByTestId('task-detail-drawer').getByTestId('task-drive-section')).toBeVisible();   // Drive / Gmail sections still there
    await b.page.getByTestId(`card-${P}-k1`).click();
    const bsec = b.page.getByTestId('task-detail-drawer').getByTestId('task-calendar-section');
    await expect(bsec.getByTestId('calendar-empty')).toBeVisible();
    await sec.getByTestId('calendar-attach').click();
    const picker = a.page.getByTestId('calendar-picker');
    await picker.getByTestId('calendar-filter-from').fill('2026-12-01');
    await picker.getByTestId('calendar-filter-to').fill('2026-12-31');
    await picker.getByTestId('calendar-filter-q').fill('konference');
    await picker.getByTestId('calendar-search-submit').click();
    await picker.getByTestId('calendar-pick-konferencenoc00001').check();
    await picker.getByTestId('calendar-attach-selected').click();
    await expect(sec.getByTestId('calendar-list').locator('li')).toHaveCount(1);
    await expect(sec.getByTestId('calendar-list')).toContainText('10. 12. 2026 16:00 – 11. 12. 2026 12:00');
    await expect(bsec.getByTestId('calendar-list').locator('li')).toHaveCount(1, { timeout: 15_000 });
    await shot(a.page, 'task-drawer-calendar');
    b.page.once('dialog', (d) => { expect(d.message()).toContain('Ve vašem Google Kalendáři se nic nezmění'); void d.accept(); });
    await bsec.getByTestId('calendar-remove').click();
    await expect(bsec.getByTestId('calendar-empty')).toBeVisible();
    await expect(sec.getByTestId('calendar-empty')).toBeVisible({ timeout: 15_000 });
  });

  await test.step('layout: viewer on mobile in dark mode, no horizontal overflow; day detail lists the event; style applied', async () => {
    await calendarDecember(c.page, P);
    await expect(c.page.getByTestId('calendar-layer-attach')).toHaveCount(0);
    await c.page.getByTestId('calendar-day-tap-2026-12-01').click();
    await expect(c.page.getByTestId('calendar-day-detail')).toContainText('Kickoff Corvane');
    await noOverflow(c.page);
    expect(await c.page.evaluate(() => document.documentElement.dataset.style ?? 'existing')).toBe(STYLE);
    await shot(c.page, 'calendar-mobile-dark');
  });

  for (const s of [a, b, c]) await s.ctx.close();
});
