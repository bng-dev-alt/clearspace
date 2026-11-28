import { describe, expect, test } from 'vitest';
import { aiStatusFor } from '../../lib/ai/status';

describe('RUN 11 D3: AI status comes from the enforced policy', () => {
  const base = { GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.6-flash' };
  test('demo tier: the production pilot numbers (40 000 tokens/day, 2/min, 30 min/day STT)', () => {
    const s = aiStatusFor('demo', { ...base, AI_DEMO_DAILY_TOKEN_BUDGET: '40000', AI_DEMO_RATE_PER_USER_PER_MINUTE: '2', AI_DEMO_STT_DAILY_AUDIO_MIN_PER_USER: '30' });
    expect(s).toEqual({ available: true, tier: 'demo', model: 'gemini-3.6-flash', dailyTokens: 40000, perMinute: 2, sttMinutesPerDay: 30 });
  });
  test('demo tier without STT minutes: transcription not allowed (0), not "unlimited"', () => {
    expect(aiStatusFor('demo', base).sttMinutesPerDay).toBe(0);
  });
  test('owner tier: no app daily limits (null), per-minute limit stays', () => {
    const s = aiStatusFor('owner', base);
    expect(s.dailyTokens).toBeNull();
    expect(s.sttMinutesPerDay).toBeNull();
    expect(s.perMinute).toBe(10);
  });
  test('no access: nothing pretended', () => {
    expect(aiStatusFor(null, base)).toEqual({ available: false, tier: null, model: null, dailyTokens: null, perMinute: null, sttMinutesPerDay: 0 });
  });
  test('no Gemini key on the server: model unknown, not a guessed default', () => {
    expect(aiStatusFor('dev', {}).model).toBeNull();
  });
});
