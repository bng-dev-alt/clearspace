import { test, expect } from '@playwright/test';

/**
 * Only meaningful when the suite runs with E2E_STYLE=monograph against an app built with NEXT_PUBLIC_ENABLE_MONOGRAPH=1
 * (scripts/monograph-stack.sh e2e): proves the other specs of that run really executed under the Monograph style.
 */
test.skip(process.env.E2E_STYLE !== 'monograph', 'set E2E_STYLE=monograph (and NEXT_PUBLIC_ENABLE_MONOGRAPH=1 on the app)');

test('the stored preference selects Monograph and the self-hosted fonts apply', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-style', 'monograph');
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(font).toContain('IBM Plex Sans');
  await page.evaluate(() => document.fonts.load('500 14px "IBM Plex Sans"'));
  expect(await page.evaluate(() => document.fonts.check('500 14px "IBM Plex Sans"'))).toBe(true);
});
