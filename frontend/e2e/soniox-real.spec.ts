import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * BOUNDED real-provider test of the Soniox pipeline (scripts/soniox-real-test.sh). ONE recording (<= 60 s, synthetic Czech), ONE transcription job,
 * local app + THROWAWAY local Supabase only; Gemini is NOT configured (the AI routes answer 503), so only Soniox can bill. No retries: a failure
 * here is reported, never repeated. The Soniox key lives in the environment of this process only (needed for one read-only provider check) and is
 * never printed or written; the report contains no secret. Also runs against the local FAKE Soniox (E2E_FAKE_SONIOX_URL) as a dry run.
 *
 * Env: E2E_REAL_SONIOX=1, E2E_SUPABASE_URL/ANON_KEY/SERVICE_KEY, E2E_STT_SERVER_SECRET, E2E_SYNTH_DIR (synthetic-cs.mp3 + reference.json),
 * E2E_SONIOX_BASE (provider API base for the deletion check), SONIOX_API_KEY, SONIOX_REPORT (output path), optional E2E_FAKE_SONIOX_URL.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY ?? '';
const SECRET = process.env.E2E_STT_SERVER_SECRET ?? '';
const DIR = process.env.E2E_SYNTH_DIR ?? '';
const BASE = (process.env.E2E_SONIOX_BASE ?? '').replace(/\/+$/, '');
const FAKE = process.env.E2E_FAKE_SONIOX_URL ?? '';
const REPORT = process.env.SONIOX_REPORT ?? '';
test.skip(process.env.E2E_REAL_SONIOX !== '1' || !SB || !DIR || SECRET.length < 32 || !BASE, 'bounded Soniox run: use scripts/soniox-real-test.sh');
test.describe.configure({ mode: 'serial', retries: 0 });
test.setTimeout(420_000);

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PROJECT = `sx-p-${run}`;
const ownerEmail = `sx-owner-${run}@example.test`;

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
const rest = (request: APIRequestContext, token: string, path: string) => sb(request, `/rest/v1/${path}`, { token });
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const norm = (s: string) => s.toLowerCase().replace(/[.,!?;:„"“”()]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
const strip = (w: string[]) => w.map((x) => x.normalize('NFD').replace(/[̀-ͯ]/g, ''));
function wer(ref: string[], hyp: string[]) { // word error rate by Levenshtein distance
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)] as number[]);
  for (let j = 0; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++) for (let j = 1; j <= hyp.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  return d[ref.length][hyp.length] / Math.max(1, ref.length);
}

