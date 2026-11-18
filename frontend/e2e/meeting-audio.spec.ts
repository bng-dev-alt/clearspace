import { createHash } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Meeting audio end to end (R5) against a THROWAWAY local Supabase stack (real GoTrue, PostgREST, RLS, Storage) with a LOCAL FAKE
 * Soniox (e2e/support/fake-soniox.mjs) and a LOCAL FAKE Gemini. No real provider call, no keys, no credits.
 * App must run with STT_ENABLED=1, NEXT_PUBLIC_ENABLE_MEETING_AUDIO=1, SONIOX_API_KEY=fake-soniox-key, SONIOX_BASE_URL=<fake>/v1 and
 * STT_SERVER_SECRET=<the same value as E2E_STT_SERVER_SECRET>; this spec registers only its SHA-256 in server_trust (the owner step).
 * Skipped unless E2E_SUPABASE_URL and E2E_FAKE_SONIOX_URL are set. See docs/intelligence/RELEASE_PLAN_R1_R7.md for the recipe.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const SONIOX = process.env.E2E_FAKE_SONIOX_URL ?? '';
const SERVER_SECRET = process.env.E2E_STT_SERVER_SECRET ?? '';
test.skip(!SB || !SONIOX || SERVER_SECRET.length < 32, 'needs E2E_SUPABASE_URL, E2E_FAKE_SONIOX_URL and E2E_STT_SERVER_SECRET (>= 32 chars; isolated local stack + fake Soniox)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `au-p-${run}`;
const ownerEmail = `au-owner-${run}@example.test`;
const strangerEmail = `au-stranger-${run}@example.test`;
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(125)]);

async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${SB}${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers },
    data: opts.data === undefined ? undefined : JSON.stringify(opts.data),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function signUp(request: APIRequestContext, email: string) {
  const r = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.user.id as string, token: r.json.access_token as string };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const rest = (request: APIRequestContext, token: string, path: string) => sb(request, `/rest/v1/${path}`, { token });
const control = (request: APIRequestContext, data: Record<string, unknown>) => request.post(`${SONIOX}/__control`, { data });
const stats = async (request: APIRequestContext) => (await request.get(`${SONIOX}/__stats`).then((r) => r.json())) as { calls: { method: string; path: string }[]; jobs: { id: string; deleted: boolean; body: Record<string, unknown> }[]; audioFetches: { status: number; bytes: number; head: string }[] };
const listObjects = async (request: APIRequestContext, meetingId: string) => (await sb(request, '/storage/v1/object/list/meeting-audio', { method: 'POST', token: SERVICE, data: { prefix: `${PROJECT}/${meetingId}` } })).json as unknown[];

let owner: Awaited<ReturnType<typeof signUp>>;
let stranger: Awaited<ReturnType<typeof signUp>>;
let meetingId = '';
let meetingUrl = '';

async function createAudioMeeting(page: Page, title: string, opts: { consent: boolean; file?: { name: string; mimeType: string; buffer: Buffer } } = { consent: true }) {
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByTestId('mode-audio').click();
  await page.getByLabel('Název porady').fill(title);
  await page.getByTestId('audio-file').setInputFiles(opts.file ?? { name: 'porada.mp3', mimeType: 'audio/mpeg', buffer: MP3 });
  if (opts.consent) await page.getByTestId('audio-consent').check();
  await page.getByTestId('meeting-create').click();
}
const checkUntil = async (page: Page, state: RegExp) => {
  for (let i = 0; i < 8; i++) {
    if (await page.getByTestId('stt-state').filter({ hasText: state }).count()) return;
    const btn = page.getByTestId('stt-check');
    if (await btn.count()) await btn.click();
    await page.waitForTimeout(700);
  }
  await expect(page.getByTestId('stt-state')).toHaveText(state);
};

test.beforeAll(async ({ request }) => {
  owner = await signUp(request, ownerEmail);
  stranger = await signUp(request, strangerEmail);
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'Zvuk E2E' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: owner.token, data: [{ id: `${PROJECT}-c1`, project_id: PROJECT, name: 'K řešení', position: 0 }] });
  const wm = await sb(request, '/rest/v1/workspace_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: `wm-honza-${run}`, owner_id: owner.id, full_name: 'Honza Novák', initials: 'HN' } });
  expect(wm.status, JSON.stringify(wm.json)).toBe(201);
  await sb(request, '/rest/v1/project_members', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { project_id: PROJECT, member_id: `wm-honza-${run}` } });
  // The OWNER step of the real deployment: register the hash of the server secret (service role = the Supabase dashboard / SQL editor).
  const reg = await sb(request, '/rest/v1/server_trust', { method: 'POST', token: SERVICE, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, data: { purpose: 'stt', secret_sha256: createHash('sha256').update(SERVER_SECRET).digest('hex') } });
  expect(reg.status, JSON.stringify(reg.json)).toBeLessThan(300);
  await control(request, { reset: true, mode: 'ok', pollsUntilDone: 1, durationMs: 12_000, fetchAudio: true });
});

