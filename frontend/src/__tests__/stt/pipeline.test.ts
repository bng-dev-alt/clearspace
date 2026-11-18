import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { startFakeSoniox, type FakeSoniox } from '../../../e2e/support/fake-soniox.mjs';
import { SonioxClient } from '../../lib/stt/soniox';
import { purgeAudio, startTranscription, sweepProject, syncTranscription, sttLimitsFromEnv, sttServerSecret, type SttLimits } from '../../lib/stt/pipeline';
import { AiGatewayError } from '../../lib/ai/errors';

/**
 * Přepis zvuku: celý tok proti LOKÁLNÍMU falešnému Soniox (skutečné HTTP) a skriptovanou databází (RPC se jen zaznamenávají;
 * skutečná RPC ověřují DB testy 82/83 a E2E na lokálním Supabase). Žádný klíč, žádné kredity.
 */
interface Job { id: string; provider_job_id: string | null; cleanup_state: 'pending' | 'done' | 'abandoned'; cleanup_attempts: number }
interface H {
  meeting: Record<string, unknown> | null;
  jobs: Job[];
  attemptJob: { client_reference: string } | null;
  sweepMeetings: { id: string }[];
  orphans: { path: string }[];
  orphanDeletes: string[];
  listed: string[];
  rpc: { name: string; args: Record<string, unknown> }[];
  rpcImpl: Record<string, (a: Record<string, unknown>) => { data: unknown; error: null | { code: string } }>;
  order: string[];
  signedUrl: string;
  signError: null | { message: string };
  removed: string[];
  removeError: null | { message: string };
}
let fake: FakeSoniox;
let h: H;
const MID = '11111111-1111-4111-8111-111111111111';
const REF = `${MID}:1`;
const SECRET = 'synthetic-test-server-secret-0123456789';

const baseMeeting = () => ({
  id: MID, project_id: 'pA', title: 'Porada Petr Novák', source_kind: 'audio', language_hint: null, audio_path: `pA/${MID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp3`,
  audio_bytes: 1_000_000, audio_client_ms: 600_000, audio_deleted_at: null, audio_delete_after: null, stt_state: 'none', stt_job_id: null,
  stt_cleanup_pending: false, stt_submitted_at: null, stt_attempts: 0, stt_error_type: null, speaker_names: { S1: 'Petr Novák' },
});

function makeDb(): SupabaseClient {
  const builder = (table: string) => {
    let head = false;
    let single = false;
    let deleting = false;
    const result = (): Record<string, unknown> => {
      if (table === 'meetings') return { data: single ? h.meeting : h.sweepMeetings, error: null };
      if (table === 'stt_jobs') {
        const pending = h.jobs.filter((j) => j.cleanup_state === 'pending');
        if (head) return { count: pending.length, data: null, error: null };
        if (single) return { data: h.attemptJob, error: null };
        return { data: pending, error: null };
      }
      if (table === 'meeting_audio_orphans') return { data: h.orphans, error: null };
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    b.select = (_c?: string, o?: { head?: boolean }) => { head = !!o?.head; return b; };
    b.delete = () => { deleting = true; return b; };
    b.eq = (col: string, v: string) => { if (deleting && col === 'path') h.orphanDeletes.push(v); return b; };
    b.lte = () => b;
    b.not = () => b;
    b.limit = () => b;
    b.maybeSingle = () => { single = true; return Promise.resolve(result()); };
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
        remove: async (paths: string[]) => { h.order.push('remove'); if (!h.removeError) h.removed.push(...paths); return { data: [], error: h.removeError }; },
        list: async () => ({ data: h.listed.map((name) => ({ name })), error: null }),
      }),
    },
  } as unknown as SupabaseClient;
}

