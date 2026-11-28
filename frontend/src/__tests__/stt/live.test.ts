import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleLiveTokens, inLivePilot, liveComplete, liveConfigFromEnv, liveStart, sanitizeTokens, streamConfig, type LiveCtx } from '../../lib/stt/live';
import { SonioxError, type SonioxClient } from '../../lib/stt/soniox';

function fakeDb(results: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    db: { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); const r = results[name]; return r instanceof Error ? { data: null, error: r } : { data: r ?? null, error: null }; } },
  };
}
const ctx = (db: unknown, soniox: unknown, over: Partial<LiveCtx> = {}): LiveCtx => ({
  db: db as LiveCtx['db'], soniox: soniox as SonioxClient, secret: 's'.repeat(40), meetingId: '11111111-1111-1111-1111-111111111111',
  userDailyMs: 1_200_000, globalDailyMs: 1_200_000, cfg: liveConfigFromEnv({ MEETING_LIVE_ENABLED: '1', MEETING_PILOT_USER_IDS: 'u1' }), ...over,
});

describe('live config + pilot', () => {
  it('is off by default and fails closed without an allowlist', () => {
    const c = liveConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(inLivePilot(c, 'anyone')).toBe(false);
  });
  it('production ignores the dev "allow all" switch', () => {
    expect(inLivePilot(liveConfigFromEnv({ NODE_ENV: 'production', AI_ALLOW_ALL_AUTHENTICATED: '1' }), 'x')).toBe(false);
    expect(inLivePilot(liveConfigFromEnv({ NODE_ENV: 'development', AI_ALLOW_ALL_AUTHENTICATED: '1' }), 'x')).toBe(true);
  });
  it('segment length is bounded (1..120 min, default 30)', () => {
    expect(liveConfigFromEnv({ MEETING_LIVE_SEGMENT_MIN: '999' }).segmentMs).toBe(30 * 60_000);
    expect(liveConfigFromEnv({ MEETING_LIVE_SEGMENT_MIN: '10' }).segmentMs).toBe(600_000);
  });
  it('the stream config sends no names, no titles, no project data to the provider', () => {
    const s = JSON.stringify(streamConfig('stt-rt-v6'));
    expect(s).toContain('"language_hints":["cs","en"]');
    expect(s).toContain('enable_speaker_diarization');
    expect(streamConfig('m').context).toEqual({ general: [{ key: 'domain', value: 'Project meeting' }] });
    expect(s).not.toMatch(/api_key/);
  });
});