test('consent and content are enforced BEFORE anything is stored: no consent, text renamed to .mp3', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'Bez souhlasu', { consent: false });
  await expect(page.getByTestId('meeting-error')).toContainText('Bez souhlasu');
  await createAudioMeeting(page, 'Falešný soubor', { consent: true, file: { name: 'porada.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('Tohle je jen text, žádný zvuk.') } });
  await expect(page.getByTestId('meeting-error')).toContainText('není zvukový záznam');
  expect((await rest(request, owner.token, 'meetings?select=id')).json).toEqual([]); // nothing was created
  expect((await stats(request)).calls.filter((c) => c.path.startsWith('/v1/'))).toHaveLength(0); // the provider was never contacted
});

test('upload with consent: private bucket object, consent recorded, NOTHING sent to the provider until the user clicks', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'Týdenní porada (zvuk)');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  meetingUrl = page.url();
  meetingId = meetingUrl.split('/').pop()!;
  await expect(page.getByTestId('audio-panel')).toBeVisible();
  await expect(page.getByTestId('audio-info')).toContainText('Souhlas účastníků zaznamenán');
  const m = (await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=source_kind,consent_at,consent_by,audio_path,audio_bytes,audio_mime,stt_state,status`)).json[0];
  expect(m).toMatchObject({ source_kind: 'audio', audio_bytes: MP3.length, audio_mime: 'audio/mpeg', stt_state: 'none', status: 'uploaded', consent_by: owner.id });
  expect(m.consent_at).toBeTruthy();
  expect(m.audio_path).toMatch(new RegExp(`^${PROJECT}/${meetingId}/[0-9a-f-]{36}\\.mp3$`));
  expect(await listObjects(request, meetingId)).toHaveLength(1);
  expect((await stats(request)).jobs).toHaveLength(0);
  await expect(page.getByTestId('stt-start')).toBeVisible();
  // a stranger cannot read the object (private bucket + RLS)
  const foreign = await request.get(`${SB}/storage/v1/object/authenticated/meeting-audio/${m.audio_path}`, { headers: { apikey: ANON, Authorization: `Bearer ${stranger.token}` } });
  expect([400, 401, 403, 404]).toContain(foreign.status());
  const pub = await request.get(`${SB}/storage/v1/object/public/meeting-audio/${m.audio_path}`);
  expect([400, 401, 404]).toContain(pub.status());
});

test('transcription: start -> provider fetches the signed URL -> sync stores the transcript ONCE -> provider data deleted; usage booked', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await page.getByTestId('stt-start').click();
  await expect(page.getByTestId('stt-state')).toHaveText(/Přepisuji|Odesílám/, { timeout: 15_000 });
  const s1 = await stats(request);
  expect(s1.jobs).toHaveLength(1);
  expect(s1.jobs[0].body).toMatchObject({ model: 'stt-async-v6', language_hints: ['cs', 'en'], enable_speaker_diarization: true, client_reference_id: `${meetingId}:1` });
  expect(String(s1.jobs[0].body.audio_url)).toContain('/storage/v1/object/sign/meeting-audio/'); // a signed URL, not the file bytes
  // PRIVACY: no member name (here the project has member "Honza Novák"), no meeting title, no project name goes to the provider
  expect(s1.jobs[0].body.context).toEqual({ general: [{ key: 'domain', value: 'Project meeting' }] });
  expect(JSON.stringify(s1.jobs[0].body)).not.toMatch(/Honza|Novák|Týdenní|Zvuk E2E/);
  expect(s1.audioFetches[0].status).toBe(200); expect(s1.audioFetches[0].head.startsWith('494433')).toBe(true); // the provider could read the audio through the signed URL

  await checkUntil(page, /Přepis hotov/);
  await expect(page.getByTestId('stt-usage')).toContainText('0.2 min');
  await expect(page.getByTestId('machine-transcript-note')).toContainText('Strojový přepis');
  await expect(page.locator('[data-testid^="segment-seg-"]')).toHaveCount(3);
  await expect(page.getByTestId('transcript')).toContainText('Rozhodli jsme, že release posuneme na pátek.');

  const tr = (await rest(request, owner.token, `meeting_transcripts?meeting_id=eq.${meetingId}&select=source,revision,speakers,char_count`)).json;
  expect(tr).toHaveLength(1);
  expect(tr[0].source).toBe('soniox');
  expect(tr[0].speakers).toEqual([{ id: 'S1', label: 'Mluvčí 1', displayName: null }, { id: 'S2', label: 'Mluvčí 2', displayName: null }]);
  const mt = (await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=status,stt_state,stt_job_id,stt_audio_ms,stt_cost_usd,stt_cleanup_pending,stt_model,audio_delete_after,current_revision`)).json[0];
  expect(mt).toMatchObject({ status: 'transcribed', stt_state: 'completed', stt_job_id: 'tr-1', stt_audio_ms: 12_000, stt_cleanup_pending: false, stt_model: 'stt-async-v6', current_revision: tr[0].revision });
  expect(Number(mt.stt_cost_usd)).toBeCloseTo(0.0003, 4);
  expect(Date.parse(mt.audio_delete_after) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
  const led = (await rest(request, owner.token, "ai_requests?feature=eq.meeting-transcribe&select=provider,status,audio_ms,cost_usd,model")).json;
  expect(led).toEqual([{ provider: 'soniox', status: 'succeeded', audio_ms: 12_000, cost_usd: 0.0003, model: 'stt-async-v6' }]);
  expect((await stats(request)).jobs[0].deleted).toBe(true); // provider data removed right after the transcript was stored
});