const limits: SttLimits = { userDailyMs: 7_200_000, globalDailyMs: 36_000_000, retentionDays: 7, signedUrlTtlSec: 7200 };
const soniox = (over: Partial<ConstructorParameters<typeof SonioxClient>[0]> = {}) => new SonioxClient({ apiKey: fake.key, baseUrl: fake.url, model: 'stt-async-v6', timeoutMs: 3000, retryDelayMs: 0, ...over });
const calls = async () => ((await (await fetch(`${fake.origin}/__stats`)).json()) as { calls: { method: string; path: string }[]; jobs: { id: string; deleted: boolean; body: Record<string, unknown> }[] });
const sonioxCalls = async () => (await calls()).calls.filter((c) => c.path.startsWith('/v1/'));
const posts = async () => (await sonioxCalls()).filter((c) => c.method === 'POST');
const rpcNamed = (n: string) => h.rpc.filter((r) => r.name === n);
const ctx = (over: Record<string, unknown> = {}) => ({ db: makeDb(), soniox: soniox(), secret: SECRET, meetingId: MID, projectId: 'pA', limits, ...over });
const start = (over: Record<string, unknown> = {}) => startTranscription(ctx(over));
const sync = (over: Record<string, unknown> = {}) => syncTranscription(ctx(over));
const purge = (over: Record<string, unknown> = {}) => purgeAudio(ctx(over));

/** Minimální obraz toho, co dělají RPC v databázi (skutečná RPC testují DB testy): po dokončení/selhání čeká úklid u poskytovatele. */
const queueJob = (providerId: string | null) => { if (providerId) h.jobs.push({ id: `j${h.jobs.length + 1}`, provider_job_id: providerId, cleanup_state: 'pending', cleanup_attempts: 0 }); };
const dbEffects = () => {
  const m = () => h.meeting as Record<string, unknown>;
  h.rpcImpl.stt_attach_job = (a) => {
    Object.assign(m(), { stt_state: 'transcribing', stt_job_id: a.p_job_id, stt_attempts: 1, stt_submitted_at: new Date().toISOString() });
    return { data: 'attached', error: null };
  };
  h.rpcImpl.stt_mark_unknown = () => { Object.assign(m(), { stt_state: 'unknown' }); return { data: null, error: null }; };
  h.rpcImpl.stt_resolve_unknown = () => { Object.assign(m(), { stt_state: 'failed' }); return { data: null, error: null }; };
  h.rpcImpl.stt_complete = (a) => { Object.assign(m(), { stt_state: 'completed', stt_cleanup_pending: true }); queueJob(String(a.p_job_id)); return { data: 'a'.repeat(64), error: null }; };
  h.rpcImpl.stt_fail = (a) => { Object.assign(m(), { stt_state: 'failed', stt_cleanup_pending: !!a.p_job_id || !!m().stt_job_id }); queueJob((a.p_job_id as string | null) ?? null); return { data: null, error: null }; };
  h.rpcImpl.stt_cleanup_result = (a) => {
    const j = h.jobs.find((x) => x.id === a.p_job);
    if (j && a.p_result === 'done') j.cleanup_state = 'done';
    if (j && a.p_result === 'abandon') j.cleanup_state = 'abandoned';
    if (j && a.p_result === 'retry') j.cleanup_attempts += 1;
    if (!h.jobs.some((x) => x.cleanup_state === 'pending')) Object.assign(m(), { stt_cleanup_pending: false });
    return { data: null, error: null };
  };
};
const reserveOutcome = (outcome: string) => {
  h.rpcImpl.stt_reserve = () => ({ data: [{ outcome, request_id: 'req-1', attempt: 1, audio_path: String(h.meeting?.audio_path), audio_mime: 'audio/mpeg', project_id: 'pA', client_reference: REF }], error: null });
};

beforeAll(async () => { fake = await startFakeSoniox(); });
afterAll(async () => { await fake.close(); });
beforeEach(async () => {
  await fake.control({ reset: true, mode: 'ok', pollsUntilDone: 1, durationMs: 12_000, fetchAudio: false });
  h = { meeting: baseMeeting(), jobs: [], attemptJob: { client_reference: REF }, sweepMeetings: [], orphans: [], orphanDeletes: [], listed: [], rpc: [], rpcImpl: {}, order: [], signedUrl: `${fake.origin}/__audio/ok.mp3?token=signed`, signError: null, removed: [], removeError: null };
  reserveOutcome('started');
  dbEffects();
});

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(AiGatewayError);
  expect((e as AiGatewayError).code).toBe(code);
  return e as AiGatewayError;
};

