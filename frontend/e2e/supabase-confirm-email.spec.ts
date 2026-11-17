import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * Invitation flow with "Confirm email" ENABLED (the recommended production setting), against a
 * throwaway local Supabase stack with its Mailpit inbox. No mail leaves the machine.
 * Skipped unless E2E_CONFIRM_EMAILS=1 (plus the variables below).
 *
 *   E2E_CONFIRM_EMAILS=1 E2E_SUPABASE_URL=http://127.0.0.1:55421 E2E_SUPABASE_ANON_KEY=... \
 *   E2E_SERVICE_ROLE_KEY=... E2E_MAILPIT_URL=http://127.0.0.1:55424 \
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3405 npx playwright test e2e/supabase-confirm-email.spec.ts
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SERVICE_ROLE_KEY ?? '';
const MAIL = process.env.E2E_MAILPIT_URL ?? '';
test.skip(process.env.E2E_CONFIRM_EMAILS !== '1' || !SB || !SERVICE || !MAIL, 'needs the confirm-email local stack');

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';

async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; key?: string; data?: unknown } = {}) {
  const key = opts.key ?? ANON;
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${opts.token ?? key}`, 'Content-Type': 'application/json' },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : null };
}

async function confirmationLink(request: APIRequestContext, email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const list = await (await request.get(`${MAIL}/api/v1/messages`)).json();
    const msg = (list.messages ?? []).find((m: { To: Array<{ Address: string }> }) => m.To.some((t) => t.Address === email));
    if (msg) {
      const full = await (await request.get(`${MAIL}/api/v1/message/${msg.ID}`)).json();
      const body: string = (full.HTML ?? '') + (full.Text ?? '');
      const m = body.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/v1\/verify\?[^"'\s<)]+/);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no confirmation e-mail for ${email}`);
}

test('with Confirm email ON: sign-up does NOT accept; accepting works only after the e-mail is verified', async ({ page, request }) => {
  const ownerEmail = `cowner-${run}@example.test`;
  const inviteeEmail = `cinvitee-${run}@example.test`;

  // owner: confirmed through the ADMIN API (local service role), then a normal password login
  const created = await sb(request, '/auth/v1/admin/users', { method: 'POST', key: SERVICE, data: { email: ownerEmail, password: PASSWORD, email_confirm: true } });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const login = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: ownerEmail, password: PASSWORD } });
  const ownerToken = login.json.access_token as string;
  const inv = await sb(request, '/rest/v1/rpc/create_workspace_invitation', { method: 'POST', token: ownerToken, data: { p_email: inviteeEmail } });
  const token = inv.json[0].token as string;

  // invitee, logged out: fills the form -> told to confirm; nothing is accepted yet
  await page.goto(`/accept-invite?token=${token}`);
  await expect(page.getByTestId('accept-invite-preview')).toBeVisible();
  await page.getByTestId('accept-invite-email-input').fill(inviteeEmail);
  await page.getByTestId('accept-invite-name-input').fill('Confirmed Person');
  await page.getByTestId('accept-invite-password-input').fill(PASSWORD);
  await page.getByTestId('accept-invite-submit-btn').click();
  await expect(page.getByTestId('accept-invite-confirm-email')).toBeVisible();
  const still = await sb(request, '/rest/v1/invitations?select=status', { token: ownerToken });
  expect(still.json.filter((r: { status: string }) => r.status === 'pending')).toHaveLength(1);

  // the unverified account cannot log in at all
  const early = await sb(request, '/auth/v1/token?grant_type=password', { method: 'POST', data: { email: inviteeEmail, password: PASSWORD } });
  expect(early.status).toBe(400);

  // open the confirmation link from the local inbox: lands on the same invitation link, now signed in
  const link = await confirmationLink(request, inviteeEmail);
  await page.goto(link);
  await expect(page).toHaveURL(/accept-invite\?token=/);
  await expect(page.getByTestId('accept-invite-submit-btn')).toContainText('Přijmout pozvánku');
  await expect(page.getByTestId('accept-invite-password-input')).toHaveCount(0); // signed in: no password field
  await page.getByTestId('accept-invite-name-input').fill('Confirmed Person');
  await page.getByTestId('accept-invite-submit-btn').click();
  await expect(page.getByTestId('accept-invite-success')).toBeVisible();

  const done = await sb(request, '/rest/v1/invitations?select=status', { token: ownerToken });
  expect(done.json.map((r: { status: string }) => r.status)).toEqual(['accepted']);
});