test('duplicate / repeated requests cost nothing; a stranger gets 404 on every route', async ({ request }) => {
  const call = (route: string, token: string, body: Record<string, unknown> = {}) => request.post(`/api/ai/meetings/${route}`, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, data: { projectId: PROJECT, meetingId, ...body } });
  const before = (await stats(request)).calls.length;
  const again = await call('transcribe', owner.token);
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ started: false, state: 'completed' });
  const sync = await call('sync', owner.token);
  expect(await sync.json()).toMatchObject({ state: 'completed', cleanupPending: false });
  expect((await stats(request)).calls.length).toBe(before); // idempotent: not a single provider call
  expect((await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&select=id')).json).toHaveLength(1);
  for (const route of ['transcribe', 'sync', 'purge']) expect((await call(route, stranger.token)).status(), route).toBe(404);
  expect((await request.post('/api/ai/meetings/transcribe', { headers: { 'Content-Type': 'application/json' }, data: { projectId: PROJECT, meetingId } })).status()).toBe(401);
});

test('the machine transcript flows into Meeting Intelligence: analysis (fake Gemini) cites segments of the Soniox transcript; nothing reaches the board', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await page.getByTestId('meeting-analyze').click();
  await expect(page.getByTestId('meeting-notice')).toContainText('Analýza hotová', { timeout: 30_000 });
  const items = (await rest(request, owner.token, 'intelligence_items?select=kind,review_state,evidence&order=ordinal')).json;
  expect(items.length).toBeGreaterThanOrEqual(3);
  expect(items.every((i: { review_state: string }) => i.review_state === 'proposed')).toBe(true);
  expect(items[0].evidence[0].ref).toMatch(/^segment:seg-\d+-\d+$/); // evidence points at Soniox segment ids
  expect((await rest(request, owner.token, `cards?select=id&column_id=eq.${PROJECT}-c1`)).json).toEqual([]);
});

