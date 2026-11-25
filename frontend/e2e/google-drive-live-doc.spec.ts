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
  // The name STORED at attach time (the panel also refreshes once when opened, so the UI alone cannot show "before").
  const tok = (await (await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON }, data: { email: 'alice@collab.test', password: process.env.E2E_PASSWORD } })).json()).access_token as string;
  const rows = (await (await request.get(`${SB}/rest/v1/external_resource_links?project_id=eq.${P}&card_id=is.null&mime_type=eq.application/vnd.google-apps.document&select=name`, { headers: { apikey: ANON, Authorization: `Bearer ${tok}` } })).json()) as { name: string }[];
  expect(rows.length, 'a native Google Doc must be attached at PROJECT level (manual Picker step)').toBeGreaterThan(0);
  const stored = rows[0].name;
  await page.goto('/settings?login=auto');
  await expect(page.getByTestId('google-connection-state')).toContainText('Aktivní', { timeout: 20_000 });
  await page.goto(`/projects/${P}`);
  await page.getByTestId('project-files-btn').click();
  const modal = page.getByTestId('project-files-modal');
  const doc = modal.getByTestId('drive-list').locator('li.drive-link').filter({ has: page.getByTestId('drive-preview') }).filter({ hasText: /Dokument Google/ }).first();
  await expect(doc, 'a native Google Doc must be attached at PROJECT level (manual Picker step)').toBeVisible({ timeout: 15_000 });
  const nameOf = () => doc.locator('.drive-link-name').innerText();

  // 1. text preview of the native Doc (files.export text/plain with the caller's own token)
  await doc.getByTestId('drive-preview').click();
  const text = page.getByTestId('drive-preview-text');
  await expect(text).toBeVisible({ timeout: 20_000 });
  const chars = ((await text.innerText()) ?? '').length;
  console.log(`preview: native Doc text loaded, ${chars} characters`);
  expect(chars).toBeGreaterThan(0);
  await page.keyboard.press('Escape');

  // 2. refresh metadata (rename done in Drive after attaching)
  await modal.getByTestId('drive-refresh').click();
  await page.waitForTimeout(3_000);
  const after = await nameOf();
  console.log(after === stored ? 'refresh: name UNCHANGED vs. the stored one (rename the Doc in Drive after attaching, then re-run)' : 'refresh: name CHANGED (rename picked up from Drive)');
  expect(after, 'rename in Drive must be picked up by "Obnovit informace"').not.toBe(stored);

  // 3. open original: the link goes to Google (headless has no Google session -> docs.google.com or the Google sign-in page)
  const [popup] = await Promise.all([context.waitForEvent('page'), doc.getByTestId('drive-open').click()]);
  await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
  const host = new URL(popup.url()).host;
  console.log(`open original: opened host ${host}`);
  expect(host).toMatch(/^(docs|drive|accounts)\.google\.com$/);
  await popup.close();
});
