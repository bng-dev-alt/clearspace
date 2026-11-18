import { describe, test, expect, vi } from 'vitest';
import { AI_ERROR_MESSAGES, isRetryableAiError, parseAiHttpError } from '../lib/ai/clientErrors';
import { AiGatewayError } from '../lib/ai/errors';

describe('parseAiHttpError (one mapping for every AI client)', () => {
  test('a 403 WITHOUT our code comes from the production firewall: AI is disabled, not "forbidden"', () => {
    expect(parseAiHttpError(403, null)).toEqual({ code: 'ai_disabled', message: AI_ERROR_MESSAGES.ai_disabled });
    expect(parseAiHttpError(403, '<html>blocked</html>')).toMatchObject({ code: 'ai_disabled' });
    expect(parseAiHttpError(403, { error: 'x' })).toMatchObject({ code: 'ai_disabled' });
  });
  test('a 403 from the gateway (has a code) is a real permission error', () => {
    expect(parseAiHttpError(403, { code: 'forbidden', error: 'K tomuto projektu nemáte přístup.' })).toEqual({ code: 'forbidden', message: 'K tomuto projektu nemáte přístup.' });
  });
  test('the server message wins; a known code without a message falls back to the shared text', () => {
    expect(parseAiHttpError(429, { code: 'rate_limited', error: 'Vlastní text' }).message).toBe('Vlastní text');
    expect(parseAiHttpError(429, { code: 'rate_limited' }).message).toBe(AI_ERROR_MESSAGES.rate_limited);
  });
  test('unreadable bodies and unknown codes degrade to a safe generic message, never raw text', () => {
    expect(parseAiHttpError(500, null)).toEqual({ code: 'unknown', message: AI_ERROR_MESSAGES.unknown });
    expect(parseAiHttpError(500, null, 'Vlastní fallback').message).toBe('Vlastní fallback');
    expect(parseAiHttpError(502, { code: 'weird' }).code).toBe('weird');
    expect(parseAiHttpError(502, 42 as never).code).toBe('unknown');
  });
  test('every gateway error code has a user message (the two lists cannot drift apart)', () => {
    const codes = ['bad_request', 'not_found', 'conflict', 'unauthenticated', 'forbidden', 'payload_too_large', 'unsupported_media_type', 'rate_limited', 'budget_exceeded', 'ai_unavailable', 'ai_demo_disabled', 'ai_timeout', 'ai_overloaded', 'ai_failed', 'bad_model_output'] as const;
    for (const c of codes) {
      expect(AI_ERROR_MESSAGES[c], c).toBeTruthy();
      expect(new AiGatewayError(c, 'x').status).toBeGreaterThanOrEqual(400); // the code exists on the server side too
    }
  });
  test('retryable classification', () => {
    expect(isRetryableAiError('ai_timeout')).toBe(true);
    expect(isRetryableAiError('rate_limited')).toBe(true);
    expect(isRetryableAiError('forbidden')).toBe(false);
    expect(isRetryableAiError('budget_exceeded')).toBe(false);
    expect(isRetryableAiError('bad_model_output')).toBe(false); // never an automatic paid retry
  });
});

// --- the three clients behave the same -------------------------------------------------------------------------
const h = vi.hoisted(() => ({ insertError: null as null | { code: string; message: string }, fetchRes: null as null | { status: number; body: unknown } }));
vi.mock('../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 't'.repeat(30) } } }) },
    from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: h.insertError }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

import { meetingService, MeetingServiceError } from '../services/meetingService';
import { intelligenceService, IntelligenceServiceError } from '../services/intelligenceService';

function stubFetch() {
  vi.stubGlobal('fetch', async () => ({ ok: false, status: h.fetchRes!.status, json: async () => h.fetchRes!.body }));
}

describe('clients map the same server answers to the same codes', () => {
  test.each([
    [403, null, 'ai_disabled'],
    [429, { code: 'rate_limited', error: 'x' }, 'rate_limited'],
    [429, { code: 'budget_exceeded', error: 'y' }, 'budget_exceeded'],
    [502, { code: 'bad_model_output', error: 'z' }, 'bad_model_output'],
    [403, { code: 'forbidden', error: 'f' }, 'forbidden'],
  ])('HTTP %i %j -> %s in both services', async (status, body, code) => {
    h.fetchRes = { status, body };
    stubFetch();
    await expect(meetingService.analyze('p', 'm')).rejects.toMatchObject({ code });
    await expect(intelligenceService.generateBrief('p')).rejects.toMatchObject({ code });
  });
  test('a network failure is "network" in both services', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    await expect(meetingService.analyze('p', 'm')).rejects.toBeInstanceOf(MeetingServiceError);
    await expect(intelligenceService.generateBrief('p')).rejects.toBeInstanceOf(IntelligenceServiceError);
    await expect(meetingService.analyze('p', 'm')).rejects.toMatchObject({ code: 'network' });
    await expect(intelligenceService.generateBrief('p')).rejects.toMatchObject({ code: 'network' });
  });
  test('the meeting quota (SQLSTATE PT429) is a readable "quota" error carrying the database message', async () => {
    h.insertError = { code: 'PT429', message: 'Projekt dosáhl maximálního počtu porad.' };
    await expect(meetingService.createWithTranscript({ projectId: 'p', title: 'X', text: 'Petr: ahoj světe', source: 'paste' } as never)).rejects.toMatchObject({ code: 'quota', message: 'Projekt dosáhl maximálního počtu porad.' });
  });
});