describe('server secret (fail closed)', () => {
  test('missing or short STT_SERVER_SECRET disables the pipeline; a long one is returned', () => {
    for (const env of [{}, { STT_SERVER_SECRET: '' }, { STT_SERVER_SECRET: 'short' }, { STT_SERVER_SECRET: ' '.repeat(40) }]) {
      expect(() => sttServerSecret(env)).toThrowError(AiGatewayError);
    }
    expect(sttServerSecret({ STT_SERVER_SECRET: SECRET })).toBe(SECRET);
  });
  test('EVERY trusted RPC call carries the secret (a member JWT alone is never enough)', async () => {
    await start();
    await sync(); // queued
    await sync(); // completed + cleanup
    const trustedCalls = h.rpc.filter((r) => r.name.startsWith('stt_'));
    expect(trustedCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of trustedCalls) expect(c.args.p_server_secret, c.name).toBe(SECRET);
  });
});

describe('startTranscription: the happy path', () => {
  test('reserve -> signed URL -> content check -> ONE Soniox request -> attach job; in that order', async () => {
    h.meeting = { ...baseMeeting(), stt_attempts: 0 };
    const r = await start();
    expect(r).toEqual({ started: true, state: 'transcribing', attempt: 1 });
    expect(h.order).toEqual(['stt_reserve', 'signedUrl', 'stt_attach_job']);
    const c = await calls();
    expect(c.calls.filter((x) => x.method === 'POST' && x.path === '/v1/transcriptions')).toHaveLength(1);
    expect(c.jobs[0].body).toMatchObject({ audio_url: h.signedUrl, language_hints: ['cs', 'en'], enable_speaker_diarization: true, model: 'stt-async-v6', client_reference_id: REF });
    expect(rpcNamed('stt_attach_job')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: 'tr-1', p_model: 'stt-async-v6' });
  });
  test('PRIVACY: no member, speaker, meeting or project name reaches the provider (only a generic domain)', async () => {
    await start();
    const body = (await calls()).jobs[0].body;
    expect(body.context).toEqual({ general: [{ key: 'domain', value: 'Project meeting' }] });
    expect(JSON.stringify(body)).not.toMatch(/Petr|Novák|Honza|Jana|Porada|Projekt/);
  });
  test('English meetings hint English first', async () => {
    (h.meeting as Record<string, unknown>).language_hint = 'en';
    await start();
    expect((await calls()).jobs[0].body.language_hints).toEqual(['en', 'cs']);
  });
  test('the reservation estimate cannot be undercut by a lying client duration; the limits come from the SERVER', async () => {
    Object.assign(h.meeting as object, { audio_bytes: 50_000_000, audio_client_ms: 1000 });
    await start();
    expect(rpcNamed('stt_reserve')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_est_audio_ms: Math.floor((50_000_000 * 8) / 320), p_user_daily_ms: 7_200_000, p_global_daily_ms: 36_000_000 });
  });
  test('the signed URL is requested with a 2-hour validity (provider queue time is unbounded)', () => {
    expect(sttLimitsFromEnv({}).signedUrlTtlSec).toBe(7200);
  });
});

