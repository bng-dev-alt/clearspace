import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * RUN 01C: acceptance of an invitation on the HOSTED production stack with TWO DISPOSABLE confirmed accounts
 * (created and deleted by a wrapper script; this spec holds no service key). Nothing is ever e-mailed: the invitee
 * is an @example.test address (reserved domains are suppressed server-side) and the link comes from the route's response.
 * Covers: invitation route -> signed-in invitee accepts -> project access -> live card update -> presence -> removal.
 *   E2E_HOSTED_COLLAB=1 E2E_HOSTED_URL=https://<ref>.supabase.co E2E_HOSTED_ANON=<anon> E2E_PASSWORD=.. E2E_A_EMAIL=.. E2E_B_EMAIL=..
 *   PLAYWRIGHT_TEST_BASE_URL=https://clearspace-ai.vercel.app npx playwright test e2e/collaboration-01c-hosted.spec.ts
 */
const SB = process.env.E2E_HOSTED_URL ?? '';
const ANON = process.env.E2E_HOSTED_ANON ?? '';
const PW = process.env.E2E_PASSWORD ?? '';
const A_EMAIL = process.env.E2E_A_EMAIL ?? '';
const B_EMAIL = process.env.E2E_B_EMAIL ?? '';
const APP = process.env.PLAYWRIGHT_TEST_BASE_URL ?? '';
test.skip(process.env.E2E_HOSTED_COLLAB !== '1' || !SB || !ANON || !PW || !A_EMAIL || !B_EMAIL || !APP, 'needs the hosted collaboration harness');
test.skip(!/^https:\/\/twjlnsxjtuntujarwner\.supabase\.co$/.test(SB), 'only the ClearSpace V1 project');

const run = Date.now().toString(36);
async function rest(request: APIRequestContext, method: string, path: string, token: string, data?: unknown) {
  const res = await request.fetch(`${SB}${path}`, { method, headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, data: data === undefined ? undefined : JSON.stringify(data) });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}
async function signIn(request: APIRequestContext, email: string) {
  const r = await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON, 'Content-Type': 'application/json' }, data: { email, password: PW } });
  expect(r.status()).toBe(200);
  const j = await r.json();
  return { token: j.access_token as string, id: j.user.id as string };
}
async function uiLogin(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PW);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();
}

test('production: invitation -> signed-in invitee accepts -> project access, live update, presence -> removal', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const P = `hc-${run}`;
  const A = await signIn(request, A_EMAIL);
  const B = await signIn(request, B_EMAIL);
  try {
    for (const [path, data] of [
      ['projects', { id: P, name: 'Přijímací kontrola' }],
      ['columns', { id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }],
      ['project_members', { project_id: P, member_id: `member-owner-${A.id}` }],
      ['cards', { id: `${P}-k1`, column_id: `${P}-a`, title: 'Úvodní úkol' }],
    ] as const) {
      const r = await rest(request, 'POST', `/rest/v1/${path}`, A.token, data);
      expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    // B has no access yet
    expect((await rest(request, 'GET', `/rest/v1/cards?id=eq.${P}-k1&select=id`, B.token)).body).toEqual([]);

    // invitation through the app's own server route (suppressed: reserved domain, nothing is sent)
    const inv = await request.post(`${APP}/api/collab/invitations`, { headers: { Authorization: `Bearer ${A.token}`, 'Content-Type': 'application/json' }, data: { projectId: P, email: B_EMAIL, role: 'member' } });
    expect(inv.status()).toBe(201);
    const invBody = await inv.json();
    expect(invBody.delivery.status).toBe('suppressed');
    const link = new URL(invBody.link);
    expect(link.origin).toBe(new URL(APP).origin);

    const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
    const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
    await uiLogin(pageA, A_EMAIL);
    await uiLogin(pageB, B_EMAIL);

    // the members dialog shows the pending invitation
    await pageA.goto(`/projects/${P}`);
    await pageA.getByTestId('toolbar-manage-team-btn').click();
    await expect(pageA.getByText(B_EMAIL)).toBeVisible();
    await pageA.getByTestId('project-team-done-btn').click();

    // B (signed in) opens the e-mailed link and accepts
    await pageB.goto(`${link.pathname}${link.search}`);
    await expect(pageB.getByTestId('accept-invite-preview')).toContainText('Olga Zkušební'); // by design the preview names the inviter, never the project
    const name = pageB.getByTestId('accept-invite-name-input');
    if (await name.isVisible().catch(() => false)) await name.fill('Bára Zkušební');
    await pageB.getByTestId('accept-invite-submit-btn').click();
    await expect(pageB.getByTestId('accept-invite-success')).toBeVisible();

    // project access
    await pageB.goto(`/projects/${P}`);
    await expect(pageB.locator('[data-testid^="card-"]', { hasText: 'Úvodní úkol' })).toBeVisible();
    // live update A -> B, no reload
    expect((await rest(request, 'POST', '/rest/v1/cards', A.token, { id: `${P}-k2`, column_id: `${P}-a`, title: 'Živě přidaný úkol' })).status).toBe(201);
    await expect(pageB.locator('[data-testid^="card-"]', { hasText: 'Živě přidaný úkol' })).toBeVisible({ timeout: 15_000 });
    // presence: each sees the other
    await pageA.reload();
    await expect(pageA.getByTestId('presence-stack')).toBeVisible({ timeout: 20_000 });
    await expect(pageA.getByTestId(`presence-user-${B.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByTestId(`presence-user-${A.id}`)).toBeVisible({ timeout: 20_000 });
    // the used link no longer works
    const again = await ctxB.newPage();
    await again.goto(`${link.pathname}${link.search}`);
    await expect(again.getByTestId('accept-invite-unavailable')).toBeVisible();

    // owner removes B: access disappears at the database
    const row = await rest(request, 'GET', `/rest/v1/project_members?project_id=eq.${P}&select=member_id`, A.token);
    expect(row.body.length).toBe(2);
    const bMember = row.body.find((m: { member_id: string }) => m.member_id !== `member-owner-${A.id}`).member_id as string;
    expect((await rest(request, 'DELETE', `/rest/v1/project_members?project_id=eq.${P}&member_id=eq.${encodeURIComponent(bMember)}`, A.token)).status).toBe(204);
    expect((await rest(request, 'GET', `/rest/v1/cards?id=eq.${P}-k1&select=id`, B.token)).body).toEqual([]);
    await ctxA.close(); await ctxB.close();
  } finally {
    await rest(request, 'DELETE', `/rest/v1/projects?id=eq.${P}`, A.token);
    await rest(request, 'DELETE', `/rest/v1/invitations?project_id=eq.${P}`, A.token);
  }
});
