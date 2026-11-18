import { describe, test, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { startFakeSoniox, type FakeSoniox } from '../../../e2e/support/fake-soniox.mjs';

/** STT routes: feature flag, authentication, RLS-only visibility, secret hygiene. Supabase is a mock, Soniox is the local fake server. */
const h = vi.hoisted(() => ({
  created: 0,
  visible: true,
  meeting: null as Record<string, unknown> | null,
  rpc: [] as { name: string; args: Record<string, unknown> }[],
  signedUrl: '',
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    h.created += 1;
    const builder = (table: string) => {
      const res = () => (table === 'meetings' ? { data: h.visible ? h.meeting : null, error: null } : table === 'projects' ? { data: { name: 'P' }, error: null } : { data: [], error: null });
      const b: Record<string, unknown> = {};
      b.select = () => b; b.eq = () => b; b.maybeSingle = () => Promise.resolve(res());
      b.then = (r: (v: unknown) => unknown) => Promise.resolve(res()).then(r);
      return b;
    };
    return {
      auth: { getUser: async (t: string) => (t.startsWith('bad') ? { data: { user: null }, error: { message: 'x' } } : { data: { user: { id: 'u1' } }, error: null }) },
      from: builder,
      rpc: async (name: string, args: Record<string, unknown>) => {
        h.rpc.push({ name, args });
        if (name === 'stt_reserve') return { data: [{ outcome: 'started', request_id: 'r', attempt: 1, audio_path: 'pA/m/x.mp3', audio_mime: 'audio/mpeg', project_id: 'pA' }], error: null };
        return { data: null, error: null };
      },
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: h.signedUrl }, error: null }), remove: async () => ({ data: [], error: null }) }) },
    };
  },
}));

import { POST as transcribe } from '../../app/api/ai/meetings/transcribe/route';
import { POST as sync } from '../../app/api/ai/meetings/sync/route';
import { POST as purge } from '../../app/api/ai/meetings/purge/route';