describe('startTranscription: idempotency and refusals never reach the provider', () => {
  test.each([
    ['in_progress', { started: false, state: 'transcribing' }],
    ['already_done', { started: false, state: 'completed' }],
    ['unknown_outcome', { started: false, state: 'unknown' }],
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
    h.rpcImpl.stt_reserve = () => ({ data: [{ outcome: n++ === 0 ? 'started' : 'in_progress', request_id: 'r', attempt: 1, audio_path: String(h.meeting?.audio_path), audio_mime: 'audio/mpeg', project_id: 'pA', client_reference: REF }], error: null });
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

describe('startTranscription: failures BEFORE the paid request are closed as not billed', () => {
  test('content that is not audio is rejected BEFORE the provider (no cost) and closed as invalid_audio / not billed', async () => {
    h.signedUrl = `${fake.origin}/__audio/bad.mp3?token=x`;
    await rejects(start(), 'stt_invalid_audio');
    expect(await sonioxCalls()).toHaveLength(0);
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: null, p_error_type: 'invalid_audio', p_billing: 'none', p_audio_ms: null });
  });
  test('a storage error closes the job as storage_unavailable / not billed', async () => {
    h.signError = { message: 'boom' };
    await rejects(start(), 'stt_unavailable');
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'storage_unavailable', p_billing: 'none' });
    expect(await sonioxCalls()).toHaveLength(0);
  });
  test('an unreachable audio URL closes the job as storage_unavailable / not billed', async () => {
    h.signedUrl = 'http://127.0.0.1:1/x';
    await rejects(start(), 'stt_unavailable');
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'storage_unavailable', p_billing: 'none' });
  });
  test.each([
    ['create_400', 'stt_failed', 'invalid_request'],
    ['create_402', 'stt_unavailable', 'organization_balance_exhausted'],
    ['create_429', 'stt_unavailable', 'limit_exceeded'],
  ])('provider %s: REJECTED before processing -> %s, closed as %s and NOT billed; the POST is not repeated', async (mode, code, type) => {
    await fake.control({ mode });
    const e = await rejects(start(), code);
    expect(e.message).not.toMatch(/balance|zůstatek|provider message|402/i); // billing state and provider text are never exposed
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: null, p_error_type: type, p_billing: 'none', p_audio_ms: null });
    expect(await posts()).toHaveLength(1);
    expect(rpcNamed('stt_attach_job')).toHaveLength(0);
    expect(rpcNamed('stt_mark_unknown')).toHaveLength(0);
  });
});

describe('startTranscription: an UNCERTAIN paid POST is never repeated and never released from the budget', () => {
  test.each([
    ['create_500', 'internal_error'],
    ['create_503', 'service_unavailable'],
    ['create_500_created', 'internal_error'],
    ['create_lost_response', 'network_error'],
  ])('provider %s -> state unknown (%s); exactly one POST, no stt_fail (the estimate stays booked)', async (mode, type) => {
    await fake.control({ mode });
    const r = await start();
    expect(r).toEqual({ started: true, state: 'unknown', attempt: 1 });
    expect(rpcNamed('stt_mark_unknown')).toHaveLength(1);
    expect(rpcNamed('stt_mark_unknown')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_error_type: type });
    expect(rpcNamed('stt_fail')).toHaveLength(0);
    expect(await posts()).toHaveLength(1);
  });
  test('a timeout is uncertain as well (the job may exist at the provider)', async () => {
    await fake.control({ mode: 'create_hang' });
    const r = await start({ soniox: soniox({ timeoutMs: 300 }) });
    expect(r.state).toBe('unknown');
    expect(rpcNamed('stt_mark_unknown')).toHaveLength(1);
    expect(rpcNamed('stt_fail')).toHaveLength(0);
    expect(await posts()).toHaveLength(1);
  });
  test('an unreachable provider is uncertain (network_error), not a clean failure', async () => {
    const dead = soniox({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 500 });
    const r = await start({ soniox: dead });
    expect(r.state).toBe('unknown');
    expect(rpcNamed('stt_mark_unknown')[0].args).toMatchObject({ p_error_type: 'network_error' });
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });
  test('if the job id cannot be recorded (twice), the meeting goes to unknown WITH the job alive at the provider: reconciliation will find it', async () => {
    h.rpcImpl.stt_attach_job = () => ({ data: null, error: { code: 'XX000' } });
    const r = await start();
    expect(r).toEqual({ started: true, state: 'unknown', attempt: 1 });
    expect(rpcNamed('stt_attach_job')).toHaveLength(2); // one retry of the LOCAL write; never a second provider POST
    expect(rpcNamed('stt_mark_unknown')[0].args).toMatchObject({ p_error_type: 'attach_failed' });
    expect(await posts()).toHaveLength(1);
    expect((await calls()).jobs).toHaveLength(1);
  });
  test('the user cancelled while the POST was in flight: the job id is stored for deletion and removed at the provider', async () => {
    h.rpcImpl.stt_attach_job = () => { queueJob('tr-1'); return { data: 'orphaned', error: null }; };
    await fake.control({ pollsUntilDone: -1 }); // a job that is not running can be deleted at once
    const r = await start();
    expect(r).toEqual({ started: false, state: 'failed', attempt: 1 });
    expect(rpcNamed('stt_cleanup_result')[0].args).toMatchObject({ p_result: 'done' });
    expect((await calls()).jobs[0].deleted).toBe(true);
  });
});

