import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { startFakeSoniox, type FakeSoniox } from '../../../e2e/support/fake-soniox.mjs';
import { SonioxClient } from '../../lib/stt/soniox';
import { purgeAudio, startTranscription, syncTranscription, sttLimitsFromEnv, type SttLimits } from '../../lib/stt/pipeline';
import { AiGatewayError } from '../../lib/ai/errors';

/**
 * Přepis zvuku: celý tok proti LOKÁLNÍMU falešnému Soniox (skutečné HTTP) a skriptovanou databází (RPC se jen zaznamenávají;
 * skutečná RPC ověřují DB testy 82_meeting_audio a E2E na lokálním Supabase). Žádný klíč, žádné kredity.
 */
interface H {
  meeting: Record<string, unknown> | null;
  rpc: { name: string; args: Record<string, unknown> }[];
  rpcImpl: Record<string, (a: Record<string, unknown>) => { data: unknown; error: null | { code: string } }>;
  order: string[];
  signedUrl: string;
  signError: null | { message: string };
  removed: string[];
  removeError: null | { message: string };
  members: { member: { full_name: string } }[];
  projectName: string;
}
let fake: FakeSoniox;
let h: H;
const MID = '11111111-1111-4111-8111-111111111111';

const baseMeeting = () => ({
  id: MID, project_id: 'pA', title: 'Porada', source_kind: 'audio', language_hint: null, audio_path: `pA/${MID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp3`,
  audio_bytes: 1_000_000, audio_client_ms: 600_000, audio_deleted_at: null, audio_delete_after: null, stt_state: 'none', stt_job_id: null,
  stt_cleanup_pending: false, stt_submitted_at: null, stt_attempts: 0, stt_error_type: null, speaker_names: { S1: 'Petr Novák' },
});

function makeDb(): SupabaseClient {
  const builder = (table: string) => {
    const result = () => {
      if (table === 'meetings') return { data: h.meeting, error: null };
      if (table === 'projects') return { data: { name: h.projectName }, error: null };
      return { data: h.members, error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = () => Promise.resolve(result());
    b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
    return b;
  };
  return {
    from: builder,
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpc.push({ name, args });
      h.order.push(name);
      return (h.rpcImpl[name] ?? (() => ({ data: null, error: null })))(args);
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => { h.order.push('signedUrl'); return h.signError ? { data: null, error: h.signError } : { data: { signedUrl: h.signedUrl }, error: null }; },
        remove: async (paths: string[]) => { h.order.push('remove'); h.removed.push(...paths); return { data: [], error: h.removeError }; },
      }),
    },
  } as unknown as SupabaseClient;
}

