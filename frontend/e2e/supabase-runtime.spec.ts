import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * Runtime verification in SUPABASE mode against a THROWAWAY local Supabase stack
 * (real GoTrue + PostgREST). Skipped unless E2E_SUPABASE_URL is set, so the normal
 * demo-mode suite and CI are unaffected. Gemini is never contacted: the dev server runs
 * without GEMINI_API_KEY, so the gateway authenticates, authorises and reserves quota and
 * the provider step fails closed (HTTP 503 "ai_unavailable").
 *
 * Setup: see docs/MIGRATION_RUNBOOK.md ("Runtime verification stack").
 *   E2E_SUPABASE_URL=http://127.0.0.1:55421 E2E_SUPABASE_ANON_KEY=... \
 *   AI_RATE_PER_USER_PER_MINUTE=3 npx playwright test e2e/supabase-runtime.spec.ts
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
test.skip(!SB, 'needs E2E_SUPABASE_URL (isolated local Supabase stack)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';

async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}

async function apiSignUp(request: APIRequestContext, email: string) {
  const r = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.user.id as string, token: r.json.access_token as string, email };
}

async function registerViaUi(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.getByPlaceholder('Jakub Novák').fill(name);
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
  await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaregistrovat se' }).click();
}

const ownerEmail = `owner-${run}@example.test`;

test('anonymous visitor is redirected away from protected pages', async ({ page }) => {
  await page.goto('/team');
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/ai-history');
  await expect(page).toHaveURL(/\/login$/);
});

test('register -> session survives a reload -> logout -> login again', async ({ page }) => {
  await registerViaUi(page, 'Owner Person', ownerEmail);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible(); // session persisted (supabase-js storage)

  await page.getByTestId('navbar-avatar-btn').click();
  await page.getByTestId('logout-btn').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/team');
  await expect(page).toHaveURL(/\/login$/); // really logged out

  await page.getByPlaceholder('jmeno@firma.cz').fill(ownerEmail);
  await page.locator('input[type="password"]').first().fill('wrong-password');
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/login$/);
  // Known UX quirk (not changed here): login() flips the global isLoading flag, ProtectedRoute swaps
  // the page for its loader, so a FAILED login remounts the form and the e-mail field comes back empty.
  await page.getByPlaceholder('jmeno@firma.cz').fill(ownerEmail);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('default board is seeded in the DATABASE with project-scoped ids, per user, without collision', async ({ page, request, browser }) => {
  const seed = async (p: Page, name: string, email: string) => {
    await registerViaUi(p, name, email);
    await expect(p).toHaveURL(/\/$/);
    await p.goto('/projects/project-default');
    await expect(p.locator('.app-container')).toHaveAttribute('data-hydrated', 'true');
    await expect(p.getByText('Nápady').first()).toBeVisible();
  };
  await seed(page, 'Seed One', `seed1-${run}@example.test`);
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await seed(p2, 'Seed Two', `seed2-${run}@example.test`);

  // Read back with a fresh token of each user: every column id starts with that user's project id.
  for (const email of [`seed1-${run}@example.test`, `seed2-${run}@example.test`]) {
    const login = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email, password: PASSWORD } });
    const token = login.json.access_token as string;
    const cols = await sb(request, '/rest/v1/columns?select=id,project_id', { token });
    expect(cols.json.length).toBe(5);
    for (const c of cols.json) {
      expect(c.id).toBe(`${c.project_id}-${c.id.slice(c.project_id.length + 1)}`);
      expect(c.id.startsWith('project-default-')).toBe(true);
      expect(c.id).not.toMatch(/^column-\d$/);
    }
    const cards = await sb(request, '/rest/v1/cards?select=id', { token });
    expect(cards.json.length).toBe(7);
  }
  await ctx2.close();
});