describe('syncTranscription', () => {
  const running = (extra: Record<string, unknown> = {}) => { h.meeting = { ...baseMeeting(), stt_state: 'transcribing', stt_job_id: 'tr-1', stt_attempts: 1, stt_submitted_at: new Date().toISOString(), ...extra }; };
  const create = async () => { running(); await soniox().createTranscription({ audioUrl: 'http://x/a.mp3', clientReferenceId: REF }); };

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
    const a = done[0].args as { p_server_secret: string; p_meeting: string; p_job_id: string; p_model: string; p_audio_ms: number; p_retention_days: number; p_transcript: { revision: string; segments: unknown[]; speakers: unknown[]; char_count: number } };
    expect(a).toMatchObject({ p_server_secret: SECRET, p_meeting: MID, p_job_id: 'tr-1', p_model: 'stt-async-v6', p_audio_ms: 12_000, p_retention_days: 7 });
    expect(a.p_transcript.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(a.p_transcript.segments).toHaveLength(3);
    expect(a.p_transcript.speakers).toHaveLength(2);
    expect(a.p_transcript.char_count).toBeGreaterThan(50);
    expect((await calls()).jobs[0].deleted).toBe(true);
    expect(rpcNamed('stt_cleanup_result').map((c) => c.args.p_result)).toEqual(['done']);
    expect(h.order.indexOf('stt_complete')).toBeLessThan(h.order.indexOf('stt_cleanup_result'));
  });

  test('a failed provider delete does NOT lose the transcript; cleanup stays pending (retryable) and is retried on the next sync', async () => {
    await create();
    await sync();
    await fake.control({ mode: 'delete_500' });
    const r = await sync();
    expect(rpcNamed('stt_complete')).toHaveLength(1);
    expect(rpcNamed('stt_cleanup_result').map((c) => c.args.p_result)).toEqual(['retry']);
    expect(rpcNamed('stt_cleanup_result')[0].args.p_error_type).toBe('internal_error');
    expect(r.cleanupPending).toBe(true);
    await fake.control({ mode: 'ok' });
    const again = await sync();
    expect(rpcNamed('stt_cleanup_result').map((c) => c.args.p_result)).toEqual(['retry', 'done']);
    expect(again.cleanupPending).toBe(false);
    expect(rpcNamed('stt_complete')).toHaveLength(1); // not stored twice
  });

  test('a settled meeting without pending work costs zero provider calls', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: false };
    const r = await sync();
    expect(r.state).toBe('completed');
    expect(await sonioxCalls()).toHaveLength(0);
  });

  test('a provider-side rejected file closes the job as NOT billed with the error TYPE (never the message) and cleans up', async () => {
    await fake.control({ mode: 'job_error' });
    await create();
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: 'tr-1', p_error_type: 'invalid_audio_file', p_billing: 'none', p_audio_ms: null });
    expect(JSON.stringify(h.rpc)).not.toMatch(/unsupported provider text/);
    expect(rpcNamed('stt_complete')).toHaveLength(0);
    expect(rpcNamed('stt_cleanup_result').map((c) => c.args.p_result)).toEqual(['done']);
  });

  test('any OTHER provider failure keeps the estimate booked (the provider may have processed the audio)', async () => {
    await fake.control({ mode: 'job_failed_status' });
    await create();
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_error_type: 'unknown_status', p_billing: 'estimated' });
  });

  test('a transcript without speech is booked at the REAL duration (the provider processed and bills it); no empty transcript is stored', async () => {
    await fake.control({ mode: 'empty' });
    await create();
    await sync();
    await sync();
    expect(rpcNamed('stt_complete')).toHaveLength(0);
    const f = rpcNamed('stt_fail')[0].args;
    expect(f).toMatchObject({ p_error_type: 'empty_transcript', p_billing: 'actual' });
    expect(typeof f.p_audio_ms).toBe('number');
  });

  test('a transient provider error does not fail the job: the page just asks again', async () => {
    await create();
    await fake.control({ mode: 'status_500' });
    const r = await sync();
    expect(r).toMatchObject({ transient: true, state: 'transcribing' });
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });

  test('the provider has forgotten the job (404): closed as transcription_not_found, not billed again', async () => {
    running({ stt_job_id: 'tr-unknown' });
    await sync();
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_job_id: 'tr-unknown', p_error_type: 'transcription_not_found', p_billing: 'none' });
  });

  test('a rejected key (401) is reported as unavailable and the job stays recoverable (not failed)', async () => {
    await create();
    const bad = soniox({ apiKey: 'wrong', model: 'm', timeoutMs: 2000 });
    await rejects(sync({ soniox: bad }), 'stt_unavailable');
    expect(rpcNamed('stt_fail')).toHaveLength(0);
  });

  test('stuck jobs are flagged so the UI can offer "check again / cancel"', async () => {
    await create();
    await fake.control({ pollsUntilDone: 99 });
    running({ stt_submitted_at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect((await sync()).stuck).toBe(true);
    h.meeting = { ...baseMeeting(), stt_state: 'submitting', stt_submitted_at: new Date(Date.now() - 11 * 60_000).toISOString() };
    expect((await sync()).stuck).toBe(true);
    h.meeting = { ...baseMeeting(), stt_state: 'submitting', stt_submitted_at: new Date().toISOString() };
    expect((await sync()).stuck).toBe(false);
  });

  test('stt_complete errors: a forbidden answer is surfaced, anything else is transient (nothing deleted at the provider until stored)', async () => {
    await create();
    await sync();
    h.rpcImpl.stt_complete = () => ({ data: null, error: { code: 'XX000' } });
    expect(await sync()).toMatchObject({ transient: true });
    expect((await calls()).jobs[0].deleted).toBe(false);
    h.rpcImpl.stt_complete = () => ({ data: null, error: { code: '42501' } });
    await rejects(sync(), 'forbidden');
  });

  test('sync on a foreign meeting is "not found"', async () => {
    h.meeting = null;
    await rejects(sync(), 'not_found');
  });

  test('retention: audio past its deadline is deleted from Storage and then marked deleted; before the deadline nothing happens', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', audio_delete_after: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await sync()).audioPurged).toBe(false);
    expect(h.removed).toHaveLength(0);
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', audio_delete_after: new Date(Date.now() - 1000).toISOString() };
    expect((await sync()).audioPurged).toBe(true);
    expect(h.removed).toEqual([String((h.meeting as Record<string, unknown>).audio_path)]);
    expect(h.order.indexOf('remove')).toBeLessThan(h.order.indexOf('mark_audio_deleted'));
  });

  test('retention also applies to FAILED and CANCELLED meetings (not only completed ones)', async () => {
    for (const state of ['failed', 'none']) {
      h.removed = [];
      h.meeting = { ...baseMeeting(), stt_state: state, audio_delete_after: new Date(Date.now() - 1000).toISOString() };
      expect((await sync()).audioPurged, state).toBe(true);
      expect(h.removed).toHaveLength(1);
    }
  });
});