const limits: SttLimits = { userDailyMs: 7_200_000, globalDailyMs: 36_000_000, retentionDays: 7, signedUrlTtlSec: 7200 };
const soniox = () => new SonioxClient({ apiKey: fake.key, baseUrl: fake.url, model: 'stt-async-v6', timeoutMs: 3000, retryDelayMs: 0 });
const calls = async () => ((await (await fetch(`${fake.origin}/__stats`)).json()) as { calls: { method: string; path: string }[]; jobs: { id: string; deleted: boolean; body: Record<string, unknown> }[] });
const sonioxCalls = async () => (await calls()).calls.filter((c) => c.path.startsWith('/v1/'));
const rpcNamed = (n: string) => h.rpc.filter((r) => r.name === n);
const start = () => startTranscription({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA', limits });
const sync = (over: Partial<Parameters<typeof syncTranscription>[0]> = {}) => syncTranscription({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA', limits, ...over });
/** Minimální obraz toho, co dělají RPC v databázi (skutečná RPC testují DB testy): po dokončení/selhání čeká úklid u poskytovatele. */
const dbEffects = () => {
  h.rpcImpl.stt_complete = () => { Object.assign(h.meeting as object, { stt_state: 'completed', stt_cleanup_pending: true }); return { data: 'a'.repeat(64), error: null }; };
  h.rpcImpl.stt_fail = (a) => { Object.assign(h.meeting as object, { stt_state: 'failed', stt_cleanup_pending: !!(h.meeting as { stt_job_id: string | null }).stt_job_id || !!a.p_job_id }); return { data: null, error: null }; };
  h.rpcImpl.stt_mark_cleaned = () => { Object.assign(h.meeting as object, { stt_cleanup_pending: false }); return { data: null, error: null }; };
};
const reserveOutcome = (outcome: string) => { h.rpcImpl.stt_reserve = () => ({ data: [{ outcome, request_id: 'req-1', attempt: 1, audio_path: String(h.meeting?.audio_path), audio_mime: 'audio/mpeg', project_id: 'pA' }], error: null }); };

beforeAll(async () => { fake = await startFakeSoniox(); });
afterAll(async () => { await fake.close(); });
beforeEach(async () => {
  await fake.control({ reset: true, mode: 'ok', pollsUntilDone: 1, durationMs: 12_000, fetchAudio: false });
  h = { meeting: baseMeeting(), rpc: [], rpcImpl: {}, order: [], signedUrl: `${fake.origin}/__audio/ok.mp3?token=signed`, signError: null, removed: [], removeError: null, members: [{ member: { full_name: 'Honza Novák' } }, { member: { full_name: 'Jana\u0000 Svobodová' } }], projectName: 'Projekt A' };
  reserveOutcome('started');
  dbEffects();
});

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(AiGatewayError);
  expect((e as AiGatewayError).code).toBe(code);
  return e as AiGatewayError;
};

describe('startTranscription: the happy path', () => {
  test('reserve -> signed URL -> content check -> ONE Soniox request -> attach job; in that order', async () => {
    const r = await start();
    expect(r).toEqual({ started: true, state: 'transcribing', attempt: 1 });
    expect(h.order).toEqual(['stt_reserve', 'signedUrl', 'stt_attach_job']);
    const c = await calls();
    expect(c.calls.filter((x) => x.method === 'POST' && x.path === '/v1/transcriptions')).toHaveLength(1);
    expect(c.jobs[0].body).toMatchObject({ audio_url: h.signedUrl, language_hints: ['cs', 'en'], enable_speaker_diarization: true, model: 'stt-async-v6', client_reference_id: MID });
    expect(rpcNamed('stt_attach_job')[0].args).toEqual({ p_meeting: MID, p_job_id: 'tr-1', p_model: 'stt-async-v6' });
  });
  test('the context carries project name and member/speaker names as data (control characters removed, deduplicated)', async () => {
    await start();
    const ctx = (await calls()).jobs[0].body.context as { general: { key: string; value: string }[]; terms: string[] };
    expect(ctx.general).toEqual([{ key: 'domain', value: 'Project meeting' }, { key: 'project', value: 'Projekt A' }]);
    expect(ctx.terms.sort()).toEqual(['Honza Novák', 'Jana Svobodová', 'Petr Novák']);
  });
  test('English meetings hint English first', async () => {
    (h.meeting as Record<string, unknown>).language_hint = 'en';
    await start();
    expect((await calls()).jobs[0].body.language_hints).toEqual(['en', 'cs']);
  });
  test('the reservation estimate cannot be undercut by a lying client duration, and limits are passed through', async () => {
    Object.assign(h.meeting as object, { audio_bytes: 50_000_000, audio_client_ms: 1000 });
    await start();
    expect(rpcNamed('stt_reserve')[0].args).toEqual({ p_meeting: MID, p_est_audio_ms: Math.floor((50_000_000 * 8) / 320), p_user_daily_ms: 7_200_000, p_global_daily_ms: 36_000_000 });
  });
  test('the signed URL is requested with a 2-hour validity (provider queue time is unbounded)', () => {
    expect(sttLimitsFromEnv({}).signedUrlTtlSec).toBe(7200);
  });
});

describe('startTranscription: idempotency and refusals never reach the provider', () => {
  test.each([
    ['in_progress', { started: false, state: 'transcribing' }],
    ['already_done', { started: false, state: 'completed' }],
  ])('%s: nothing is submitted, no URL is signed', async (outcome, expected) => {
    reserveOutcome(outcome);
    expect(await start()).toEqual(expected);
    expect(await sonioxCalls()).toHaveLength(0);
    expect(h.order).toEqual(['stt_reserve']);
  });
  test.each([
    ['no_consent', 'consent_required'], ['no_audio', 'stt_no_audio'], ['attempts_exhausted', 'stt_attempts_exhausted'],
    ['budget_exceeded', 'budget_exceeded'], ['global_budget_exceeded', 'ai_unavailable'], ['something_new', 'ai_unavailable'],
  ])('%s -> %s, no provider call, no signed URL', async (outcome, code) => {
    reserveOutcome(outcome);
    await rejects(start(), code);
    expect(await sonioxCalls()).toHaveLength(0);
    expect(h.order).toEqual(['stt_reserve']);
  });
  test('two concurrent starts: the database lets exactly one through, the provider sees one request', async () => {
    let n = 0;
    h.rpcImpl.stt_reserve = () => ({ data: [{ outcome: n++ === 0 ? 'started' : 'in_progress', request_id: 'r', attempt: 1, audio_path: String(h.meeting?.audio_path), audio_mime: 'audio/mpeg', project_id: 'pA' }], error: null });
    const [a, b] = await Promise.all([start(), start()]);
    expect([a.started, b.started].sort()).toEqual([false, true]);
    expect((await calls()).jobs).toHaveLength(1);
  });
  test('reserve errors fail closed: 42501 -> forbidden, 22023 -> bad_request, anything else -> unavailable; nothing is sent', async () => {
    for (const [code, expected] of [['42501', 'forbidden'], ['22023', 'bad_request'], ['XX000', 'ai_unavailable']] as const) {
      h.rpcImpl.stt_reserve = () => ({ data: null, error: { code } });
      await rejects(start(), expected);
    }
    expect(await sonioxCalls()).toHaveLength(0);
  });
  test('an unknown, foreign or text meeting is "not found" (identical answer, no RPC at all)', async () => {
    h.meeting = null;
    await rejects(start(), 'not_found');
    h.meeting = { ...baseMeeting(), project_id: 'other' };
    await rejects(start(), 'not_found');
    h.meeting = { ...baseMeeting(), source_kind: 'text' };
    await rejects(start(), 'not_found');
    expect(h.rpc).toHaveLength(0);
  });
  test('a meeting without an uploaded file never reaches the database or the provider', async () => {
    Object.assign(h.meeting as object, { audio_bytes: null, audio_path: null });
    await rejects(start(), 'stt_no_audio');
    expect(h.rpc).toHaveLength(0);
  });
});

describe('startTranscription: invalid audio and failures are closed cleanly (state never left hanging)', () => {
  test('content that is not audio is rejected BEFORE the provider (no cost) and the job is closed as invalid_audio', async () => {
    h.signedUrl = `${fake.origin}/__audio/bad.mp3?token=x`;
    await rejects(start(), 'stt_invalid_audio');
    expect(await sonioxCalls()).toHaveLength(0);
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: null, p_error_type: 'invalid_audio' });
  });
  test('a storage error closes the job as storage_unavailable', async () => {
    h.signError = { message: 'boom' };
    await rejects(start(), 'stt_unavailable');
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'storage_unavailable' });
    expect(await sonioxCalls()).toHaveLength(0);
  });
  test('an unreachable audio URL closes the job as storage_unavailable', async () => {
    h.signedUrl = 'http://127.0.0.1:1/x';
    await rejects(start(), 'stt_unavailable');
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'storage_unavailable' });
  });
  test.each([
    ['create_400', 'stt_failed', 'invalid_request'],
    ['create_402', 'stt_unavailable', 'organization_balance_exhausted'],
    ['create_429', 'stt_unavailable', 'limit_exceeded'],
    ['create_500', 'stt_unavailable', 'internal_error'],
    ['create_503', 'stt_unavailable', 'service_unavailable'],
  ])('provider %s -> %s; the job is closed with the TYPE %s; the paid POST is not repeated', async (mode, code, type) => {
    await fake.control({ mode });
    const e = await rejects(start(), code);
    expect(e.message).not.toMatch(/balance|zůstatek|provider message|402/i); // billing state and provider text are never exposed
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: null, p_error_type: type });
    expect((await sonioxCalls()).filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(rpcNamed('stt_attach_job')).toHaveLength(0);
  });
  test('a missing/unreachable provider is a network failure, closed as network_error', async () => {
    const dead = new SonioxClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v1', model: 'stt-async-v6', timeoutMs: 500, retryDelayMs: 0 });
    await rejects(startTranscription({ db: makeDb(), soniox: dead, meetingId: MID, projectId: 'pA', limits }), 'stt_unavailable');
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'network_error' });
  });
  test('if the job id cannot be recorded, the job is closed WITH its id so cleanup can delete it at the provider', async () => {
    h.rpcImpl.stt_attach_job = () => ({ data: null, error: { code: 'XX000' } });
    await rejects(start(), 'stt_failed');
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: 'tr-1', p_error_type: 'attach_failed' });
  });
});

