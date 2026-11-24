import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * RUN 01C: the production invitation path for a NEW person when the Supabase project requires e-mail confirmation
 * (hosted has "Confirm email" ON). Local collab stack only, with `enable_confirmations = true` and redirect URLs
 * `http://127.0.0.1:3431/**`; both e-mails (ClearSpace invitation, Supabase confirmation) are captured by Mailpit.
 *   E2E_EMAIL_CONFIRMATION=1 PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3431 npx playwright test e2e/collaboration-01c-confirm.spec.ts
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const MAILPIT = process.env.E2E_MAILPIT_URL;
const APP = process.env.PLAYWRIGHT_TEST_BASE_URL;
test.skip(process.env.E2E_EMAIL_CONFIRMATION !== '1' || !SB || !MAILPIT || !APP || !SERVICE, 'needs the local collab stack with e-mail confirmation enabled');

const run = Date.now().toString(36);
const PASSWORD = 'Collab-01C-Pass-123';

async function json(request: APIRequestContext, method: string, url: string, token: string, data?: unknown, apikey = ANON) {
  const res = await request.fetch(url, {
    method,
    headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}
async function mail(request: APIRequestContext, to: string, subject: RegExp): Promise<{ subject: string; text: string; html: string }> {
  for (let i = 0; i < 60; i++) {
    const s = await (await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    for (const m of s.messages ?? []) {
      if (subject.test(m.Subject)) {
        const full = await (await request.get(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
        return { subject: full.Subject, text: full.Text, html: full.HTML };
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no e-mail matching ${subject} for ${to}`);
}

test('new person: invitation e-mail -> registration -> confirmation e-mail -> project access -> live updates', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const P = `e2e-01c-${run}`;
  const OWNER = `own01c-${run}@example.test`;
  const NEW = `nova01c-${run}@example.test`;

  // owner: a confirmed account (admin API, local stack only)
  const created = await json(request, 'POST', `${SB}/auth/v1/admin/users`, SERVICE, { email: OWNER, password: PASSWORD, email_confirm: true, user_metadata: { display_name: 'Olga Vlastníková' } }, SERVICE);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const tok = await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON, 'Content-Type': 'application/json' }, data: { email: OWNER, password: PASSWORD } });
  const ownerToken = (await tok.json()).access_token as string;
  const ownerId = created.body.id as string;
  for (const [path, data] of [
    ['projects', { id: P, name: 'Přijímací test' }],
    ['columns', { id: `${P}-a`, project_id: P, name: 'K řešení', position: 0 }],
    ['project_members', { project_id: P, member_id: `member-owner-${ownerId}` }],
    ['cards', { id: `${P}-k1`, column_id: `${P}-a`, title: 'Úvodní úkol' }],
  ] as const) {
    const r = await json(request, 'POST', `${SB}/rest/v1/${path}`, ownerToken, data);
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(201);
  }

  // 1. invitation through the app's own server route (same as the members dialog)
  const inv = await request.post(`${APP}/api/collab/invitations`, { headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, data: { projectId: P, email: NEW, role: 'member' } });
  expect(inv.status()).toBe(201);
  expect((await inv.json()).delivery.status).toBe('accepted');
  const invitationMail = await mail(request, NEW, /zve do projektu/);
  const link = /https?:\/\/\S+\/accept-invite\?token=[0-9a-f]{64}/.exec(invitationMail.text)![0];

  // 2. registration from the e-mailed link in a browser without any session
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByTestId('accept-invite-preview')).toContainText('Olga Vlastníková');
  await page.getByTestId('accept-invite-email-input').fill(NEW);
  await page.getByTestId('accept-invite-name-input').fill('Nora Nováčková');
  await page.getByTestId('accept-invite-password-input').fill(PASSWORD);
  await page.getByTestId('accept-invite-submit-btn').click();
  await expect(page.getByTestId('accept-invite-confirm-email')).toBeVisible();

  // 3. Supabase's confirmation e-mail; its link must come back to the SAME invitation
  const confirm = await mail(request, NEW, /confirm/i);
  const confirmUrl = (/href="([^"]+verify[^"]+)"/.exec(confirm.html)?.[1] ?? /https?:\/\/\S+verify\S+/.exec(confirm.text)![0]).replace(/&amp;/g, '&');
  expect(decodeURIComponent(confirmUrl)).toContain('/accept-invite?token=');
  await page.goto(confirmUrl);
  await expect(page).toHaveURL(/\/accept-invite\?token=/);

  // 4. signed in now: finish the acceptance, land in the project
  await page.getByTestId('accept-invite-name-input').fill('Nora Nováčková');
  await page.getByTestId('accept-invite-submit-btn').click();
  await expect(page.getByTestId('accept-invite-success')).toBeVisible();
  await page.goto(`/projects/${P}`);
  await expect(page.locator('[data-testid^="card-"]', { hasText: 'Úvodní úkol' })).toBeVisible();

  // 5. realtime: the owner's new task appears without reload
  const r = await json(request, 'POST', `${SB}/rest/v1/cards`, ownerToken, { id: `${P}-k2`, column_id: `${P}-a`, title: 'Živě přidaný úkol' });
  expect(r.status).toBe(201);
  await expect(page.locator('[data-testid^="card-"]', { hasText: 'Živě přidaný úkol' })).toBeVisible({ timeout: 10_000 });

  // 6. the owner sees the invitation as accepted
  const rows = await request.get(`${SB}/rest/v1/invitations?select=status&email=eq.${encodeURIComponent(NEW)}`, { headers: { apikey: ANON, Authorization: `Bearer ${ownerToken}` } });
  expect((await rows.json())[0].status).toBe('accepted');

  await ctx.close();
  await json(request, 'DELETE', `${SB}/rest/v1/projects?id=eq.${P}`, ownerToken);
});