describe('syncTranscription: cancel keeps the cost and the provider job id', () => {
  const running = (state: string, extra: Record<string, unknown> = {}) => { h.meeting = { ...baseMeeting(), stt_state: state, stt_job_id: state === 'transcribing' ? 'tr-1' : null, stt_attempts: 1, stt_submitted_at: new Date().toISOString(), ...extra }; };

  test('cancelling a RUNNING job books the estimate (the provider may still bill it) and queues the id; a still-running job cannot be deleted yet -> retry', async () => {
    await fake.control({ pollsUntilDone: 3 });
    running('transcribing');
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3', clientReferenceId: REF });
    const r = await sync({ cancel: true });
    expect(rpcNamed('stt_fail')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: 'tr-1', p_error_type: 'cancelled', p_billing: 'estimated', p_audio_ms: null });
    expect(rpcNamed('stt_cleanup_result')[0].args).toMatchObject({ p_result: 'retry', p_error_type: 'still_running' });
    expect((await calls()).jobs[0].deleted).toBe(false);
    expect(r.cleanupPending).toBe(true); // truthful: the provider copy still exists and a deletion is pending
  });
  test('cancelling while SUBMITTING books the estimate as uncertain (the POST may be in flight)', async () => {
    running('submitting');
    await sync({ cancel: true });
    expect(rpcNamed('stt_fail')[0].args).toMatchObject({ p_job_id: null, p_error_type: 'cancelled', p_billing: 'uncertain' });
  });
  test('"cancel" on an UNKNOWN outcome is an explicit abandon (estimate kept), never a silent retry', async () => {
    running('unknown');
    await sync({ cancel: true });
    expect(rpcNamed('stt_resolve_unknown')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_resolution: 'abandon' });
    expect(await posts()).toHaveLength(0);
  });
});

