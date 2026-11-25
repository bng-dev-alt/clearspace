import { test, expect } from '@playwright/test';

/**
 * RUN 02B closeout, LIVE (real Google): the owner already connected a real Google account and attached a NATIVE Google Doc to the
 * project with the real Picker (manual step), then renamed that Doc in Drive. This spec only READS: preview of the native Doc's text,
 * "Obnovit informace" after the rename, and the "open in Drive" link. Names/text are never printed -- counts and hosts only.
 *   E2E_LIVE_DOC=1 PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3441 npx playwright test e2e/google-drive-live-doc.spec.ts
 */
test.skip(process.env.E2E_LIVE_DOC !== '1' || !process.env.E2E_PASSWORD, 'live helper');
const SB = process.env.E2E_SUPABASE_URL as string;
const ANON = process.env.E2E_SUPABASE_ANON_KEY as string;
const P = 'project-collab-demo';

test('native Google Doc: text preview, refresh after rename in Drive, open original', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const tok = (await (await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON }, data: { email: 'alice@collab.test', password: process.env.E2E_PASSWORD } })).json()).access_token as string;
  const get = async (path: string) => (await (await request.get(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${tok}` } })).json()) as Record<string, unknown>[];
  const docs = await get(`external_resource_links?project_id=eq.${P}&mime_type=eq.application/vnd.google-apps.document&select=id,name,card_id`);
  expect(docs.length, 'a native Google Doc must be attached (manual Picker step)').toBeGreaterThan(0);
  expect(docs.some((d) => d.card_id === null), 'a native Doc attached at PROJECT level').toBe(true);
  await page.goto('/settings?login=auto');
  await expect(page.getByTestId('google-connection-state')).toContainText('Aktivní', { timeout: 20_000 });
  await page.goto(`/projects/${P}`);
  await page.getByTestId('project-files-btn').click();
  const modal = page.getByTestId('project-files-modal');
  const doc = modal.getByTestId('drive-list').locator('li.drive-link').filter({ has: page.getByTestId('drive-preview') }).filter({ hasText: /Dokument Google/ }).first();
  await expect(doc, 'a native Google Doc must be attached at PROJECT level (manual Picker step)').toBeVisible({ timeout: 15_000 });

  // 1. text preview of the native Doc (files.export text/plain with the caller's own token)
  await doc.getByTestId('drive-preview').click();
  const text = page.getByTestId('drive-preview-text');
  await expect(text).toBeVisible({ timeout: 20_000 });
  const chars = ((await text.innerText()) ?? '').length;
  console.log(`preview: native Doc text loaded, ${chars} characters`);
  expect(chars).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // 2. rename in Drive picked up by "Obnovit informace": a stored name now differs from the name recorded in the link event
  if (!(await modal.isVisible())) { await page.getByTestId('project-files-btn').click(); }
  await modal.getByTestId('drive-refresh').click();
  await page.waitForTimeout(3_000);
  const events = await get(`activity_logs?project_id=eq.${P}&action_type=eq.drive_file_linked&select=entity_id,details`);
  const after = await get(`external_resource_links?project_id=eq.${P}&mime_type=eq.application/vnd.google-apps.document&select=id,name`);
  const renamed = after.filter((l) => events.some((e) => e.entity_id === l.id && (e.details as { name?: string }).name !== l.name)).length;
  console.log(`refresh: ${renamed} native Doc link(s) carry a name different from the one recorded at link time (rename picked up)`);
  expect(renamed, 'rename in Drive must be picked up by "Obnovit informace"').toBeGreaterThan(0);

  // 3. open original: the link goes to Google (headless has no Google session -> docs.google.com or the Google sign-in page)
  const [popup] = await Promise.all([context.waitForEvent('page'), doc.getByTestId('drive-open').click()]);
  await popup.waitForURL(/google\.com/, { timeout: 30_000 });
  const host = new URL(popup.url()).host;
  console.log(`open original: opened host ${host}`);
  expect(host).toMatch(/^(docs|drive|accounts)\.google\.com$/);
  await popup.close();
});
