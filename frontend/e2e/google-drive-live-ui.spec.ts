import { test, expect } from '@playwright/test';

/**
 * RUN 02B LIVE UI check (real Google mode, auto DEV login as the owner who already connected a real Google account and linked one real
 * file to the seeded task). DOM assertions only: nothing is screenshotted or logged (names / account e-mail are private).
 *   E2E_LIVE_UI=1 [E2E_STYLE=monograph] PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive-live-ui.spec.ts
 */
test.skip(process.env.E2E_LIVE_UI !== '1', 'live helper');
const P = 'project-collab-demo';

for (const [label, size, scheme] of [['desktop light', { width: 1280, height: 800 }, 'light'], ['mobile dark', { width: 375, height: 812 }, 'dark']] as const) {
  test(`real Google UI (${process.env.E2E_STYLE ?? 'classic'}, ${label})`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: size, colorScheme: scheme });
    const page = await ctx.newPage();
    const style = process.env.E2E_STYLE === 'monograph' ? 'monograph' : 'existing';   // 'existing' = the Classic style
    await page.addInitScript((v) => localStorage.setItem('clearspace-style', v), style);
    await page.goto('/settings?login=auto');
    const card = page.getByTestId('google-connection-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    expect(await card.getByText('simulace').count()).toBe(0);                      // no mock label in real mode
    await expect(page.getByTestId('google-connection-state')).toContainText('Aktivní');
    expect(((await page.getByTestId('google-account-email').innerText()) ?? '').includes('@')).toBe(true);
    await expect(page.getByTestId('google-disconnect')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

    await page.goto(`/projects/${P}`);
    await page.getByTestId('project-files-btn').click();
    const m = page.getByTestId('project-files-modal');
    await expect(m.getByTestId('drive-task-list').locator('li')).toHaveCount(1);   // the real file linked to the task
    await expect(m.getByTestId('drive-attach')).toBeVisible();                    // connected owner may add from the real Picker
    await expect(m.getByTestId('drive-privacy-note')).toContainText('uvidí všichni členové projektu');
    const open = m.getByTestId('drive-open').first();
    expect(await open.evaluate((a) => new URL((a as HTMLAnchorElement).href).protocol + '//' + new URL((a as HTMLAnchorElement).href).host)).toMatch(/^https:\/\/(docs|drive)\.google\.com$/);
    expect(await open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.dataset.style ?? 'existing')).toBe(style);

    await page.keyboard.press('Escape');
    await page.getByText('Připravit podklady pro klienta').first().click();
    const sec = page.getByTestId('task-drive-section');
    await expect(sec).toBeVisible();
    await expect(sec.getByTestId('drive-list').locator('li')).toHaveCount(1);
    await ctx.close();
  });
}
