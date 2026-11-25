import { test, expect } from '@playwright/test';

/**
 * DEV LOGIN STANDARD (docs/LOCAL_DEV.md) on an isolated collab/drive stack app started by
 * `scripts/collab-stack.sh app` (or drive-stack.sh / google-live.sh app). A brand-new browser context with NO credentials
 * opens one link and is signed in as the stack owner through a REAL Supabase Auth session: RLS and Realtime apply.
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 E2E_DEV_LOGIN_STACK=1 E2E_SUPABASE_URL=... E2E_SUPABASE_ANON_KEY=... \
 *     npx playwright test e2e/dev-login-stack.spec.ts
 */
test.skip(process.env.E2E_DEV_LOGIN_STACK !== '1' || !process.env.E2E_SUPABASE_URL, 'needs an app started by collab-stack.sh app (dev login enabled)');
const SB = process.env.E2E_SUPABASE_URL as string;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const P = 'project-collab-demo';

test('one link, no credentials: signed in as the project owner with a real, RLS-bound session and live Realtime', async ({ browser, request }) => {
  const ctx = await browser.newContext();   // fresh: no cookies, no storage, nothing typed
  const page = await ctx.newPage();
  await page.goto('/settings?login=auto');
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByTestId('google-connection-card')).toBeVisible({ timeout: 20_000 });
  expect(await page.getByText('simulace').count()).toBe(0);                    // real-Google mode shows no mock label (mock mode does)

  // the browser holds an ordinary Supabase session for the owner (no token in the page source, no dev identity object)
  const session = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x));
    return k ? JSON.parse(localStorage.getItem(k) as string) : null;
  });
  expect(session?.user?.email).toBe('alice@collab.test');
  const rest = (path: string, token: string) => request.get(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  const mine = await (await rest('projects?select=id', session.access_token)).json();
  expect(mine.map((r: { id: string }) => r.id)).toContain(P);                  // owner: sees the seeded project
  expect([401, 403]).toContain((await rest('projects?select=id', ANON)).status());   // anonymous: no table access at all
  expect((await rest('google_connections?select=*', session.access_token)).status()).toBeGreaterThanOrEqual(401); // RLS/grants unchanged

  // the session survives a reload and works for the project board with Realtime live
  await page.reload();
  await expect(page.getByTestId('google-connection-card')).toBeVisible();
  await page.goto(`/projects/${P}?login=auto`);
  await expect(page.getByText('Připravit podklady pro klienta')).toBeVisible({ timeout: 20_000 });
  // Realtime proof: a write made OUTSIDE the page (owner's own token over REST) shows up on the open board without a reload
  const title = `Realtime dev-login ${Date.now().toString(36)}`;
  const id = `${P}-rt-${Date.now().toString(36)}`;
  await page.waitForTimeout(2500);   // let the private channel join
  const ins = await request.post(`${SB}/rest/v1/cards`, { headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, data: { id, column_id: `${P}-column-1`, title } });
  expect(ins.status()).toBe(201);
  try {
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
  } finally {
    await request.delete(`${SB}/rest/v1/cards?id=eq.${id}`, { headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}` } });
  }
  await ctx.close();
});

test('explicit login stays testable: ?login=manual shows the login form instead of signing in', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login?login=manual');
  await expect(page.getByPlaceholder('jmeno@firma.cz')).toBeVisible();
  await ctx.close();
});

test('the helper route refuses a spoofed host, tunnel headers and a missing marker', async ({ request, baseURL }) => {
  const url = `${baseURL}/api/dev/login`;
  expect((await request.post(url)).status()).toBe(404);
  expect((await request.post(url, { headers: { 'x-clearspace-dev-login': 'auto', host: 'clearspace-ai.vercel.app' } })).status()).toBe(404);
  expect((await request.post(url, { headers: { 'x-clearspace-dev-login': 'auto', 'cf-ray': 'x' } })).status()).toBe(404);
});