describe('liveStart', () => {
  it('never asks the provider for a key when the booking is refused', async () => {
    const f = fakeDb({ stt_live_reserve: [{ outcome: 'budget_exceeded' }] });
    const soniox = { createTemporaryKey: vi.fn() };
    await expect(liveStart(ctx(f.db, soniox))).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(soniox.createTemporaryKey).not.toHaveBeenCalled();
  });
  it.each([['no_consent', 'consent_required'], ['not_organizer', 'forbidden'], ['already_live', 'conflict'], ['finalized', 'conflict']])(
    'outcome %s -> %s', async (outcome, code) => {
      const f = fakeDb({ stt_live_reserve: [{ outcome }] });
      await expect(liveStart(ctx(f.db, { createTemporaryKey: vi.fn() }))).rejects.toMatchObject({ code });
    });
  it('mints a single-use key capped to the reservation and returns the stream config', async () => {
    const f = fakeDb({ stt_live_reserve: [{ outcome: 'started', segment: 2, offset_ms: 61000, reserved_ms: 600000 }] });
    const soniox = { createTemporaryKey: vi.fn(async () => ({ apiKey: 'snx_temp_abcdefghijkl', expiresAt: 'x' })) };
    const r = await liveStart(ctx(f.db, soniox));
    expect(soniox.createTemporaryKey).toHaveBeenCalledWith({ maxSessionSec: 600, clientReferenceId: '11111111-1111-1111-1111-111111111111:live:2' });
    expect(r).toMatchObject({ segment: 2, offsetMs: 61000, reservedMs: 600000, apiKey: 'snx_temp_abcdefghijkl', wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket' });
    expect(f.calls[0].args.p_reserve_ms).toBe(30 * 60_000);
  });
  it('a failed key mint releases the booking (nothing billable exists)', async () => {
    const f = fakeDb({ stt_live_reserve: [{ outcome: 'started', segment: 1, offset_ms: 0, reserved_ms: 600000 }] });
    const soniox = { createTemporaryKey: vi.fn(async () => { throw new SonioxError('budget', 402, 'organization_balance_exhausted'); }) };
    await expect(liveStart(ctx(f.db, soniox))).rejects.toBeTruthy();
    expect(f.calls.map((c) => c.name)).toEqual(['stt_live_reserve', 'stt_live_release']);
  });
});

describe('token hygiene + assembly', () => {
  it('keeps only known fields of plausible tokens', () => {
    const t = sanitizeTokens([{ text: 'Ahoj', start_ms: 1, end_ms: 2, speaker: '1', language: 'cs', confidence: 0.9, evil: '<script>' },
      { text: 'x'.repeat(500), start_ms: 0, end_ms: 1 }, { text: 'bez času' }, { text: ' svět', start_ms: 3, end_ms: 1, speaker: 'admin' }]);
    expect(t).toEqual([{ text: 'Ahoj', start_ms: 1, end_ms: 2, speaker: '1', language: 'cs' }, { text: ' svět', start_ms: 3, end_ms: 3 }]);
  });
  it('rejects empty / oversized batches', () => {
    expect(() => sanitizeTokens([])).toThrow();
    expect(() => sanitizeTokens(new Array(2001).fill({ text: 'a', start_ms: 0, end_ms: 1 }))).toThrow();
    expect(() => sanitizeTokens('x')).toThrow();
  });
  it('orders segments, shifts by offset and never merges speakers across streams', () => {
    const out = assembleLiveTokens([
      { segment: 2, seq: 1, offset_ms: 10_000, tokens: [{ text: ' B', start_ms: 0, end_ms: 100, speaker: '1' }] },
      { segment: 1, seq: 2, offset_ms: 0, tokens: [{ text: ' A2', start_ms: 500, end_ms: 600, speaker: '1' }] },
      { segment: 1, seq: 1, offset_ms: 0, tokens: [{ text: 'A1', start_ms: 0, end_ms: 400, speaker: '1' }] },
    ]);
    expect(out.map((t) => [t.text, t.start_ms, t.speaker])).toEqual([['A1', 0, '1'], [' A2', 500, '1'], [' B', 10_000, '2.1']]);
  });
});

describe('liveComplete', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('normalises the stored chunks into one revision', async () => {
    const f = fakeDb({
      stt_live_chunks: [{ segment: 1, seq: 1, offset_ms: 0, tokens: [{ text: 'Rozhodli', start_ms: 0, end_ms: 500, speaker: '1' }, { text: ' jsme.', start_ms: 500, end_ms: 900, speaker: '1' }] }],
      stt_live_complete: 'f'.repeat(64),
    });
    const r = await liveComplete(ctx(f.db, null));
    expect(r).toEqual({ outcome: 'completed', revision: 'f'.repeat(64) });
    const tr = f.calls[1].args.p_transcript as { segments: { text: string }[]; revision: string };
    expect(tr.segments[0].text).toBe('Rozhodli jsme.');
    expect(tr.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(f.calls[1].args.p_model).toBe('stt-rt-v6');
  });
  it('nothing said -> chunks discarded, no empty revision', async () => {
    const f = fakeDb({ stt_live_chunks: [] });
    expect(await liveComplete(ctx(f.db, null))).toEqual({ outcome: 'empty', revision: null });
    expect(f.calls.map((c) => c.name)).toEqual(['stt_live_chunks', 'stt_live_discard']);
  });
});

describe('long meeting assembly (60 min of stored chunks)', () => {
  it('1200 chunks over 7 segments normalise into one transcript within limits, in time order', async () => {
    const rows: { segment: number; seq: number; offset_ms: number; tokens: unknown }[] = [];
    let t = 0;
    for (let seg = 1; seg <= 7; seg += 1) {
      const offset = (seg - 1) * 570_000;
      for (let seq = 1; seq <= 172; seq += 1) {
        const local = (seq - 1) * 3000;
        rows.push({ segment: seg, seq, offset_ms: offset, tokens: [{ text: ` slovo${t}.`, start_ms: local, end_ms: local + 800, speaker: '1' }, { text: ' Odpověď.', start_ms: local + 1500, end_ms: local + 2200, speaker: '2' }] });
        t += 1;
      }
    }
    const toks = assembleLiveTokens(rows);
    expect(toks).toHaveLength(rows.length * 2);
    for (let i = 1; i < toks.length; i += 1) expect(toks[i].start_ms).toBeGreaterThanOrEqual(toks[i - 1].start_ms);
    const f = fakeDb({ stt_live_chunks: rows, stt_live_complete: 'e'.repeat(64) });
    const started = Date.now();
    const r = await liveComplete(ctx(f.db, null));
    expect(r.outcome).toBe('completed');
    expect(Date.now() - started).toBeLessThan(5000);
    const tr = f.calls[1].args.p_transcript as { segments: unknown[]; char_count: number };
    expect(tr.char_count).toBeLessThan(400_000);
    expect(tr.segments.length).toBeGreaterThan(100);
  });
});
