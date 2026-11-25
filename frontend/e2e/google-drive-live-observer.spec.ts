import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * RUN 02B LIVE helper: two OTHER ClearSpace members (editor bob, viewer vera; real password sessions, real Realtime) sit on the project's
 * file dialog while the owner attaches REAL Google Drive files by hand in another browser. It proves, without a reload, that the changes
 * arrive live, that the timeline records them and that roles/ClearSpace-vs-Google access hold with the real provider. It prints and
 * stores ONLY counts, timings and booleans -- never file names, links or account data.
 *   E2E_LIVE_OBSERVER=1 E2E_OBSERVER_PASSWORD=... PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive-live-observer.spec.ts
 */
test.skip(process.env.E2E_LIVE_OBSERVER !== '1' || !process.env.E2E_OBSERVER_PASSWORD, 'manual live helper');
const P = 'project-collab-demo';
const OUT = process.env.E2E_OBSERVER_OUT ?? '/tmp/drive-live-observer.json';

async function login(browser: import('@playwright/test').Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login?login=manual');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(process.env.E2E_OBSERVER_PASSWORD as string);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  return { ctx, page };
}
const count = (page: Page, id: string) => page.getByTestId('project-files-modal').getByTestId(id).locator('li').count().catch(() => 0);

test('members see the owner\'s real Drive links live (no reload), roles hold, timeline records them', async ({ browser }) => {
  test.setTimeout(25 * 60_000);
  const bob = await login(browser, 'bob@collab.test');
  const vera = await login(browser, 'vera@collab.test');
  const result: Record<string, unknown> = { started: new Date().toISOString() };
  for (const s of [bob, vera]) {
    await s.page.goto(`/projects/${P}`);
    await s.page.getByTestId('project-files-btn').click();
  }
  const t0 = Date.now();
  // wait (no reload!) until BOTH observers see the first project-level or task-level link
  await expect.poll(async () => (await count(bob.page, 'drive-list')) + (await count(bob.page, 'drive-task-list')), { timeout: 24 * 60_000, intervals: [1000] }).toBeGreaterThan(0);
  result.firstLinkSeenByEditorAfterMsOfWaiting = Date.now() - t0;
  await expect.poll(async () => (await count(vera.page, 'drive-list')) + (await count(vera.page, 'drive-task-list')), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(0);
  // let the owner finish the whole sequence (project + task + duplicate attempt), then read the final state
  await bob.page.waitForTimeout(Number(process.env.E2E_OBSERVER_SETTLE_MS ?? 90_000));
  for (const [who, s] of [['editor', bob], ['viewer', vera]] as const) {
    const m = s.page.getByTestId('project-files-modal');
    result[`${who}_projectLinks`] = await count(s.page, 'drive-list');
    result[`${who}_taskLinks`] = await count(s.page, 'drive-task-list');
    result[`${who}_canAttach`] = (await m.getByTestId('drive-attach').count()) > 0;
    result[`${who}_canRemove`] = (await m.getByTestId('drive-remove').count()) > 0;
    result[`${who}_seesConnectPrompt`] = (await m.getByTestId('drive-connect').count()) > 0;
    result[`${who}_openLinksAreGoogleHosts`] = await m.getByTestId('drive-open').evaluateAll((as) => as.every((a) => /^https:\/\/(docs|drive)\.google\.com\//.test((a as HTMLAnchorElement).href)));
    result[`${who}_hasNoPreviewButtons`] = (await m.getByTestId('drive-preview').count()) === 0;   // not connected to Google themselves -> no content access
    result[`${who}_overflowPx`] = await s.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  }
  // timeline (editor): only the Czech sentence shape is recorded, not names
  await bob.page.keyboard.press('Escape');
  await bob.page.getByTestId('activity-feed-btn').click();
  const feed = await bob.page.getByTestId('activity-feed-list').innerText();
  result.timelineLinkedEvents = (feed.match(/připojil\(a\) (k projektu )?soubor z Disku/g) ?? []).length + (feed.match(/připojil\(a\) soubor z Disku/g) ?? []).length;
  result.timelineUnlinkedEvents = (feed.match(/odebral\(a\) .*soubor z Disku/g) ?? []).length;
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('LIVE OBSERVER RESULT', JSON.stringify(result));
  await bob.ctx.close(); await vera.ctx.close();
});
