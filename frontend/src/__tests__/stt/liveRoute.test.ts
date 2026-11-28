import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { startFakeSoniox, type FakeSoniox } from '../../../e2e/support/fake-soniox.mjs';

/** /api/intelligence/meetings/live: every gate fails BEFORE the provider is contacted; the long-lived key never leaves the server. */
const h = vi.hoisted(() => ({ created: 0, rpc: [] as { name: string; args: Record<string, unknown> }[], reserve: 'started' as string }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    h.created += 1;
    return {
      auth: { getUser: async (t: string) => ({ data: { user: { id: t.startsWith('p') ? 'pilot-user' : 'other-user' } }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        h.rpc.push({ name, args });
        if (name === 'stt_live_reserve') return { data: [{ outcome: h.reserve, segment: 1, offset_ms: 0, reserved_ms: 600000 }], error: null };
        if (name === 'stt_live_append') return { data: 'ok', error: null };
        if (name === 'stt_live_close') return { data: 4000, error: null };
        return { data: null, error: null };
      },
    };
  },
}));
import { POST } from '../../app/api/intelligence/meetings/live/route';

let fake: FakeSoniox;
const MID = '33333333-3333-4333-8333-333333333333';
const LONG_KEY = 'sk-soniox-LONG-LIVED-0123456789';
const post = (body: unknown, token = 'p'.repeat(40)) =>
  POST(new NextRequest('http://localhost/api/intelligence/meetings/live', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));

describe('live route gates', () => {
  const env = { ...process.env };
  beforeAll(async () => { fake = await startFakeSoniox({ expectKey: LONG_KEY }); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => {
    h.created = 0; h.rpc.length = 0; h.reserve = 'started'; fake.state.tempKeys.clear();
    process.env = {
      ...env, NODE_ENV: 'test', NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      STT_ENABLED: '1', MEETING_LIVE_ENABLED: '1', MEETING_PILOT_USER_IDS: 'pilot-user', SONIOX_API_KEY: LONG_KEY,
      SONIOX_BASE_URL: fake.url, STT_SERVER_SECRET: 'x'.repeat(40), AI_ALLOW_ALL_AUTHENTICATED: '1',
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { process.env = { ...env }; vi.restoreAllMocks(); });

  test('kill switch: MEETING_LIVE_ENABLED off -> 503 before authentication', async () => {
    process.env.MEETING_LIVE_ENABLED = '0';
    const r = await post({ action: 'start', projectId: 'pA', meetingId: MID });
    expect(r.status).toBe(503);
    expect(h.created).toBe(0);
  });
  test('STT_ENABLED off also closes it', async () => {
    delete process.env.STT_ENABLED;
    expect((await post({ action: 'start', projectId: 'pA', meetingId: MID })).status).toBe(503);
  });
  test('a non-pilot account (e.g. a public visitor who registered) gets 403 and nothing reaches the DB or the provider', async () => {
    const r = await post({ action: 'start', projectId: 'pA', meetingId: MID }, 'o'.repeat(40));
    expect(r.status).toBe(403);
    expect(h.rpc).toEqual([]);
    expect(fake.state.tempKeys.size).toBe(0);
  });
  test('bad action / bad meeting id -> 400', async () => {
    expect((await post({ action: 'rm', projectId: 'pA', meetingId: MID })).status).toBe(400);
    expect((await post({ action: 'start', projectId: 'pA', meetingId: 'x' })).status).toBe(400);
  });
  test('start: booking first, then a single-use temporary key; the long-lived key is never in the response', async () => {
    const r = await post({ action: 'start', projectId: 'pA', meetingId: MID });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(h.rpc[0].name).toBe('stt_live_reserve');
    expect(text).not.toContain(LONG_KEY);
    const j = JSON.parse(text);
    expect(j.apiKey).toMatch(/^snx_temp_/);
    expect(fake.state.tempKeys.get(j.apiKey)).toMatchObject({ maxSessionSec: 600, ref: `${MID}:live:1` });
    expect(j.wsUrl).toBe('wss://stt-rt.soniox.com/transcribe-websocket'); // no override set
  });
  test('refused booking -> no key minted', async () => {
    h.reserve = 'budget_exceeded';
    const r = await post({ action: 'start', projectId: 'pA', meetingId: MID });
    expect(r.status).toBe(429);
    expect(fake.state.tempKeys.size).toBe(0);
  });
  test('provider refuses to mint (402) -> booking released, generic message without provider text', async () => {
    await fake.control({ mode: 'ok' });
    fake.state.rtMode = 'mint_402';
    const r = await post({ action: 'start', projectId: 'pA', meetingId: MID });
    const text = await r.text();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain('provider message');
    expect(h.rpc.map((c) => c.name)).toEqual(['stt_live_reserve', 'stt_live_release']);
    fake.state.rtMode = 'ok';
  });
  test('append sanitises tokens; close accepts only known reasons', async () => {
    expect((await post({ action: 'append', projectId: 'pA', meetingId: MID, segment: 1, seq: 1, tokens: [{ text: 'A', start_ms: 0, end_ms: 1, x: 1 }] })).status).toBe(200);
    expect(h.rpc[0].args.p_tokens).toEqual([{ text: 'A', start_ms: 0, end_ms: 1 }]);
    expect((await post({ action: 'close', projectId: 'pA', meetingId: MID, segment: 1, reason: 'whatever' })).status).toBe(400);
    expect((await post({ action: 'close', projectId: 'pA', meetingId: MID, segment: 1, reason: 'paused', audioMs: 4000 })).status).toBe(200);
  });
  test('closing and completing still work with the kill switch off (stopping must never be blocked)', async () => {
    process.env.MEETING_LIVE_ENABLED = '0';
    expect((await post({ action: 'close', projectId: 'pA', meetingId: MID, segment: 1, reason: 'stopped', audioMs: 1 })).status).toBe(200);
  });
});