describe('syncTranscription', () => {
  const running = (extra: Record<string, unknown> = {}) => { h.meeting = { ...baseMeeting(), stt_state: 'transcribing', stt_job_id: 'tr-1', stt_submitted_at: new Date().toISOString(), ...extra }; };
  const create = async () => { running(); await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' }); };

  test('while the provider works: the state is reported, nothing is stored', async () => {
    await create();
    await fake.control({ pollsUntilDone: 3 });
    const r = await sync();
    expect(r).toMatchObject({ state: 'transcribing', providerStatus: 'queued', stuck: false });
    expect(rpcNamed('stt_complete')).toHaveLength(0);
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });

  test('completion: normalised transcript is stored ONCE through stt_complete with the real duration, then the provider data is deleted', async () => {
    await create();
    await sync(); // queued
    const r = await sync(); // completed
    expect(r.revision).toBe('a'.repeat(64));
    const done = rpcNamed('stt_complete');
    expect(done).toHaveLength(1);
    const a = done[0].args as { p_meeting: string; p_job_id: string; p_model: string; p_audio_ms: number; p_retention_days: number; p_transcript: { revision: string; segments: unknown[]; speakers: unknown[]; char_count: number } };
    expect(a).toMatchObject({ p_meeting: MID, p_job_id: 'tr-1', p_model: 'stt-async-v6', p_audio_ms: 12_000, p_retention_days: 7 });
    expect(a.p_transcript.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(a.p_transcript.segments).toHaveLength(3);
    expect(a.p_transcript.speakers).toHaveLength(2);
    expect(a.p_transcript.char_count).toBeGreaterThan(50);
    expect((await calls()).jobs[0].deleted).toBe(true); // provider data deleted right after the transcript is stored
    expect(rpcNamed('stt_mark_cleaned')).toHaveLength(1);
    expect(h.order.indexOf('stt_complete')).toBeLessThan(h.order.indexOf('stt_mark_cleaned'));
  });

  test('a failed provider delete does NOT lose the transcript; cleanup stays pending and is retried on the next sync', async () => {
    await create();
    await sync();
    await fake.control({ mode: 'delete_500' });
    const r = await sync();
    expect(rpcNamed('stt_complete')).toHaveLength(1);
    expect(rpcNamed('stt_mark_cleaned')).toHaveLength(0);
    expect(r.cleanupPending).toBe(true);
    // next sync: the meeting is completed, cleanup pending, the provider recovers
    await fake.control({ mode: 'ok' });
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    const again = await sync();
    expect(rpcNamed('stt_mark_cleaned')).toHaveLength(1);
    expect(again.cleanupPending).toBe(false);
    expect(rpcNamed('stt_complete')).toHaveLength(1); // not stored twice
  });

  test('a settled meeting without pending work costs zero provider calls', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: false };
    const r = await sync();
    expect(r.state).toBe('completed');
    expect(await sonioxCalls()).toHaveLength(0);
  });

  test('a provider-side job error closes the job with the error TYPE (never the message) and cleans up', async () => {
    await fake.control({ mode: 'job_error' });
    await create();
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: 'tr-1', p_error_type: 'invalid_audio_file' });
    expect(JSON.stringify(h.rpc)).not.toMatch(/unsupported provider text/);
    expect(rpcNamed('stt_complete')).toHaveLength(0);
  });

  test('the documentation\'s alternative failure status ("failed") is a failure, not a hang', async () => {
    await fake.control({ mode: 'job_failed_status' });
    await create();
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'unknown_status' });
  });

  test('a transcript without speech closes the job as empty_transcript (no empty meeting transcript is stored)', async () => {
    await fake.control({ mode: 'empty' });
    await create();
    await sync();
    await sync();
    expect(rpcNamed('stt_complete')).toHaveLength(0);
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'empty_transcript' });
  });

  test('a transient provider error does not fail the job: the page just asks again', async () => {
    await create();
    await fake.control({ mode: 'status_500' });
    const r = await sync();
    expect(r).toMatchObject({ transient: true, state: 'transcribing' });
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });

  test('the provider has forgotten the job (404): the job is closed as transcription_not_found', async () => {
    running({ stt_job_id: 'tr-unknown' });
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: 'tr-unknown', p_error_type: 'transcription_not_found' });
  });

  test('a rejected key (401) is reported as unavailable and the job stays recoverable (not failed)', async () => {
    await create();
    const bad = new SonioxClient({ apiKey: 'wrong', baseUrl: fake.url, model: 'm', timeoutMs: 2000, retryDelayMs: 0 });
    await rejects(syncTranscription({ db: makeDb(), soniox: bad, meetingId: MID, projectId: 'pA', limits }), 'stt_unavailable');
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });

  test('stuck jobs are flagged so the UI can offer "check again / cancel"', async () => {
    await create();
    await fake.control({ pollsUntilDone: 99 });
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString();
    running({ stt_submitted_at: old });
    expect((await sync()).stuck).toBe(true);
    h.meeting = { ...baseMeeting(), stt_state: 'submitting', stt_submitted_at: new Date(Date.now() - 11 * 60_000).toISOString() };
    expect((await sync()).stuck).toBe(true);
    h.meeting = { ...baseMeeting(), stt_state: 'submitting', stt_submitted_at: new Date().toISOString() };
    expect((await sync()).stuck).toBe(false);
  });

  test('cancel closes a running job as "cancelled" (the user decides; nothing is retried automatically)', async () => {
    running();
    await sync({ cancel: true });
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_meeting: MID, p_job_id: 'tr-1', p_error_type: 'cancelled' });
  });

  test('stt_complete errors: a forbidden answer is surfaced, anything else is transient (retry next poll, nothing lost at the provider)', async () => {
    await create();
    await sync();
    h.rpcImpl.stt_complete = () => ({ data: null, error: { code: 'XX000' } });
    expect(await sync()).toMatchObject({ transient: true });
    expect((await calls()).jobs[0].deleted).toBe(false); // provider data is kept until the transcript is really stored
    h.rpcImpl.stt_complete = () => ({ data: null, error: { code: '42501' } });
    await rejects(sync(), 'forbidden');
  });

  test('retention: audio older than its deadline is deleted from Storage and then marked deleted; before the deadline nothing happens', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', audio_delete_after: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await sync()).audioPurged).toBe(false);
    expect(h.removed).toHaveLength(0);
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', audio_delete_after: new Date(Date.now() - 1000).toISOString() };
    expect((await sync()).audioPurged).toBe(true);
    expect(h.removed).toEqual([String((h.meeting as Record<string, unknown>).audio_path)]);
    expect(h.order.indexOf('remove')).toBeLessThan(h.order.indexOf('mark_audio_deleted'));
  });

  test('sync on a foreign meeting is "not found"', async () => {
    h.meeting = null;
    await rejects(sync(), 'not_found');
  });
});

