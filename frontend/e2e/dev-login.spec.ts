import { test, expect } from '@playwright/test';

/**
 * Development login helper (src/lib/devLogin.ts) against a LOCAL dev server whose .env.local has the dev account.
 * Skipped unless E2E_DEV_LOGIN=1. Needs PLAYWRIGHT_TEST_BASE_URL on loopback.
 */
test.skip(process.env.E2E_DEV_LOGIN !== '1', 'needs a dev server with the dev login configured');

test('one click signs in as the dev account; the session persists across reloads and a new tab', async ({ page, context }) => {
  await page.goto('/login');
  await page.getByTestId('dev-login-btn').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('navbar-avatar-btn')).toBeVisible();
  const tab2 = await context.newPage();
  await tab2.goto('/team');
  await expect(tab2).toHaveURL(/\/team$/); // protected route open without a new login
});

test('the helper endpoint refuses everything but a same-origin loopback request with the marker header', async ({ request, baseURL }) => {
  const url = `${baseURL}/api/dev/login`;
  expect((await request.post(url)).status()).toBe(404); // no marker header
  expect((await request.post(url, { headers: { 'x-clearspace-dev-login': '1', 'x-forwarded-for': '203.0.113.9' } })).status()).toBe(404);
  expect((await request.post(url, { headers: { 'x-clearspace-dev-login': '1', origin: 'https://evil.example' } })).status()).toBe(404);
  expect((await request.get(url)).status()).toBe(405); // POST only
});
