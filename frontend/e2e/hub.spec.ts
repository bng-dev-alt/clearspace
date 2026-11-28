import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { answerConfirm } from './support/confirm';

/**
 * RUN 07 in the browser, on the LOCAL hub stack (real GoTrue / PostgREST / Postgres, the real app) with the hub MOCK (scripts/hub-mock.mjs).
 * Every Slack / Telegram screen, message and webhook here is a SIMULATION; webhooks are signed by this test like the providers sign them.
 *   eval "$(frontend/scripts/hub-stack.sh env)"
 *   [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3471 npx playwright test e2e/hub.spec.ts --workers=1
 * The app must run with DEV_AUTO_LOGIN=0 (fresh contexts sign in themselves).
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const MOCK = process.env.HUB_MOCK_URL;
const SIGNING = process.env.SLACK_HUB_SIGNING_SECRET ?? '';
const TG_SECRET = process.env.TELEGRAM_HUB_WEBHOOK_SECRET ?? '';
const BOT = process.env.TELEGRAM_HUB_BOT_USERNAME ?? '';
const SHOTS = process.env.E2E_SHOTS_DIR;
const STYLE = process.env.E2E_STYLE === 'monograph' ? 'monograph' : 'existing';
// E2E_SCHEME=dark: the owner on a dark desktop and the member on a light phone (default: light desktop, dark phone)
const OWNER_SCHEME: 'light' | 'dark' = process.env.E2E_SCHEME === 'dark' ? 'dark' : 'light';
const MEMBER_SCHEME: 'light' | 'dark' = OWNER_SCHEME === 'dark' ? 'light' : 'dark';
test.skip(!SB || !MOCK || !SIGNING || !TG_SECRET || !process.env.PLAYWRIGHT_TEST_BASE_URL, 'needs the local hub stack + mock (scripts/hub-stack.sh)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const CH = `C0E2E${run.toUpperCase()}`;                          // per run: one channel = one project
const GROUP = -1007000000000 - (Date.now() % 1_000_000);
const PASSWORD = 'Hub-07-Pass-12345';
type U = { id: string; token: string; email: string; name: string };
const APP = () => process.env.PLAYWRIGHT_TEST_BASE_URL!;

async function rest(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; minimal?: boolean } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', Prefer: opts.minimal ? 'return=minimal' : 'return=representation' },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}
const ctl = (request: APIRequestContext, name: string, data?: unknown) => (data === undefined ? request.get(`${MOCK}/__control/${name}`) : request.post(`${MOCK}/__control/${name}`, { data }));
const messages = async (request: APIRequestContext) => (await ctl(request, 'messages')).json();
let upd = Number(`${Date.now()}`.slice(-8)) * 10, mid = 300;
// the webhook records the update and processes it right after answering (durable inbox): give it a moment
const tg = async (request: APIRequestContext, u: Record<string, unknown>) => {
  const r = await request.post(`${APP()}/api/hub/telegram/webhook`, {
    headers: { 'x-telegram-bot-api-secret-token': TG_SECRET, 'Content-Type': 'application/json' }, data: JSON.stringify({ update_id: ++upd, ...u }) });
  await new Promise((x) => setTimeout(x, 900));
  return r;
};
const tgMsg = (chat: number, from: number, text: string, extra: Record<string, unknown> = {}, type = 'supergroup') => ({ message: { message_id: ++mid, date: Math.floor(Date.now() / 1000), text,
  chat: { id: chat, type, title: 'Klient – stěhování' }, from: { id: from, is_bot: false, first_name: 'Jana' }, ...extra } });
const slackCommand = (request: APIRequestContext, text: string) => {
  const raw = new URLSearchParams({ team_id: 'T0HUB0001', team_domain: 'corvane', channel_id: CH, channel_name: 'stehovani', user_id: 'U0E2E0001', user_name: 'alena', command: '/clearspace', text }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  return request.post(`${APP()}/api/hub/slack/commands`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': ts,
    'x-slack-signature': `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${raw}`).digest('hex')}` }, data: raw });
};
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

test(`Communication hub (${STYLE}): Slack install, channel + group linking, capabilities, identity, task from chat, communication tab, read-only member, mobile`, async ({ browser, request }) => {
  test.setTimeout(300_000);
  await ctl(request, 'reset', {});
  const P = `e2e-hub-${run}`;
  const A = await signUp(request, 'own07', 'Alena Vlastníková');
  const B = await signUp(request, 'mem07', 'Bedřich Člen');
  for (const [path, data] of [
    ['/rest/v1/projects', { id: P, name: 'Stěhování kanceláře Corvane' }],
    ['/rest/v1/columns', [{ id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }, { id: `${P}-d`, project_id: P, name: 'Hotovo', position: 1 }]],
    ['/rest/v1/project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
  ] as const) {
    const r = await rest(request, path, { method: 'POST', token: A.token, data, minimal: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  const inv = await rest(request, '/rest/v1/rpc/create_project_invitation', { method: 'POST', token: A.token, data: { p_project_id: P, p_email: B.email, p_role: 'member' } });
  await rest(request, '/rest/v1/rpc/accept_workspace_invitation', { method: 'POST', token: B.token, data: { p_token: inv.json[0].token, p_display_name: B.name } });
  const a = await login(browser, A, { width: 1280, height: 800 }, OWNER_SCHEME);
  const modal = () => a.page.getByTestId('hub-integrations-modal');

  await test.step('Settings: install the project Slack app (simulated consent) -> installed', async () => {
    await a.page.goto('/settings');
    const card = a.page.getByTestId('hub-settings');
    await expect(card.getByRole('heading', { name: /Slack a Telegram pro projekty/ })).toBeVisible();
    await card.getByTestId('hub-slack-install').click();
    await expect(a.page).toHaveURL(/\/slack\/oauth\/v2\/authorize\?/);
    await a.page.getByTestId('slack-hub-mock-allow').click();
    await expect(a.page).toHaveURL(/\/settings$/);
    await expect(a.page.getByTestId('hub-settings-message')).toContainText('je ve Slacku nainstalovaná');
  });

  await test.step('Project → Integrace: Slack channel via code, confirmed by the owner', async () => {
    await ctl(request, 'slack-channel', { team: 'T0HUB0001', id: CH });
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('project-integrations-btn').click();
    await expect(modal()).toBeVisible();
    await modal().getByTestId('hub-connect-slack').click();
    const code = (await modal().getByTestId('hub-code-box-command').textContent())!.trim().split(' ').at(-1)!;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    await expect(modal().getByTestId('hub-code-box')).toContainText('/clearspace propojit');
    const r = await (await slackCommand(request, `propojit ${code}`)).json();
    expect(r.text).toContain('čeká na potvrzení');
    // RUN 08: no "refresh" button -- the modal notices the new channel by itself and closes the code box
    const dest = modal().getByTestId('hub-destination-slack');
    await expect(dest).toContainText('#stehovani', { timeout: 15_000 });
    await expect(modal().getByTestId('hub-code-box')).toHaveCount(0);
    await expect(dest).toContainText('čeká na potvrzení');
    await shot(a.page, 'hub-pending');
    await dest.getByTestId('hub-confirm').click();
    await expect(dest).toContainText('aktivní');
    // RUN 11 (#2, #8, #9): a clear success state with the next steps; Interaktivní stays off until the manager turns it on
    await expect(dest.getByTestId('hub-linked-ok')).toContainText('Propojeno ✓');
    await expect(dest.getByTestId('hub-linked-ok')).toContainText('/invite @ClearSpace Projekty');
    await expect(dest.getByTestId('hub-linked-interactive')).toBeVisible();
    await expect(dest.getByTestId('hub-cap-notify')).toBeChecked();
    await expect(dest.getByTestId('hub-cap-interactive')).not.toBeChecked();
    // RUN 11 (D10): PI is never a ticked box when the server does not do it
    const piBox = dest.getByTestId('hub-cap-intelligence');
    if (await piBox.count()) await expect(piBox).not.toBeChecked();
    else await expect(dest.getByTestId('hub-cap-intelligence-off')).toContainText('na tomto serveru vypnuto');
    await dest.getByTestId('hub-test').click();
    await expect(modal().getByTestId('hub-message')).toContainText('Zkušební zpráva odeslána');
    await expect(modal().getByTestId('hub-message')).toContainText('skutečná oznámení chodí souhrnně');   // RUN 11 (#6)
    const sm = (await messages(request)).slack;
    expect(sm.at(-1).channel).toBe(CH);
  });

  await test.step('Telegram group via code (group admin), interactive on, PI stays off (needs an informed confirmation)', async () => {
    await ctl(request, 'telegram-chat', { chatId: GROUP, type: 'supergroup', admins: [8801] });
    await modal().getByTestId('hub-connect-telegram').click();
    const code = (await modal().getByTestId('hub-code-box-command').textContent())!.trim().split(' ').at(-1)!;
    await tg(request, tgMsg(GROUP, 8801, `/link@${BOT} ${code}`));
    const dest = modal().getByTestId('hub-destination-telegram');
    await expect(dest).toBeVisible({ timeout: 15_000 });
    await dest.getByTestId('hub-confirm').click();
    await expect(dest).toContainText('aktivní');
    await dest.getByTestId('hub-cap-interactive').click();      // controlled: checked once the server saved it
    await expect(dest.getByTestId('hub-cap-interactive')).toBeChecked();
    // RUN 11 (#5, #12): the exact /task command with the bot name, copyable
    await expect(dest.getByTestId('hub-task-command')).toContainText(`/task@${BOT} Název úkolu`);
    await expect(dest.getByTestId('hub-task-command-copy')).toBeVisible();
    const pi = dest.getByTestId('hub-cap-intelligence');
    if ((await pi.count()) > 0 && (await pi.isEnabled())) {
      await pi.click();
      await expect(modal().getByTestId('hub-pi-confirm')).toContainText('jen vybrané zprávy');      // honest scope (privacy mode)
      await modal().getByTestId('hub-pi-cancel').click();
      await expect(pi).not.toBeChecked();
      await pi.click();
      await modal().getByTestId('hub-pi-accept').click();
      await expect(dest.getByTestId('hub-pi-scope')).toContainText('jen vybrané zprávy');
      const full = dest.getByTestId('hub-cap-full-ingest');
      if (await full.count()) {                                                       // optional PI bot configured on this server
        await full.click();
        await expect(modal().getByTestId('hub-pi-confirm')).toContainText('celá komunikace skupiny');
        await modal().getByTestId('hub-pi-accept').click();
        await expect(dest.getByTestId('hub-pi-scope')).toContainText('samostatný PI bot');
      }
      await shot(a.page, `hub-pi-scope-${OWNER_SCHEME}`);
      await pi.click();                                                                // off again: imports are deleted
      await expect(pi).not.toBeChecked();
    } else {
      await expect(dest).toContainText('Na serveru vypnuto');
    }
    await expect(modal().getByTestId('hub-audit')).toContainText('Historie změn');
    await shot(a.page, `hub-integrations-${OWNER_SCHEME}`);
    await a.page.keyboard.press('Escape');
  });

  await test.step('identity (RUN 07B): code started in Settings -> sent from the Telegram account via the deep link -> linked', async () => {
    await ctl(request, 'telegram-chat', { chatId: 8801, type: 'private' });
    await a.page.goto('/settings');
    await a.page.getByTestId('hub-identity-telegram').click();
    const href = await a.page.getByTestId('hub-identity-code-box-open').getAttribute('href');
    expect(href).toMatch(new RegExp(`^https://t\\.me/${BOT}\\?start=[A-Z2-9]{10}$`));
    await tg(request, tgMsg(8801, 8801, `/start ${new URL(href!).searchParams.get('start')}`, {}, 'private'));
    expect((await messages(request)).telegram.at(-1).text).toContain('Alena Vlastníková');
    await shot(a.page, `hub-identity-${OWNER_SCHEME}`);
    await expect(a.page.getByTestId('hub-identities')).toContainText('Telegram: Jana', { timeout: 15_000 });   // detected by itself
  });

  await test.step('task from a Telegram message -> on the board, communication tab, conversation in the task', async () => {
    const src = ++mid;
    await tg(request, tgMsg(GROUP, 8801, `/task@${BOT} Objednat stěhovací firmu`, { reply_to_message: { message_id: src, date: 1800000000, text: 'Kdo objedná stěhováky na pátek?', from: { id: 8802, is_bot: false, first_name: 'Karel' } } }));
    const conf = (await messages(request)).telegram.at(-1);
    expect(conf.text).toContain('Vytvořen úkol v ClearSpace');
    await tg(request, tgMsg(GROUP, 8801, 'Firma potvrzena na 9:00', { reply_to_message: { message_id: conf.messageId, from: { id: 200000002, is_bot: true, username: BOT } } }));
    await a.page.goto(`/projects/${P}`);
    await expect(a.page.getByText('Objednat stěhovací firmu')).toBeVisible();
    await a.page.getByTitle('Aktivita projektu').click();
    await a.page.getByTestId('activity-tab-communication').click();
    const list = a.page.getByTestId('hub-communication');
    await expect(list.getByTestId('hub-scope')).toContainText('Jen komunikace z kanálů a skupin propojených');
    await expect(list.getByTestId('hub-msg-list')).toContainText('Kdo objedná stěhováky na pátek?');
    await list.getByTestId('hub-search').fill('9:00');
    await expect(list.getByTestId('hub-msg-list').locator('li')).toHaveCount(1);
    await shot(a.page, 'hub-communication');
    await list.getByTestId('hub-msg-open-card').first().click();
    await expect(a.page.getByTestId('hub-task-conversation')).toContainText('Firma potvrzena na 9:00');
    await expect(a.page.getByTestId('hub-task-conversation')).toContainText('Telegram');
    await expect(a.page.getByTestId('hub-task-conversation')).toContainText('Alena Vlastníková');   // verified author by name
    await shot(a.page, 'hub-task-conversation');
  });

  await test.step('member (phone, dark): read-only integrations, no connect buttons, no overflow', async () => {
    const b = await login(browser, B, { width: 375, height: 812 }, MEMBER_SCHEME);
    await b.page.goto(`/projects/${P}`);
    await b.page.getByTestId('project-integrations-btn').click();
    const m = b.page.getByTestId('hub-integrations-modal');
    await expect(m.getByTestId('hub-destination-telegram')).toContainText('aktivní');
    await expect(m.getByTestId('hub-connect')).toHaveCount(0);
    await expect(m.getByTestId('hub-test')).toHaveCount(0);
    await expect(m.getByTestId('hub-cap-notify').first()).toBeDisabled();
    await expect(m).toContainText('Propojení spravují vlastník a správci projektu');
    await noOverflow(b.page);
    await shot(b.page, `hub-member-mobile-${MEMBER_SCHEME}`);
    await b.ctx.close();
  });

  await test.step('disconnect: the group goes away at once', async () => {
    await a.page.goto(`/projects/${P}`);
    await a.page.getByTestId('project-integrations-btn').click();
    const dest = modal().getByTestId('hub-destination-telegram');
    await dest.getByTestId('hub-remove').click();
    // RUN 11: one dialog – disconnect yes, "also delete message records" left unchecked (= keep history), and it says the bot leaves the group
    await answerConfirm(a.page, { contains: 'Bot ClearSpace pak skupinu sám opustí', option: false });
    await expect(modal().getByTestId('hub-message')).toContainText('je odpojený');
    await expect(modal().getByTestId('hub-destination-telegram')).toHaveCount(0);
  });
  await a.ctx.close();
});