test('retention: when the deadline has passed the audio is deleted from Storage and the row says so; the transcript stays', async ({ page, request }) => {
  await sb(request, `/rest/v1/meetings?id=eq.${meetingId}`, { method: 'PATCH', token: SERVICE, data: { audio_delete_after: new Date(Date.now() - 60_000).toISOString() } });
  expect(await listObjects(request, meetingId)).toHaveLength(1);
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl);
  await expect(page.getByTestId('audio-info')).toContainText('Zvuk byl smazán', { timeout: 20_000 });
  expect(await listObjects(request, meetingId)).toHaveLength(0);
  const m = (await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=audio_path,audio_deleted_at`)).json[0];
  expect(m.audio_path).toBeNull();
  expect(m.audio_deleted_at).toBeTruthy();
  await expect(page.getByTestId('transcript')).toContainText('Rozhodli jsme');
  await expect(page.getByTestId('stt-start')).toHaveCount(0);
});

test('failure and retry: a provider job error shows the reason by TYPE, a retry works (attempt 2 of 3), the ledger tells the truth', async ({ page, request }) => {
  await control(request, { reset: true, mode: 'job_error', fetchAudio: true });
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'Porada se selháním');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  const url = page.url();
  const id = url.split('/').pop()!;
  await page.getByTestId('stt-start').click();
  await checkUntil(page, /Přepis selhal/);
  await expect(page.getByTestId('stt-error')).toContainText('nepřijal jako zvuk');
  await expect(page.getByTestId('stt-error')).toContainText('Pokus 1 z 3');
  await expect(page.getByTestId('stt-error')).not.toContainText('unsupported provider text'); // provider text never shown
  const m1 = (await rest(request, owner.token, `meetings?id=eq.${id}&select=stt_state,stt_error_type,stt_attempts,stt_cleanup_pending,status`)).json[0];
  expect(m1).toMatchObject({ stt_state: 'failed', stt_error_type: 'invalid_audio_file', stt_attempts: 1, status: 'failed' });
  expect((await rest(request, owner.token, `meeting_transcripts?meeting_id=eq.${id}&select=revision`)).json).toEqual([]);
  const failed = (await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&status=eq.failed&select=audio_ms,cost_usd,error_code')).json;
  expect(failed).toEqual([{ audio_ms: 0, cost_usd: 0, error_code: 'invalid_audio_file' }]); // a failed attempt is free in the ledger

  await control(request, { reset: true, mode: 'ok', pollsUntilDone: 1, fetchAudio: true });
  await expect(page.getByTestId('stt-start')).toContainText('Zkusit znovu (pokus 2 z 3)');
  await page.getByTestId('stt-start').click();
  await checkUntil(page, /Přepis hotov/);
  expect((await rest(request, owner.token, `meetings?id=eq.${id}&select=stt_state,stt_attempts`)).json[0]).toMatchObject({ stt_state: 'completed', stt_attempts: 2 });
  await expect(page.locator('[data-testid^="segment-seg-"]')).toHaveCount(3);
});

test('deleting a meeting removes its audio from Storage first (no orphan file)', async ({ page, request }) => {
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'K smazání');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  expect(await listObjects(request, id)).toHaveLength(1);
  await page.getByTestId('meeting-delete').click();
  await page.getByTestId('meeting-delete-confirm').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings$`), { timeout: 20_000 });
  expect(await listObjects(request, id)).toHaveLength(0);
  expect((await rest(request, owner.token, `meetings?id=eq.${id}&select=id`)).json).toEqual([]);
});

test('AUDIT PROBES: a legitimate member calling the trusted STT RPCs with their own JWT is refused (no budgets, no forged transcript)', async ({ request }) => {
  const call = (fn: string, data: Record<string, unknown>) => sb(request, `/rest/v1/rpc/${fn}`, { method: 'POST', token: owner.token, data });
  expect((await call('stt_reserve', { p_meeting: meetingId, p_est_audio_ms: 1, p_user_daily_ms: 999999999, p_global_daily_ms: 999999999 })).status).toBe(404); // the old, secret-less signature no longer exists
  const forged = 'x'.repeat(40);
  expect((await call('stt_reserve', { p_server_secret: forged, p_meeting: meetingId, p_est_audio_ms: 1, p_user_daily_ms: 999999999, p_global_daily_ms: 999999999 })).status).toBe(403);
  expect((await call('stt_complete', { p_server_secret: forged, p_meeting: meetingId, p_job_id: 'x', p_model: 'm', p_audio_ms: 1, p_transcript: { revision: 'a', speakers: [], segments: [], coverage: {}, char_count: 1 } })).status).toBe(403);
  expect((await call('stt_fail', { p_server_secret: forged, p_meeting: meetingId, p_job_id: null, p_error_type: 'x', p_billing: 'none' })).status).toBe(403);
  expect((await sb(request, '/rest/v1/ai_requests', { method: 'POST', token: owner.token, data: { feature: 'meeting-transcribe', status: 'succeeded' } })).status).toBe(403);
  expect((await rest(request, owner.token, 'server_trust?select=*')).status).toBe(403);
});