describe('syncTranscription: reconciling an UNKNOWN outcome (the paid POST is never re-sent)', () => {
  const unknown = (ageMin: number) => { h.meeting = { ...baseMeeting(), stt_state: 'unknown', stt_attempts: 1, stt_submitted_at: new Date(Date.now() - ageMin * 60_000).toISOString() }; };

  test('the job exists at the provider: it is ADOPTED by its client reference (no second POST, no second billing)', async () => {
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3', clientReferenceId: REF }); // the "lost" first POST
    unknown(1);
    const r = await sync();
    expect(r.providerStatus).toBe('adopted');
    expect(rpcNamed('stt_attach_job')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_job_id: 'tr-1', p_model: 'stt-async-v6' });
    expect(await posts()).toHaveLength(1);
    expect(r.state).toBe('transcribing');
  });
  test('not found yet and still young: stays unknown, nothing is resolved', async () => {
    unknown(2);
    const r = await sync();
    expect(r.state).toBe('unknown');
    expect(rpcNamed('stt_resolve_unknown')).toHaveLength(0);
    expect(await posts()).toHaveLength(0);
  });
  test('not found after 10 minutes and the listing was COMPLETE: resolved as absent (released from the budget by the database)', async () => {
    unknown(11);
    await sync();
    expect(rpcNamed('stt_resolve_unknown')[0].args).toEqual({ p_server_secret: SECRET, p_meeting: MID, p_resolution: 'absent' });
    expect(await posts()).toHaveLength(0);
  });
  test('an INCOMPLETE listing (more pages than we read) never proves absence: it stays unknown for the user to abandon', async () => {
    unknown(11);
    const endless = soniox();
    endless.listTranscriptions = async () => ({ items: [], nextCursor: 'more' });
    const r = await sync({ soniox: endless });
    expect(r.state).toBe('unknown');
    expect(rpcNamed('stt_resolve_unknown')).toHaveLength(0);
  });
  test('the listing fails transiently: stays unknown and reports transient', async () => {
    unknown(11);
    await fake.control({ mode: 'list_500' });
    const r = await sync();
    expect(r).toMatchObject({ state: 'unknown', transient: true });
    expect(rpcNamed('stt_resolve_unknown')).toHaveLength(0);
  });
  test('without the attempt row the reference is unknown: transient, nothing is guessed', async () => {
    unknown(11);
    h.attemptJob = null;
    expect(await sync()).toMatchObject({ state: 'unknown', transient: true });
    expect(rpcNamed('stt_resolve_unknown')).toHaveLength(0);
  });
});

