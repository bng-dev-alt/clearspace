import { test, expect, type Browser } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * RUN 02B LIVE, automated: the OWNER's server-side attach uses the REAL Google Drive API (files.get with the owner's real token) for a
 * file the owner already picked in the real Picker (id passed by env, never printed). Editor and viewer sit on the files dialog WITHOUT
 * reloading and must see the link appear, then disappear when the owner removes it; the timeline records both. Counts/latencies only.
 *   E2E_LIVE_REALTIME=1 E2E_LIVE_FILE_ID=<picked Drive id> E2E_PASSWORD=... E2E_SUPABASE_URL=... E2E_SUPABASE_ANON_KEY=... \
 *     PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive-live-realtime.spec.ts
 */
test.skip(process.env.E2E_LIVE_REALTIME !== '1' || !process.env.E2E_LIVE_FILE_ID || !process.env.E2E_PASSWORD, 'live helper');
const SB = process.env.E2E_SUPABASE_URL as string;
const ANON = process.env.E2E_SUPABASE_ANON_KEY as string;
const PW = process.env.E2E_PASSWORD as string;
const FILE = process.env.E2E_LIVE_FILE_ID as string;
const P = 'project-collab-demo';
const OUT = process.env.E2E_LIVE_OUT ?? '/tmp/drive-live-realtime.json';

async function uiLogin(browser: Browser, who: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login?login=manual');
  await page.getByPlaceholder('jmeno@firma.cz').fill(`${who}@collab.test`);
  await page.locator('input[type="password"]').first().fill(PW);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto(`/projects/${P}`);
  await page.getByTestId('project-files-btn').click();
  return { ctx, page };
}

test('real Drive link: owner attaches/removes, editor + viewer see it live, timeline records it', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const tokenOf = async (who: string) => (await (await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON }, data: { email: `${who}@collab.test`, password: PW } })).json()).access_token as string;
  const alice = await tokenOf('alice');
  const bob = await uiLogin(browser, 'bob');
  const vera = await uiLogin(browser, 'vera');
  const rows = (s: typeof bob) => s.page.getByTestId('project-files-modal').getByTestId('drive-list').locator('li').count().catch(() => 0);
  await expect(bob.page.getByTestId('project-files-modal').getByTestId('drive-empty')).toBeVisible();
  const result: Record<string, unknown> = {};

  const t0 = Date.now();
  const add = await request.post('/api/drive/links', { headers: { Authorization: `Bearer ${alice}` }, data: { projectId: P, fileIds: [FILE] } });
  result.attachHttp = add.status();
  const body = await add.json();
  result.attachReal = { linked: body.links?.length ?? 0, failed: (body.failed ?? []).map((f: { reason: string }) => f.reason) };
  expect(add.status()).toBeLessThan(300);
  for (const [who, s] of [['editor', bob], ['viewer', vera]] as const) {
    await expect.poll(() => rows(s), { timeout: 15_000, intervals: [100] }).toBe(1);
    result[`${who}_sawAttachAfterMs`] = Date.now() - t0;
  }
  result.editor_canAttachRemove = [(await bob.page.getByTestId('drive-attach').count()), (await bob.page.getByTestId('drive-remove').count())];   // not connected: no controls
  result.viewer_canAttachRemove = [(await vera.page.getByTestId('drive-attach').count()), (await vera.page.getByTestId('drive-remove').count())];
  result.editor_openLinkHost = await bob.page.getByTestId('project-files-modal').getByTestId('drive-open').first().evaluate((a) => new URL((a as HTMLAnchorElement).href).host);
  result.editor_connectPrompt = await bob.page.getByTestId('drive-connect').count();

  // timeline for the editor (live, no reload): sentence shape only
  await bob.page.keyboard.press('Escape');
  await bob.page.getByTestId('activity-feed-btn').click();
  await expect(bob.page.getByTestId('activity-feed-list')).toContainText('připojil(a) k projektu soubor z Disku', { timeout: 10_000 });
  await bob.page.getByTestId('activity-feed-close-btn').click();
  await bob.page.getByTestId('project-files-btn').click();

  // owner removes the association (REST under the owner's RLS) -> everyone sees it vanish; the Drive file is untouched (no write API exists)
  const ids = await (await request.get(`${SB}/rest/v1/external_resource_links?project_id=eq.${P}&card_id=is.null&select=id`, { headers: { apikey: ANON, Authorization: `Bearer ${alice}` } })).json();
  const t1 = Date.now();
  const del = await request.delete(`${SB}/rest/v1/external_resource_links?id=eq.${ids[0].id}`, { headers: { apikey: ANON, Authorization: `Bearer ${alice}`, Prefer: 'return=representation' } });
  expect((await del.json()).length).toBe(1);
  for (const [who, s] of [['editor', bob], ['viewer', vera]] as const) {
    await expect.poll(() => rows(s), { timeout: 15_000, intervals: [100] }).toBe(0);
    result[`${who}_sawRemoveAfterMs`] = Date.now() - t1;
  }
  // the file is still readable at Google through the owner's token after the association is gone (real files.get via refresh)
  const check = await request.post('/api/drive/links/refresh', { headers: { Authorization: `Bearer ${alice}` }, data: { projectId: P } });
  result.driveFileStillReachableAfterRemove = check.status() === 200;
  const again = await request.post('/api/drive/links', { headers: { Authorization: `Bearer ${alice}` }, data: { projectId: P, fileIds: [FILE] } });
  result.reattachAfterRemoveWorks = (await again.json()).links?.length === 1;
  await request.delete(`${SB}/rest/v1/external_resource_links?project_id=eq.${P}&card_id=is.null`, { headers: { apikey: ANON, Authorization: `Bearer ${alice}` } });   // leave the owner's state as found
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log('LIVE REALTIME RESULT', JSON.stringify(result));
  await bob.ctx.close(); await vera.ctx.close();
});