test('an UNCERTAIN provider answer is never re-sent: the page says "unknown", reconciliation ADOPTS the existing job, exactly ONE paid request', async ({ page, request }) => {
  await control(request, { reset: true, mode: 'create_lost_response', pollsUntilDone: 1, fetchAudio: true });
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'Ztracená odpověď');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  await page.getByTestId('stt-start').click();
  await expect(page.getByTestId('stt-state')).toHaveText(/Ověřuji/, { timeout: 15_000 });
  await expect(page.getByTestId('stt-unknown')).toContainText('neví, jestli přepis vznikl');
  const s1 = await stats(request);
  expect(s1.calls.filter((c) => c.method === 'POST' && c.path === '/v1/transcriptions')).toHaveLength(1);
  expect(s1.jobs).toHaveLength(1); // the job EXISTS at the provider although the answer was lost
  const led = (await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&order=created_at.desc&limit=1&select=status,billing_state,audio_ms')).json[0];
  expect(led.billing_state).toBe('uncertain'); // the estimate stays in the budget while the outcome is unknown
  await control(request, { mode: 'ok' });
  await checkUntil(page, /Přepis hotov/);
  const s2 = await stats(request);
  expect(s2.calls.filter((c) => c.method === 'POST' && c.path === '/v1/transcriptions')).toHaveLength(1); // NEVER a second paid request
  expect((await rest(request, owner.token, `meetings?id=eq.${id}&select=stt_state,stt_attempts,stt_job_id`)).json[0]).toMatchObject({ stt_state: 'completed', stt_attempts: 1, stt_job_id: 'tr-1' });
  const done = (await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&order=created_at.desc&limit=1&select=status,billing_state,audio_ms')).json[0];
  expect(done).toMatchObject({ status: 'succeeded', billing_state: 'actual', audio_ms: 12_000 });
});

test('cancel keeps the cost and the provider job id; the provider copy is deleted later and the page tells the truth meanwhile', async ({ page, request }) => {
  await control(request, { reset: true, mode: 'ok', pollsUntilDone: 99, fetchAudio: true });
  await loginUi(page, ownerEmail);
  await createAudioMeeting(page, 'Zrušená porada');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  await page.getByTestId('stt-start').click();
  await expect(page.getByTestId('stt-state')).toHaveText(/Přepisuji/, { timeout: 15_000 });
  await page.getByTestId('stt-cancel').click();
  await expect(page.getByTestId('stt-state')).toHaveText(/Přepis selhal/, { timeout: 15_000 });
  const led = (await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&order=created_at.desc&limit=1&select=status,billing_state,audio_ms')).json[0];
  expect(led).toMatchObject({ status: 'failed', billing_state: 'estimated' });
  expect(led.audio_ms).toBeGreaterThan(0); // the cancelled estimate is NOT released (the provider may still bill it)
  const m = (await rest(request, owner.token, `meetings?id=eq.${id}&select=stt_state,stt_job_id,stt_cleanup_pending,audio_delete_after`)).json[0];
  expect(m).toMatchObject({ stt_state: 'failed', stt_job_id: 'tr-1', stt_cleanup_pending: true });
  expect(m.audio_delete_after).toBeTruthy(); // a failed / cancelled meeting still has a deletion deadline
  expect((await stats(request)).jobs[0].deleted).toBe(false); // a still-running job cannot be deleted yet
  await expect(page.getByTestId('stt-cleanup')).toBeVisible(); // honest: the provider copy still exists
  await control(request, { pollsUntilDone: -1 }); // the provider no longer runs it
  // the failed deletion was rescheduled with a back-off; make it due now (the owner would simply wait)
  expect((await sb(request, `/rest/v1/stt_jobs?meeting_id=eq.${id}`, { method: 'PATCH', token: SERVICE, headers: { Prefer: 'return=minimal' }, data: { cleanup_due_at: new Date(Date.now() - 60_000).toISOString() } })).status).toBeLessThan(300);
  await page.reload();
  await expect.poll(async () => (await stats(request)).jobs[0].deleted, { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await rest(request, owner.token, `meetings?id=eq.${id}&select=stt_cleanup_pending`)).json[0].stt_cleanup_pending, { timeout: 20_000 }).toBe(false);
});

test('the provider key never reaches the browser: the page bundle and responses contain no key', async ({ page }) => {
  const seen: string[] = [];
  page.on('response', async (r) => { try { if (r.url().includes('/_next/') || r.url().includes('/api/')) seen.push(await r.text()); } catch { /* binary */ } });
  await loginUi(page, ownerEmail);
  await page.goto(meetingUrl.replace(/\/[0-9a-f-]{36}$/, ''));
  await page.waitForTimeout(1500);
  const all = seen.join('\n');
  expect(all).not.toContain('fake-soniox-key');
  expect(all).not.toMatch(/SONIOX_API_KEY/);
});