describe('purgeAudio', () => {
  test('deletes the Storage object first and marks the row afterwards', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1' };
    const r = await purge();
    expect(r.audioDeleted).toBe(true);
    expect(h.order).toEqual(['remove', 'mark_audio_deleted']);
  });
  test('also removes files that were uploaded but never attached (same meeting folder)', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed' };
    h.listed = ['stray-1.mp3'];
    await purge();
    expect(h.removed).toContain(`pA/${MID}/stray-1.mp3`);
    expect(h.removed).toContain(String((h.meeting as Record<string, unknown>).audio_path));
  });
  test.each(['submitting', 'unknown', 'transcribing'])('refuses while the state is %s', async (state) => {
    h.meeting = { ...baseMeeting(), stt_state: state, stt_job_id: 'tr-1' };
    await rejects(purge(), 'conflict');
    expect(h.removed).toHaveLength(0);
  });
  test('a Storage failure or a database refusal is reported and never claims the audio is gone', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed' };
    h.removeError = { message: 'x' };
    await rejects(purge(), 'stt_failed');
    expect(rpcNamed('mark_audio_deleted')).toHaveLength(0);
    h.removeError = null;
    h.rpcImpl.mark_audio_deleted = () => ({ data: null, error: { code: '55000' } });
    await rejects(purge(), 'stt_failed');
  });
  test('with includeProvider the provider data is deleted too (used before a meeting is removed)', async () => {
    await fake.control({ pollsUntilDone: 0 });
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' });
    await soniox().getTranscription('tr-1');
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    queueJob('tr-1');
    const r = await purge({ includeProvider: true });
    expect(r.cleanupPending).toBe(false);
    expect((await calls()).jobs[0].deleted).toBe(true);
  });
  test('Storage and provider deletions are INDEPENDENT: a provider failure does not block the audio, and a Storage failure does not block the provider', async () => {
    await fake.control({ pollsUntilDone: 0 });
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' });
    await soniox().getTranscription('tr-1');
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    queueJob('tr-1');
    await fake.control({ mode: 'delete_500' });
    const r = await purge({ includeProvider: true });
    expect(r).toEqual({ audioDeleted: true, cleanupPending: true }); // the audio IS gone; the provider copy is honestly reported as pending
    expect(h.removed).toHaveLength(1);
    // reverse: Storage fails, the provider deletion still runs
    await fake.control({ mode: 'ok' });
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    h.removeError = { message: 'x' };
    await rejects(purge({ includeProvider: true }), 'stt_failed');
    expect((await calls()).jobs[0].deleted).toBe(true);
  });
  test('an already deleted audio is a no-op that still succeeds (idempotent)', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', audio_path: null, audio_deleted_at: new Date().toISOString() };
    expect((await purge()).audioDeleted).toBe(true);
    expect(h.removed).toHaveLength(0);
  });
});

describe('sweepProject (no cron: runs when a member opens the project)', () => {
  const sweep = () => sweepProject({ db: makeDb(), soniox: soniox(), secret: SECRET, projectId: 'pA', limits });
  test('deletes due audio, orphaned objects and pending provider data; reports the counts', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed', stt_job_id: 'tr-1' };
    h.sweepMeetings = [{ id: MID }];
    h.orphans = [{ path: 'pA/gone/x.mp3' }];
    await fake.control({ pollsUntilDone: 0 });
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' });
    await soniox().getTranscription('tr-1');
    queueJob('tr-1');
    const r = await sweep();
    expect(r).toEqual({ audioPurged: 1, orphansRemoved: 1, providerCleanupPending: 0 });
    expect(h.orphanDeletes).toEqual(['pA/gone/x.mp3']);
    expect((await calls()).jobs[0].deleted).toBe(true);
  });
  test('an orphan whose Storage delete fails stays queued (retried later); one failing meeting does not stop the others', async () => {
    h.meeting = { ...baseMeeting(), stt_state: 'completed' };
    h.sweepMeetings = [{ id: MID }];
    h.orphans = [{ path: 'pA/gone/x.mp3' }];
    h.removeError = { message: 'x' };
    const r = await sweep();
    expect(r).toMatchObject({ audioPurged: 0, orphansRemoved: 0 });
    expect(h.orphanDeletes).toHaveLength(0);
  });
  test('provider data that cannot be deleted yet is reported as pending, not hidden', async () => {
    await fake.control({ pollsUntilDone: 0 });
    await soniox().createTranscription({ audioUrl: 'http://x/a.mp3' });
    await soniox().getTranscription('tr-1');
    queueJob('tr-1');
    await fake.control({ mode: 'delete_500' });
    expect((await sweep()).providerCleanupPending).toBe(1);
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