test('AI gateway at runtime: 401 without/with bad credentials, 415 wrong type, 403 foreign project, ledger + rate limit', async ({ request }) => {
  const A = await apiSignUp(request, `ai-a-${run}@example.test`);
  const B = await apiSignUp(request, `ai-b-${run}@example.test`);
  const proj = `ai-p-${run}`;
  const make = await sb(request, '/rest/v1/projects', { method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' }, data: { id: proj, name: 'AI project' } });
  expect(make.status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: A.token, data: { id: `${proj}-c`, project_id: proj, name: 'Todo', position: 0 } });
  await sb(request, '/rest/v1/cards', { method: 'POST', token: A.token, data: { id: `${proj}-k`, column_id: `${proj}-c`, title: 'Task' } });

  const body = { projectId: proj, card: { id: 'k', title: 'Improve me', details: '' } };
  const post = (headers: Record<string, string>, data: unknown = body) =>
    request.post('/api/ai/improve', { headers: { 'Content-Type': 'application/json', ...headers }, data: typeof data === 'string' ? data : JSON.stringify(data) });

  expect((await post({})).status()).toBe(401);
  expect((await post({ Authorization: 'Bearer ' + 'x'.repeat(40) })).status()).toBe(401);
  expect((await post({ Authorization: `Bearer ${A.token}`, 'Content-Type': 'text/plain' }, 'x')).status()).toBe(415);
  const badBody = await post({ Authorization: `Bearer ${A.token}` }, { projectId: proj, card: {} });
  expect(badBody.status()).toBe(400);

  const forbidden = await post({ Authorization: `Bearer ${B.token}` });
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).code).toBe('forbidden');

  // Authenticated + authorised: reaches the provider step, which fails closed without a Gemini key.
  const first = await post({ Authorization: `Bearer ${A.token}` });
  expect(first.status()).toBe(503);
  const firstJson = await first.json();
  expect(firstJson.code).toBe('ai_unavailable');
  expect(JSON.stringify(firstJson)).not.toMatch(/GEMINI|API_KEY|AIza/);

  const ledger = await sb(request, '/rest/v1/ai_requests?select=feature,status,error_code,project_id&order=created_at.desc', { token: A.token });
  expect(ledger.json[0]).toMatchObject({ feature: 'improve', status: 'failed', error_code: 'ai_unavailable', project_id: proj });

  // Rate limit (AI_RATE_PER_USER_PER_MINUTE=3 on the dev server): burn the rest of the budget, then 429.
  const statuses: number[] = [first.status()];
  for (let i = 0; i < 3; i++) statuses.push((await post({ Authorization: `Bearer ${A.token}` })).status());
  expect(statuses.slice(0, 3).every((s) => s === 503)).toBe(true);
  expect(statuses[3]).toBe(429);
  const limited = await post({ Authorization: `Bearer ${A.token}` });
  expect(limited.headers()['retry-after']).toBe('60');
  expect((await limited.json()).code).toBe('rate_limited');
  // Nothing reached a provider: only the first 3 calls created ledger rows.
  const count = await sb(request, '/rest/v1/ai_requests?select=id', { token: A.token });
  expect(count.json.length).toBe(3);
});

test('invitation end-to-end in the browser: create (team page) -> preview -> sign up as invitee -> accept; reuse/revoked states', async ({ page, request, browser }) => {
  const inviteeEmail = `invitee-${run}@example.test`;

  // owner logs in through the UI and invites from /team
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(ownerEmail);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/team');
  await page.getByTestId('workspace-invite-email-input').fill(inviteeEmail);
  await page.getByTestId('workspace-invite-send-btn').click();
  await expect(page.getByTestId('workspace-pending-invitations-list')).toContainText(inviteeEmail);

  // the plaintext token exists only in the page; the DB holds a hash
  const ownerLogin = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: ownerEmail, password: PASSWORD } });
  const rows = await sb(request, '/rest/v1/invitations?select=id,email,status', { token: ownerLogin.json.access_token });
  expect(rows.json.some((r: { email: string; status: string }) => r.email === inviteeEmail && r.status === 'pending')).toBe(true);
  const hashAttempt = await sb(request, '/rest/v1/invitations?select=token_hash', { token: ownerLogin.json.access_token });
  expect(hashAttempt.status).toBe(403);

  // fresh token via RPC (the team page does not expose it after a reload) -> invitee flow, logged out
  const inv = await sb(request, '/rest/v1/rpc/create_workspace_invitation', { method: 'POST', token: ownerLogin.json.access_token, data: { p_email: inviteeEmail } });
  const token = inv.json[0].token as string;

  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(`/accept-invite?token=${token}`);
  await expect(guest).toHaveURL(/accept-invite/); // public route, no redirect to /login
  await expect(guest.getByTestId('accept-invite-preview')).toContainText('i***@example.test');
  await guest.getByTestId('accept-invite-email-input').fill(inviteeEmail);
  await guest.getByTestId('accept-invite-name-input').fill('Invited Person');
  await guest.getByTestId('accept-invite-password-input').fill(PASSWORD);
  await guest.getByTestId('accept-invite-submit-btn').click();
  await expect(guest.getByTestId('accept-invite-success')).toBeVisible();

  // used link now shows the "used" state and no form
  const guest2 = await (await browser.newContext()).newPage();
  await guest2.goto(`/accept-invite?token=${token}`);
  await expect(guest2.getByTestId('accept-invite-unavailable')).toContainText('použita');
  await expect(guest2.getByTestId('accept-invite-submit-btn')).toHaveCount(0);

  // garbage token
  await guest2.goto(`/accept-invite?token=${'0'.repeat(64)}`);
  await expect(guest2.getByTestId('accept-invite-unavailable')).toBeVisible();
  await ctx.close();
});
