import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { answerConfirm } from './support/confirm';

/**
 * RUN 05 in the browser, on the LOCAL notify stack (real GoTrue / PostgREST / Realtime / Postgres + pg_net, the real app) with the
 * Slack + Telegram MOCK (scripts/notify-mock.mjs) -- every Slack / Telegram screen and message here is a SIMULATION. Own context per user.
 *   eval "$(frontend/scripts/notify-stack.sh env)"
 *   [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3471 npx playwright test e2e/notify.spec.ts --workers=1
 * The app must run with DEV_AUTO_LOGIN=0 (fresh contexts sign in themselves). Scheduler ticks are run by hand (same SQL as pg_cron).
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const MOCK = process.env.NOTIFY_MOCK_URL;
const SECRET = process.env.NOTIFY_SERVER_SECRET ?? '';
const DBC = process.env.NOTIFY_DB_CONTAINER || 'supabase_db_cs-notify-sb';
const SHOTS = process.env.E2E_SHOTS_DIR;
const STYLE = process.env.E2E_STYLE === 'monograph' ? 'monograph' : 'existing';   // 'existing' = Classic
test.skip(!SB || !MOCK || !SERVICE || !SECRET || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local notify stack + Slack/Telegram mock (scripts/notify-stack.sh)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Notify-05-Pass-123';
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
const ctl = (request: APIRequestContext, name: string, data?: unknown) => (data === undefined ? request.get(`${MOCK}/__control/${name}`) : request.post(`${MOCK}/__control/${name}`, { data }));
const sql = (q: string) => execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD=postgres', DBC, 'psql', '-h', 'localhost', '-U', 'supabase_admin', '-d', 'postgres', '-At', '-q', '-c', q], { encoding: 'utf8' }).trim();
async function tick() {
  const r = JSON.parse(sql('select public.notify_scheduler_tick()'));
  if (r.request) for (let i = 0; i < 150 && sql(`select count(*) from net._http_response where id = ${r.request}`) !== '1'; i++) await new Promise((x) => setTimeout(x, 400));
  sql('select public.notify_scheduler_tick()');
  return r;
}
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
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${STYLE}-${name}.png`, fullPage: false }); };
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test(`Notifications outside the app (${STYLE}): Telegram link + confirm, Slack OAuth, preferences, delivery with deep link, in-app bell independent, test, disconnect`, async ({ browser, request }) => {
  test.setTimeout(300_000);
  await ctl(request, 'reset', {});
  // the scheduler secret + URL for hand ticks (no pg_cron job: ticks run only when this test says so)
  sql('create extension if not exists pg_net with schema extensions');
  for (const [name, value] of [['clearspace_notify_url', `http://host.docker.internal:${new URL(process.env.PLAYWRIGHT_TEST_BASE_URL!).port}/api/notify/dispatch`], ['clearspace_notify_secret', SECRET]]) {
    const id = sql(`select id from vault.secrets where name = '${name}'`);
    sql(id ? `select vault.update_secret('${id}', '${value}')` : `select vault.create_secret('${value}', '${name}')`);
  }
  const P = `e2e-ntf-${run}`, CARD = `${P}-k1`;
  const A = await signUp(request, 'own05', 'Alena Vlastníková');
  const B = await signUp(request, 'ed05', 'Bedřich Editor');
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'Stěhování kanceláře Corvane' }],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-d`, project_id: P, name: 'Hotovo', position: 1 }]],
    ['/rest/v1/project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
    ['/rest/v1/cards', { id: CARD, column_id: `${P}-a`, title: 'Objednat stěhovací firmu', due_date: '2026-12-01' }],
  ] as const) {
    const r = await rest(request, path, { method: 'POST', token: A.token, data, minimal: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  const inv = await rest(request, '/rest/v1/rpc/create_project_invitation', { method: 'POST', token: A.token, data: { p_project_id: P, p_email: B.email, p_role: 'member' } });
  await rest(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: B.token, data: { p_token: inv.json[0].token, p_display_name: B.name } });
  const memberB = (await rest(request, `/rest/v1/workspace_members?profile_id=eq.${B.id}&owner_id=eq.${A.id}&select=id`, { key: SERVICE })).json[0].id;

  const b = await login(browser, B);                                              // desktop, light
  const a = await login(browser, A, { width: 375, height: 812 }, 'dark');         // phone, dark

  await test.step('Telegram: deep link -> "Start" in Telegram (simulated) -> found chat confirmed in ClearSpace', async () => {
    await b.page.goto('/settings');
    const card = b.page.getByTestId('notify-card');
    await expect(card.getByRole('heading', { name: /Osobní oznámení/ })).toBeVisible();   // RUN 11: personal vs project sections
    await expect(card.getByTestId('telegram-service-state')).toHaveText('Nepřipojeno.');
    await card.getByTestId('telegram-connect').click();
    const href = await card.getByTestId('telegram-link-box-open').getAttribute('href');
    expect(href).toMatch(/^https:\/\/t\.me\/clearspace_mock_bot\?start=[A-Za-z0-9_-]{43}$/);
    expect(await card.getByTestId('telegram-link-box-open').getAttribute('rel')).toContain('noopener');
    await ctl(request, 'telegram-start', { token: new URL(href!).searchParams.get('start'), chatId: 9101, firstName: 'Bedřich', username: 'bedrich_e2e' });
    await expect(card.getByTestId('telegram-confirm')).toBeVisible({ timeout: 15_000 });   // the card polls by itself
    await expect(card.getByTestId('telegram-service-state')).toContainText('Bedřich (@bedrich_e2e)');
    await shot(b.page, 'telegram-confirm');
    await card.getByTestId('telegram-confirm').click();
    await expect(card.getByTestId('notify-message')).toContainText('Telegram je připojený');
    await expect(card.getByTestId('telegram-service-state')).toContainText('Aktivní');
    const msgs = (await (await ctl(request, 'messages')).json()).telegram.filter((m: { chatId: number }) => m.chatId === 9101);
    expect(msgs.map((m: { text: string }) => m.text)).toEqual(['Propojení čeká na potvrzení. Dokončete ho v ClearSpace → Nastavení → Propojené účty → Osobní oznámení.', 'Hotovo – oznámení z ClearSpace budou chodit sem.']);
  });

  await test.step('Slack (phone, dark): OAuth with the simulated Slack consent, back to Settings', async () => {
    await a.page.goto('/settings');
    const card = a.page.getByTestId('notify-card');
    await card.getByTestId('slack-connect').click();
    await expect(a.page).toHaveURL(/\/slack\/oauth\/v2\/authorize\?/);
    await a.page.getByTestId('slack-mock-who').selectOption('T0MOCK01|U0MOCKANNA');
    await a.page.getByTestId('slack-mock-allow').click();
    await expect(a.page).toHaveURL(/\/settings$/);
    await expect(a.page.getByTestId('notify-message')).toContainText('Slack je připojený');
    await expect(a.page.getByTestId('slack-service-state')).toContainText('Corvane (simulace)');
    await noOverflow(a.page);
    await shot(a.page, 'slack-connected-mobile-dark');
  });

  await test.step('preferences: switch a type off, keep the rest; persists', async () => {
    const card = b.page.getByTestId('notify-card');
    await card.getByTestId('notify-type-task_completed').uncheck();
    await card.getByTestId('notify-save').click();
    await expect(card.getByTestId('notify-message')).toContainText('Nastavení oznámení je uložené');
    await b.page.reload();
    await expect(b.page.getByTestId('notify-type-task_completed')).not.toBeChecked();
    await expect(b.page.getByTestId('notify-type-assignment')).toBeChecked();
  });

  await test.step('assignment: bell in the app (realtime) AND a Telegram message with a deep link that opens the task', async () => {
    await b.page.goto('/');
    const r = await rest(request, '/rest/v1/card_assignees', { method: 'POST', token: A.token, data: { card_id: CARD, member_id: memberB }, minimal: true });
    expect(r.status).toBe(201);
    await b.page.getByTestId('notifications-bell').click();
    await expect(b.page.getByTestId('notifications-panel').locator('[data-type="assignment"]')).toBeVisible({ timeout: 15_000 });   // RUN 01 bell, unchanged
    await b.page.keyboard.press('Escape');
    const t = await tick();
    expect(t.sent).toBeGreaterThanOrEqual(1);
    const msg = (await (await ctl(request, 'messages')).json()).telegram.filter((m: { chatId: number }) => m.chatId === 9101).at(-1);
    expect(msg.text).toMatch(/^Stěhování kanceláře Corvane: .+ vám přiřadil\(a\) úkol „Objednat stěhovací firmu"\.\nOtevřít: /);
    const link = msg.text.split('Otevřít: ')[1];
    expect(link).toBe(`${process.env.PLAYWRIGHT_TEST_BASE_URL}/projects/${P}?task=${CARD}`);
    await b.page.goto(link);
    await expect(b.page.getByText('Objednat stěhovací firmu').first()).toBeVisible();
    await shot(b.page, 'deep-link-task');
    // completion is switched off for B -> nothing queued, but the in-app activity is unchanged
    await rest(request, `/rest/v1/cards?id=eq.${CARD}`, { method: 'PATCH', token: A.token, data: { column_id: `${P}-d` }, minimal: true });
    expect(sql(`select count(*) from public.notification_deliveries where user_id = '${B.id}' and kind = 'task_completed'`)).toBe('0');
  });

  await test.step('test message, pause, disconnect (keyboard reachable, Czech texts)', async () => {
    await b.page.goto('/settings');
    const card = b.page.getByTestId('notify-card');
    await card.getByTestId('telegram-test').focus();
    await b.page.keyboard.press('Enter');
    await expect(card.getByTestId('notify-message')).toHaveText('Zkušební zpráva odeslána.');
    await card.getByTestId('telegram-toggle').click();
    await expect(card.getByTestId('telegram-service-state')).toContainText('Pozastaveno');
    await shot(b.page, 'telegram-paused');
    await card.getByTestId('telegram-disconnect').click();
    await answerConfirm(b.page, { contains: 'přestane posílat vaše osobní oznámení' });
    await expect(card.getByTestId('notify-message')).toContainText('Telegram je odpojený');
    await expect(card.getByTestId('telegram-service-state')).toHaveText('Nepřipojeno.');
    await expect(b.page.getByTestId('google-connection-card')).toBeVisible();   // the Google card is untouched
  });

  await a.ctx.close(); await b.ctx.close();
});