test('ONE real transcription job: consent -> private upload -> signed-URL fetch by the provider -> transcript, speakers, timestamps, ledger, provider deletion', async ({ page, request }) => {
  const reference = JSON.parse(readFileSync(`${DIR}/reference.json`, 'utf8')) as { turns: { speaker: string; text: string }[]; durationSec: number };
  expect(reference.durationSec).toBeLessThanOrEqual(60);
  const audio = readFileSync(`${DIR}/synthetic-cs.mp3`);
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), audioSeconds: reference.durationSec, audioBytes: audio.length, mode: FAKE ? 'fake-provider (dry run)' : 'REAL Soniox' };

  // --- setup: local owner + project; the owner step registers the hash of the server secret
  const su = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email: ownerEmail, password: PASSWORD } });
  expect(su.status, JSON.stringify(su.json)).toBe(200);
  const owner = { id: su.json.user.id as string, token: su.json.access_token as string };
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: owner.token, headers: { Prefer: 'return=minimal' }, data: { id: PROJECT, name: 'Soniox bounded test' } })).status).toBe(201);
  expect((await sb(request, '/rest/v1/server_trust', { method: 'POST', token: SERVICE, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, data: { purpose: 'stt', secret_sha256: createHash('sha256').update(SECRET).digest('hex') } })).status).toBeLessThan(300);
  if (FAKE) await request.post(`${FAKE}/__control`, { data: { reset: true, mode: 'ok', pollsUntilDone: 2, durationMs: Math.round(reference.durationSec * 1000), fetchAudio: true, turns: reference.turns } });

  // --- 1. consent flow + audio validation + private Storage upload (through the UI)
  await loginUi(page, ownerEmail);
  await page.goto(`/projects/${PROJECT}/meetings`);
  await page.getByTestId('meeting-new').click();
  await page.getByTestId('mode-audio').click();
  await page.getByLabel('Název porady').fill('Synthetic Czech recording');
  await page.getByTestId('audio-file').setInputFiles({ name: 'synthetic-cs.mp3', mimeType: 'audio/mpeg', buffer: audio });
  await page.getByTestId('meeting-create').click(); // without consent
  await expect(page.getByTestId('meeting-error')).toBeVisible(); // refused: nothing uploaded
  expect((await rest(request, owner.token, 'meetings?select=id')).json).toEqual([]);
  await page.getByTestId('audio-consent').check();
  await page.getByTestId('meeting-create').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/meetings/[0-9a-f-]{36}$`), { timeout: 30_000 });
  const meetingId = page.url().split('/').pop()!;
  const m0 = (await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=consent_at,audio_path,audio_bytes,stt_state`)).json[0];
  expect(m0.consent_at).toBeTruthy();
  expect(m0.stt_state).toBe('none');
  expect(m0.audio_bytes).toBe(audio.length);
  expect((await rest(request, owner.token, "ai_requests?feature=eq.meeting-transcribe&select=id")).json).toEqual([]); // nothing was sent or booked before the click
  const pub = await request.get(`${SB}/storage/v1/object/public/meeting-audio/${m0.audio_path}`);
  expect([400, 401, 404]).toContain(pub.status()); // the bucket is private

  // --- 2. the explicit start: ONE paid job; never clicked twice, never retried
  await page.getByTestId('stt-start').click();
  const t0 = Date.now();
  let state = '';
  for (let i = 0; i < 70; i++) { // up to ~5 min
    state = (await page.getByTestId('stt-state').textContent()) ?? '';
    if (/Přepis hotov|Přepis selhal/.test(state)) break;
    const check = page.getByTestId('stt-check');
    if (await check.count()) await check.click();
    await page.waitForTimeout(4500);
  }
  // Wall clock of the whole round trip (start click -> final state, incl. upload fetch, provider queue, polling steps of <= 4.5 s). NOT the audio length and NOT the provider's billed seconds (those are audio_ms in the ledger).
  report.wallClockSeconds = Math.round((Date.now() - t0) / 100) / 10;
  report.finalState = state;
  const meeting = (await rest(request, owner.token, `meetings?id=eq.${meetingId}&select=status,stt_state,stt_job_id,stt_audio_ms,stt_cost_usd,stt_model,stt_error_type,stt_attempts,stt_cleanup_pending`)).json[0];
  report.meeting = meeting;
  const jobs = (await rest(request, owner.token, `stt_jobs?meeting_id=eq.${meetingId}&select=attempt,state,cleanup_state,client_reference`)).json;
  const ledger = (await rest(request, owner.token, 'ai_requests?feature=eq.meeting-transcribe&select=provider,status,billing_state,audio_ms,cost_usd,model')).json;
  report.jobs = jobs.map((j: { attempt: number; state: string; cleanup_state: string }) => ({ attempt: j.attempt, state: j.state, cleanup_state: j.cleanup_state }));
  report.ledger = ledger;
  // NO DUPLICATE PAID SUBMISSION, whatever the outcome
  expect(meeting.stt_attempts, 'exactly one submission').toBe(1);
  expect(jobs).toHaveLength(1);
  expect(ledger).toHaveLength(1);
  try {
    expect(state, `the provider run ended in "${state}" (error type: ${meeting.stt_error_type ?? 'none'})`).toMatch(/Přepis hotov/);

    // --- 3. transcript, speakers, timestamps
    const tr = (await rest(request, owner.token, `meeting_transcripts?meeting_id=eq.${meetingId}&select=source,speakers,segments,char_count`)).json;
    expect(tr).toHaveLength(1);
    expect(tr[0].source).toBe('soniox');
    const segs = tr[0].segments as { id: string; startMs: number; endMs: number; speakerId: string | null; text: string }[];
    report.segments = segs.length;
    report.speakers = (tr[0].speakers as { id: string }[]).map((s) => s.id);
    report.transcript = segs.map((s) => ({ speaker: s.speakerId, startMs: s.startMs, endMs: s.endMs, text: s.text })); // synthetic text only
    let prev = -1; let monotonic = true;
    for (const s of segs) { if (!(s.startMs >= prev && s.endMs >= s.startMs)) monotonic = false; prev = s.endMs; }
    report.timestampsMonotonic = monotonic;
    report.lastEndMs = segs[segs.length - 1].endMs;
    expect(monotonic, 'timestamps are normalised and monotonic').toBe(true);
    expect(segs[segs.length - 1].endMs, 'no timestamp beyond the recording (+3 s)').toBeLessThanOrEqual(reference.durationSec * 1000 + 3000);
    expect(report.speakers as string[], 'diarization found at least one speaker').not.toHaveLength(0);
    report.diarizationSeparatedTwoVoices = (report.speakers as string[]).length >= 2;

    // --- 4. Czech accuracy (word error rate against the spoken script; informational, fails only when catastrophic)
    const refWords = norm(reference.turns.map((t) => t.text).join(' '));
    const hypWords = norm(segs.map((s) => s.text).join(' '));
    report.werWithDiacritics = Math.round(wer(refWords, hypWords) * 1000) / 1000;
    report.werWithoutDiacritics = Math.round(wer(strip(refWords), strip(hypWords)) * 1000) / 1000;
    // Per reference turn (a turn is matched with the segment at the same position when the counts agree): an aggregate hides WHERE the errors are.
    if (segs.length === reference.turns.length) report.werPerTurn = reference.turns.map((t, i) => ({ speaker: t.speaker, hypSpeaker: segs[i].speakerId, wer: Math.round(wer(norm(t.text), norm(segs[i].text)) * 1000) / 1000 }));
    expect(report.werWithoutDiacritics as number, 'catastrophic recognition quality').toBeLessThan(0.6);

    // --- 5. usage and cost ledger
    expect(ledger[0]).toMatchObject({ provider: 'soniox', status: 'succeeded' });
    expect(meeting.stt_state).toBe('completed');
    expect(Math.abs(meeting.stt_audio_ms - reference.durationSec * 1000)).toBeLessThan(3000);
    expect(Number(meeting.stt_cost_usd)).toBeLessThan(0.05);
    report.costUsd = Number(meeting.stt_cost_usd);

    // --- 6. provider-side deletion: the local state AND the provider both say the job is gone
    expect(meeting.stt_cleanup_pending).toBe(false);
    expect(jobs[0].cleanup_state).toBe('done');
    const gone = await request.get(`${BASE}/transcriptions/${meeting.stt_job_id}`, { headers: { Authorization: `Bearer ${process.env.SONIOX_API_KEY ?? 'fake-soniox-key'}` } });
    report.providerAnswerForDeletedJob = gone.status();
    expect(gone.status(), 'the provider no longer knows the job').toBe(404);
  } finally {
    // --- 7. safe cleanup of the local test data (the stack is throwaway; this keeps it tidy). Never touches the provider.
    await request.fetch(`${SB}/rest/v1/meetings?id=eq.${meetingId}`, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${owner.token}` } }).catch(() => undefined);
    await request.fetch(`${SB}/rest/v1/projects?id=eq.${PROJECT}`, { method: 'DELETE', headers: { apikey: ANON, Authorization: `Bearer ${owner.token}` } }).catch(() => undefined);
    await request.fetch(`${SB}/auth/v1/admin/users/${owner.id}`, { method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } }).catch(() => undefined);
    if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 1));
  }
});
