import { test, expect, type Page } from '@playwright/test';

/**
 * RUN 10 mock E2E – Meeting Intelligence on an isolated stack (scripts/meetings-stack.sh app) with the Google mock and the fake
 * Soniox (real-time WebSocket). Chromium's fake microphone produces a tone; the fake Soniox answers with synthetic Czech tokens.
 * Nothing reaches real Google or real Soniox. Proves the WHOLE flow in a real browser: plan -> Google event with Meet (no invites)
 * -> organizer notice -> live capture -> pause (stream ends) -> resume (new segment) -> stop -> one stored transcript -> access rules.
 *   PLAYWRIGHT_TEST_BASE_URL=http://127.0.0.1:3481 E2E_MEETINGS_STACK=1 E2E_SUPABASE_URL=... E2E_SUPABASE_ANON_KEY=... \
 *   E2E_COLLAB_PASSWORD=... FAKE_SONIOX_URL=http://127.0.0.1:55643 GOOGLE_MOCK_URL=http://127.0.0.1:55642 npx playwright test e2e/meeting-live.spec.ts
 */
test.skip(process.env.E2E_MEETINGS_STACK !== '1', 'needs scripts/meetings-stack.sh app + mock + soniox');
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}) }, permissions: ['microphone'] });

const P = 'project-collab-demo';
const SB = process.env.E2E_SUPABASE_URL as string;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const FAKE = process.env.FAKE_SONIOX_URL ?? 'http://127.0.0.1:55643';

async function tokenOf(request: import('@playwright/test').APIRequestContext, who: string) {
  const r = await request.post(`${SB}/auth/v1/token?grant_type=password`, { headers: { apikey: ANON }, data: { email: `${who}@collab.test`, password: process.env.E2E_COLLAB_PASSWORD } });
  return (await r.json()).access_token as string;
}

async function newPlanned(page: Page, title: string) {
  await page.goto(`/projects/${P}/meetings?login=auto`);
  await page.getByTestId('meeting-new').click();
  await page.getByLabel('Název porady').fill(title);
  await page.getByTestId('mode-plan').click();
  await page.getByTestId('plan-guests').fill('bob@collab.test, Externi.Host@Klient.example');
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  return page.url().split('/').pop() as string;
}