let fake: FakeSoniox;
const MID = '22222222-2222-4222-8222-222222222222';
const GOOD = 'g'.repeat(40);
const SECRET = 'sk-soniox-SECRET-123456';
const post = (route: (r: NextRequest) => Promise<Response>, body: unknown, opts: { token?: string | null; ct?: string } = {}) =>
  route(new NextRequest('http://localhost/api/ai/meetings/x', { method: 'POST', headers: { 'content-type': opts.ct ?? 'application/json', ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? GOOD}` }) }, body: JSON.stringify(body) }));
const meeting = () => ({ id: MID, project_id: 'pA', title: 'P', source_kind: 'audio', language_hint: null, audio_path: 'pA/m/x.mp3', audio_bytes: 1000, audio_client_ms: 5000, audio_deleted_at: null, audio_delete_after: null, stt_state: 'none', stt_job_id: null, stt_cleanup_pending: false, stt_submitted_at: null, stt_attempts: 0, stt_error_type: null, speaker_names: {} });

describe('STT routes', () => {
  const env = { ...process.env };
  const logs: unknown[][] = [];
  beforeAll(async () => { fake = await startFakeSoniox({ expectKey: SECRET }); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => {
    h.created = 0; h.visible = true; h.meeting = meeting(); h.rpc.length = 0; h.signedUrl = `${fake.origin}/__audio/ok.mp3?t=1`;
    logs.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a); });
    process.env = { ...env, STT_ENABLED: '1', SONIOX_API_KEY: SECRET, SONIOX_BASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' };
    delete process.env.NEXT_PUBLIC_FORCE_DEMO;
  });
  afterEach(() => { process.env = env; vi.restoreAllMocks(); });

  test('feature flag: without STT_ENABLED=1 every route answers 503 stt_disabled BEFORE auth or any database access', async () => {
    delete process.env.STT_ENABLED;
    for (const route of [transcribe, sync, purge]) {
      const r = await post(route, { projectId: 'pA', meetingId: MID });
      expect(r.status).toBe(503);
      expect((await r.json()).code).toBe('stt_disabled');
    }
    expect(h.created).toBe(0);
  });

  test('authentication: no token / invalid token -> 401 and nothing is touched', async () => {
    expect((await post(transcribe, { projectId: 'pA', meetingId: MID }, { token: null })).status).toBe(401);
    expect((await post(transcribe, { projectId: 'pA', meetingId: MID }, { token: 'bad' + 'x'.repeat(40) })).status).toBe(401);
    expect(h.rpc).toHaveLength(0);
  });

  test.each([
    ['no project id', { meetingId: MID }],
    ['no meeting id', { projectId: 'pA' }],
    ['meeting id is not a uuid', { projectId: 'pA', meetingId: '1; drop table meetings' }],
  ])('validation: %s -> 400', async (_n, body) => {
    expect((await post(transcribe, body)).status).toBe(400);
    expect(h.rpc).toHaveLength(0);
  });
  test('a non-JSON content type is refused', async () => {
    expect((await post(transcribe, { projectId: 'pA', meetingId: MID }, { ct: 'text/plain' })).status).toBe(415);
  });

  test('a meeting the caller cannot see (RLS) and a non-existing one give the SAME 404', async () => {
    h.visible = false;
    const a = await post(transcribe, { projectId: 'pA', meetingId: MID });
    h.meeting = null; h.visible = true;
    const b = await post(transcribe, { projectId: 'pA', meetingId: MID });
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    expect(h.rpc).toHaveLength(0);
  });
  test('a meeting of ANOTHER project is not reachable through this project id', async () => {
    h.meeting = { ...meeting(), project_id: 'pOther' };
    expect((await post(sync, { projectId: 'pA', meetingId: MID })).status).toBe(404);
    expect((await post(purge, { projectId: 'pA', meetingId: MID })).status).toBe(404);
  });

  test('transcribe: success starts ONE provider job and answers without any provider detail', async () => {
    const r = await post(transcribe, { projectId: 'pA', meetingId: MID });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ started: true, state: 'transcribing', attempt: 1 });
    expect(h.rpc.map((x) => x.name)).toEqual(['stt_reserve', 'stt_attach_job']);
  });

  test('a missing provider key is "unavailable" for the user and never a crash or a leak', async () => {
    delete process.env.SONIOX_API_KEY;
    const r = await post(transcribe, { projectId: 'pA', meetingId: MID });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe('stt_unavailable');
  });

  test('SECRET HYGIENE: the provider key appears in no response body or header, no log line, on any path', async () => {
    const seen: string[] = [];
    const take = async (r: Response) => { seen.push(await r.text(), JSON.stringify([...r.headers.entries()])); };
    await take(await post(transcribe, { projectId: 'pA', meetingId: MID }));
    await fake.control({ mode: 'create_402', reset: true });
    await take(await post(transcribe, { projectId: 'pA', meetingId: MID }));
    await fake.control({ mode: 'create_500' });
    await take(await post(transcribe, { projectId: 'pA', meetingId: MID }));
    h.meeting = { ...meeting(), stt_state: 'transcribing', stt_job_id: 'tr-9', stt_submitted_at: new Date().toISOString() };
    await take(await post(sync, { projectId: 'pA', meetingId: MID }));
    await take(await post(purge, { projectId: 'pA', meetingId: MID }));
    delete process.env.SONIOX_API_KEY;
    await take(await post(transcribe, { projectId: 'pA', meetingId: MID }));
    expect(seen.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(seen.join('\n')).not.toMatch(/provider message that must never reach the app/);
    expect(JSON.stringify(logs)).not.toMatch(/provider message that must never reach the app/);
  });

  test('sync reports the state; cancel=true is passed through; purge defaults to deleting provider data too', async () => {
    h.meeting = { ...meeting(), stt_state: 'transcribing', stt_job_id: 'tr-9', stt_submitted_at: new Date().toISOString() };
    await post(sync, { projectId: 'pA', meetingId: MID, cancel: true });
    expect(h.rpc.find((x) => x.name === 'stt_fail')?.args.p_error_type).toBe('cancelled');
    h.meeting = { ...meeting(), stt_state: 'completed', stt_job_id: 'tr-1', stt_cleanup_pending: true };
    const r = await post(purge, { projectId: 'pA', meetingId: MID });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ audioDeleted: true });
  });
});
