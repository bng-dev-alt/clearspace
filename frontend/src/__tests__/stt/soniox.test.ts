import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { classifyHttp, DEFAULT_SONIOX_MODEL, parseTranscription, SonioxClient, SonioxError, sonioxConfigFromEnv } from '../../lib/stt/soniox';
import { startFakeSoniox, type FakeSoniox } from '../../../e2e/support/fake-soniox.mjs';

let fake: FakeSoniox;
const stats = async () => (await (await fetch(`${fake.origin}/__stats`)).json()) as { calls: { method: string; path: string; auth: string }[]; jobs: { id: string; deleted: boolean; body: Record<string, unknown> }[]; files: string[] };
const client = (over: Partial<ConstructorParameters<typeof SonioxClient>[0]> = {}) =>
  new SonioxClient({ apiKey: fake.key, baseUrl: fake.url, model: 'stt-async-v6', timeoutMs: 3000, retryDelayMs: 0, ...over });
const createInput = { audioUrl: 'http://127.0.0.1:1/signed?token=abc', clientReferenceId: 'meeting-1' };

beforeAll(async () => { fake = await startFakeSoniox(); });
afterAll(async () => { await fake.close(); });
beforeEach(async () => { await fake.control({ reset: true, mode: 'ok', pollsUntilDone: 1, fetchAudio: false, durationMs: 12_000 }); });

describe('config from the environment', () => {
  test('a missing key is a config error, never a request', () => {
    expect(() => sonioxConfigFromEnv({})).toThrowError(SonioxError);
    try { sonioxConfigFromEnv({ SONIOX_API_KEY: '  ' }); } catch (e) { expect((e as SonioxError).kind).toBe('config'); }
  });
  test('defaults: US host, current async model (v6, never the deprecated v5)', () => {
    const c = sonioxConfigFromEnv({ SONIOX_API_KEY: 'k' });
    expect(c.baseUrl).toBe('https://api.soniox.com/v1');
    expect(c.model).toBe('stt-async-v6');
    expect(DEFAULT_SONIOX_MODEL).not.toBe('stt-async-v5');
  });
  test('regions pick the regional host (data residency)', () => {
    expect(sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_REGION: 'eu' }).baseUrl).toBe('https://api.eu.soniox.com/v1');
    expect(sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_REGION: 'jp' }).baseUrl).toBe('https://api.jp.soniox.com/v1');
    expect(sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_REGION: 'zz' }).baseUrl).toBe('https://api.soniox.com/v1');
  });
  test('the test seam SONIOX_BASE_URL works outside production and is IGNORED in production (the key can never be sent elsewhere)', () => {
    const dev = sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_BASE_URL: 'http://127.0.0.1:9/v1/', NODE_ENV: 'test' });
    expect(dev.baseUrl).toBe('http://127.0.0.1:9/v1');
    const prod = sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_BASE_URL: 'http://evil.example/v1', NODE_ENV: 'production' });
    expect(prod.baseUrl).toBe('https://api.soniox.com/v1');
  });
  test('an invalid model or timeout falls back to safe values', () => {
    const c = sonioxConfigFromEnv({ SONIOX_API_KEY: 'k', SONIOX_MODEL: 'bad model!', SONIOX_TIMEOUT_MS: '1' });
    expect(c.model).toBe('stt-async-v6');
    expect(c.timeoutMs).toBe(20_000);
  });
});