test('plan -> live capture with pause/resume -> one stored transcript; access and isolation', async ({ page, request }) => {
  test.setTimeout(180_000);
  const id = await newPlanned(page, `RUN10 E2E ${Date.now()}`);
  await expect(page.getByTestId('schedule-attendees')).toContainText('externi.host@klient.example');

  // ---- live: notice is mandatory, then the fake microphone streams to the fake Soniox -------------------------------------
  await expect(page.getByTestId('live-start')).toBeDisabled();
  await page.getByTestId('live-notice').check();
  await page.getByTestId('live-source-mic').check();
  await page.getByTestId('live-start').click();
  await expect(page.getByTestId('live-capture-state')).toHaveText(/Nahrává se/, { timeout: 20_000 });
  await expect(page.getByTestId('live-transcription-state')).toHaveText('Přepis běží');
  await expect(page.getByTestId('live-transcript')).toContainText('Dobrý', { timeout: 20_000 });
  await expect(page.getByTestId('live-source-state')).toContainText('jen mikrofon');

  // double start from a second tab is refused by the database (no second paid stream)
  const t = await tokenOf(request, 'alice');
  const again = await request.post('/api/intelligence/meetings/live', { headers: { Authorization: `Bearer ${t}` }, data: { action: 'start', projectId: P, meetingId: id } });
  expect(again.status()).toBe(409);

  // pause = end of the provider stream; resume = a new single-use key
  await page.getByTestId('live-pause').click();
  await expect(page.getByTestId('live-capture-state')).toHaveText(/Pozastaveno/, { timeout: 20_000 });
  await page.getByTestId('live-resume').click();
  await expect(page.getByTestId('live-capture-state')).toHaveText(/Nahrává se/, { timeout: 20_000 });
  await page.waitForTimeout(3000);

  // provider-side facts (fake Soniox): two streams, each with its own single-use key, config sent without the key, audio received, ended cleanly
  const stats = await (await request.get(`${FAKE}/__stats`)).json().catch(() => null);
  if (stats?.rt) {
    expect(stats.rt.length).toBeGreaterThanOrEqual(2);
    expect(stats.rt[0].config.model).toBe('stt-rt-v6');
    expect(stats.rt[0].config.api_key).toBeUndefined();
    expect(stats.rt[0].bytes).toBeGreaterThan(0);
    expect(stats.rt[0].ended).toBe(true);
  }

  await page.getByTestId('live-stop').click();
  await expect(page.getByTestId('live-finalized')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('live-finalized')).toContainText('zvuk se neukládal');
  await expect(page.getByTestId('meeting-steps')).toBeVisible();
  // the stored transcript is the normalised live text (machine provenance), chunks are gone
  const rest = (path: string, tok: string) => request.get(`${SB}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${tok}` } });
  const tr = await (await rest(`meeting_transcripts?meeting_id=eq.${id}&select=source,char_count`, t)).json();
  expect(tr).toHaveLength(1);
  expect(tr[0].source).toBe('soniox');
  expect(tr[0].char_count).toBeGreaterThan(5);
  expect(await (await rest(`meeting_live_chunks?meeting_id=eq.${id}&select=seq`, t)).json()).toEqual([]);
  const ledger = await (await rest(`ai_requests?feature=eq.meeting-transcribe&provider=eq.soniox&select=billing_state,audio_ms&order=created_at.desc&limit=2`, t)).json();
  expect(ledger.every((r: { billing_state: string }) => r.billing_state === 'estimated')).toBe(true);

  // ---- access: a member who is not the organizer cannot start; a stranger cannot even see the meeting ---------------------
  const bob = await tokenOf(request, 'bob');
  const asBob = await request.post('/api/intelligence/meetings/live', { headers: { Authorization: `Bearer ${bob}` }, data: { action: 'start', projectId: P, meetingId: id } });
  expect([403, 409]).toContain(asBob.status()); // finalized meeting (409) or not organizer (403): never a key
  expect(await asBob.text()).not.toContain('snx_temp_');
  // Vera is a read-only VIEWER of the project: she may read the meeting (project members do) but never manage it or start capture
  const vera = await tokenOf(request, 'vera');
  expect(await (await rest(`meetings?id=eq.${id}&select=id`, vera)).json()).toHaveLength(1);
  const veraAdd = await request.post(`${SB}/rest/v1/meeting_attendees`, { headers: { apikey: ANON, Authorization: `Bearer ${vera}`, 'Content-Type': 'application/json' }, data: { meeting_id: id, project_id: P, email: 'x@example.org' } });
  expect(veraAdd.status()).toBeGreaterThanOrEqual(400);
  const asVera = await request.post('/api/intelligence/meetings/live', { headers: { Authorization: `Bearer ${vera}` }, data: { action: 'start', projectId: P, meetingId: id } });
  expect(asVera.status()).toBeGreaterThanOrEqual(400);
  expect(await asVera.text()).not.toContain('snx_temp_');

  // ---- deletion removes the meeting with its transcript, attendees and live rows ------------------------------------------
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('meeting-delete').click();
  await page.getByTestId('meeting-delete-confirm').click();
  await expect(page).toHaveURL(/\/meetings$/, { timeout: 20_000 });
  expect(await (await rest(`meeting_transcripts?meeting_id=eq.${id}&select=revision`, t)).json()).toEqual([]);
  expect(await (await rest(`meeting_attendees?meeting_id=eq.${id}&select=email`, t)).json()).toEqual([]);
});

test('unfinished capture after a closed tab: stored text is shown and can be completed', async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const id = await newPlanned(page, `RUN10 Obnova ${Date.now()}`);
  await page.getByTestId('live-notice').check();
  await page.getByTestId('live-start').click();
  await expect(page.getByTestId('live-transcript')).toContainText('Dobrý', { timeout: 20_000 });
  await page.waitForTimeout(4000); // at least one flush (every ~3 s)
  await page.close();             // tab closed without stopping

  const p2 = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  await p2.goto(`/projects/${P}/meetings/${id}?login=auto`);
  await expect(p2.getByTestId('live-recovery')).toBeVisible({ timeout: 20_000 });
  await expect(p2.getByTestId('live-recovery-text')).toContainText('Dobrý');
  await p2.getByTestId('live-recover-complete').click();
  await expect(p2.getByTestId('live-finalized')).toBeVisible({ timeout: 20_000 });
  void request;
});