describe('purgeAudio', () => {
  test('deletes the Storage object first and marks the row afterwards', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1' };
    const r = await purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA' });
    expect(r.audioDeleted).toBe(true);
    expect(h.order).toEqual(['remove', 'mark_audio_deleted']);
  });
  test('refuses while a transcription runs', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'transcribing', stt_job_id: 'tr-1' };
    await rejects(purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA' }), 'conflict');
    expect(h.removed).toHaveLength(0);
  });
  test('a Storage failure or a database refusal is reported and never claims the audio is gone', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed' };
    h.removeError = { message: 'x' };
    await rejects(purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA' }), 'stt_failed');
    expect(rpcNamed('mark_audio_deleted')).toHaveLength(0);
    h.removeError = null;
    h.rpcImpl.mark_audio_deleted = () => ({ data: null, error: { code: '55000' } });
    await rejects(purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA' }), 'stt_failed');
  });
  test('with includeProvider the provider data is deleted too (used before a meeting is removed)', async () => {
    await fake.control({ pollsUntilDone: 0 });
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' });
    await soniox().getTranscription('tr-1');
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    const r = await purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA', includeProvider: true });
    expect(r.cleanupPending).toBe(false);
    expect((await calls()).jobs[0].deleted).toBe(true);
  });
  test('an already deleted audio is a no-op that still succeeds (idempotent)', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', audio_path: null, audio_deleted_at: new Date().toISOString() };
    expect((await purgeAudio({ db: makeDb(), soniox: soniox(), meetingId: MID, projectId: 'pA' })).audioDeleted).toBe(true);
    expect(h.removed).toHaveLength(0);
  });
});

describe('limits from the environment', () => {
  test('defaults: 120 min per user, 600 min global per day, 7-day retention', () => {
    expect(sttLimitsFromEnv({})).toEqual({ userDailyMs: 7_200_000, globalDailyMs: 36_000_000, retentionDays: 7, signedUrlTtlSec: 7200 });
  });
  test('overrides are honoured inside their bounds; garbage falls back', () => {
    expect(sttLimitsFromEnv({ STT_DAILY_AUDIO_MIN_PER_USER: '30', STT_RETENTION_DAYS: '3' })).toMatchObject({ userDailyMs: 1_800_000, retentionDays: 3 });
    expect(sttLimitsFromEnv({ STT_RETENTION_DAYS: '99', STT_DAILY_AUDIO_MIN_PER_USER: 'x' })).toMatchObject({ retentionDays: 7, userDailyMs: 7_200_000 });
  });
});