describe('createTranscription', () => {
  test('sends exactly the documented fields: model, audio_url (never file_id), hints, diarization, language id, context, reference', async () => {
    const t = await client().createTranscription({ ...createInput, languageHints: ['cs', 'en'], context: { general: [{ key: 'domain', value: 'Project meeting' }], terms: ['Honza Novák', 'ClearSpace'] } });
    expect(t).toMatchObject({ status: 'queued', model: 'stt-async-v6' });
    const body = (await stats()).jobs[0].body;
    expect(body).toMatchObject({ model: 'stt-async-v6', audio_url: createInput.audioUrl, language_hints: ['cs', 'en'], enable_speaker_diarization: true, enable_language_identification: true, client_reference_id: 'meeting-1' });
    expect(body.file_id).toBeUndefined();
    expect(body.context).toEqual({ general: [{ key: 'domain', value: 'Project meeting' }], terms: ['Honza Novák', 'ClearSpace'] });
  });
  test('context is capped (8 pairs, 100 terms, clipped strings) and omitted when empty', async () => {
    await client().createTranscription({ ...createInput, context: { general: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`.repeat(30), value: 'v'.repeat(500) })), terms: Array.from({ length: 300 }, (_, i) => 'x'.repeat(200) + i) } });
    const ctx = (await stats()).jobs[0].body.context as { general: { key: string; value: string }[]; terms: string[] };
    expect(ctx.general).toHaveLength(8);
    expect(ctx.general[0].key.length).toBeLessThanOrEqual(60);
    expect(ctx.general[0].value.length).toBeLessThanOrEqual(120);
    expect(ctx.terms).toHaveLength(100);
    expect(ctx.terms[0].length).toBeLessThanOrEqual(60);
    await fake.control({ reset: true });
    await client().createTranscription({ ...createInput, context: { general: [], terms: [] } });
    expect((await stats()).jobs[0].body.context).toBeUndefined();
  });
  test('Authorization is a Bearer header and the key never appears in the URL', async () => {
    await client().createTranscription(createInput);
    const s = await stats();
    expect(s.calls[0]).toMatchObject({ method: 'POST', path: '/v1/transcriptions', auth: 'present' });
    const wrong = client({ apiKey: 'wrong-key' });
    await expect(wrong.createTranscription(createInput)).rejects.toMatchObject({ kind: 'terminal', status: 401, errorType: 'unauthenticated' });
  });
  test.each([
    ['create_400', 'terminal', 400, 'invalid_request'],
    ['create_402', 'budget', 402, 'organization_balance_exhausted'],
    ['create_429', 'retryable', 429, 'limit_exceeded'],
    ['create_500', 'retryable', 500, 'internal_error'],
    ['create_503', 'retryable', 503, 'service_unavailable'],
  ])('%s is classified as %s and the paid POST is NOT retried automatically', async (mode, kind, status, errorType) => {
    await fake.control({ mode });
    await expect(client({ retryDelayMs: 0 }).createTranscription(createInput)).rejects.toMatchObject({ kind, status, errorType });
    expect((await stats()).calls.filter((c) => c.method === 'POST' && c.path === '/v1/transcriptions')).toHaveLength(1);
  });
  test('the provider message text never reaches the error (only its type)', async () => {
    await fake.control({ mode: 'create_400' });
    try { await client().createTranscription(createInput); } catch (e) {
      expect(String((e as Error).message)).not.toMatch(/provider message/);
      expect(JSON.stringify(e)).not.toMatch(/provider message/);
    }
  });
});

describe('polling and results', () => {
  test('status moves queued -> processing -> completed with the audio duration', async () => {
    const c = client();
    const { id } = await c.createTranscription(createInput);
    expect((await c.getTranscription(id)).status).toBe('queued');
    const done = await c.getTranscription(id);
    expect(done).toMatchObject({ status: 'completed', audioDurationMs: 12_000 });
    const tr = await c.getTranscript(id);
    expect(tr.tokens.length).toBeGreaterThan(10);
  });
  test('the transcript of a job that is not finished is a "wait" (409), not an empty result', async () => {
    await fake.control({ pollsUntilDone: 5 });
    const c = client();
    const { id } = await c.createTranscription(createInput);
    await expect(c.getTranscript(id)).rejects.toMatchObject({ kind: 'wait', status: 409 });
  });
  test('a failed job carries only the error TYPE', async () => {
    await fake.control({ mode: 'job_error' });
    const c = client();
    const { id } = await c.createTranscription(createInput);
    const t = await c.getTranscription(id);
    expect(t).toMatchObject({ status: 'error', errorType: 'invalid_audio_file' });
    expect(JSON.stringify(t)).not.toMatch(/unsupported provider text/);
  });
  test('the documentation names the failure state both "error" and "failed": anything unknown is a failure, never "still running"', async () => {
    await fake.control({ mode: 'job_failed_status' });
    const c = client();
    const { id } = await c.createTranscription(createInput);
    expect(await c.getTranscription(id)).toMatchObject({ status: 'error', errorType: 'unknown_status' });
    expect(parseTranscription({ id: 'x', status: 'weird' })).toMatchObject({ status: 'error' });
  });
  test('reads are retried ONCE after a transient error (idempotent), then give up', async () => {
    const c = client();
    const { id } = await c.createTranscription(createInput);
    await fake.control({ mode: 'status_429_once' });
    expect((await c.getTranscription(id)).status).toBe('queued'); // first call 429, second ok
    expect((await stats()).calls.filter((x) => x.method === 'GET').length).toBe(2);
    await fake.control({ reset: true, mode: 'status_500' });
    const { id: id2 } = await c.createTranscription(createInput);
    await expect(c.getTranscription(id2)).rejects.toMatchObject({ kind: 'retryable', status: 500 });
    expect((await stats()).calls.filter((x) => x.method === 'GET').length).toBe(2);
  });
  test('an unknown transcription is "not_found"', async () => {
    await expect(client().getTranscription('nope')).rejects.toMatchObject({ kind: 'not_found', status: 404 });
  });
  test('a malformed response is a terminal "bad_response"', () => {
    expect(() => parseTranscription(null)).toThrowError(SonioxError);
    expect(() => parseTranscription({ status: 'queued' })).toThrowError(SonioxError);
  });
});

describe('deletion', () => {
  test('delete after completion succeeds; deleting again (404) counts as success (idempotent cleanup)', async () => {
    const c = client();
    const { id } = await c.createTranscription(createInput);
    await c.getTranscription(id);
    await c.getTranscription(id);
    await c.deleteTranscription(id);
    await c.deleteTranscription(id);
    expect((await stats()).jobs[0].deleted).toBe(true);
  });
  test('deleting a job that still runs is a "wait" (409): the caller must try later, nothing is lost', async () => {
    await fake.control({ pollsUntilDone: 9 });
    const c = client();
    const { id } = await c.createTranscription(createInput);
    await expect(c.deleteTranscription(id)).rejects.toMatchObject({ kind: 'wait', status: 409 });
  });
  test('a failing delete surfaces as retryable and is retried once', async () => {
    const c = client();
    const { id } = await c.createTranscription(createInput);
    await c.getTranscription(id);
    await c.getTranscription(id);
    await fake.control({ mode: 'delete_500' });
    await expect(c.deleteTranscription(id)).rejects.toMatchObject({ kind: 'retryable' });
    expect((await stats()).calls.filter((x) => x.method === 'DELETE')).toHaveLength(2);
  });
  test('file fallback: upload then delete the file', async () => {
    const c = client();
    const { id } = await c.uploadFile(Uint8Array.from([1, 2, 3]), 'a.mp3', 'audio/mpeg', 'meeting-1');
    expect((await stats()).files).toEqual([id]);
    await c.deleteFile(id);
    await c.deleteFile(id);
    expect((await stats()).files).toEqual([]);
  });
});

describe('network failures', () => {
  test('an unreachable host is a "network" error without the URL or any detail', async () => {
    const dead = client({ baseUrl: 'http://127.0.0.1:1/v1', retryDelayMs: 0 });
    const e = (await dead.createTranscription(createInput).catch((x) => x)) as SonioxError;
    expect(e).toBeInstanceOf(SonioxError);
    expect(e.kind).toBe('network');
    expect(e.message).not.toMatch(/127\.0\.0\.1/);
  });
  test('a timeout aborts the request', async () => {
    const slow = new SonioxClient({ apiKey: 'k', baseUrl: 'http://x/v1', model: 'm', timeoutMs: 20, retryDelayMs: 0, fetchImpl: (_u, init) => new Promise((_r, rej) => { (init?.signal as AbortSignal).addEventListener('abort', () => rej(new Error('aborted'))); }) });
    await expect(slow.createTranscription(createInput)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('classifyHttp', () => {
  test.each([[400, 'terminal'], [401, 'terminal'], [403, 'terminal'], [402, 'budget'], [404, 'not_found'], [408, 'retryable'], [409, 'wait'], [429, 'retryable'], [500, 'retryable'], [502, 'retryable'], [503, 'retryable']])('%i -> %s', (s, k) => {
    expect(classifyHttp(s, 'x').kind).toBe(k);
  });
  test('a hostile error type is never trusted as a slug', () => {
    expect(classifyHttp(400, 'Bad Type; DROP').errorType).toBe('unknown');
    expect(classifyHttp(500, 'ok_type').errorType).toBe('ok_type');
  });
});
