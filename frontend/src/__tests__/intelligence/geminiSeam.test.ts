import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/** GEMINI_BASE_URL is a TEST seam (fake Gemini for local E2E). In production it must be ignored: the key never goes to another host. */
const ctor = vi.hoisted(() => vi.fn());
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ text: '{}', usageMetadata: {} }) };
    constructor(opts: unknown) { ctor(opts); }
  },
}));

async function call(nodeEnv: string, baseUrl?: string) {
  vi.resetModules();
  ctor.mockClear();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('GEMINI_API_KEY', 'k');
  if (baseUrl) vi.stubEnv('GEMINI_BASE_URL', baseUrl);
  else vi.stubEnv('GEMINI_BASE_URL', '');
  const { geminiProvider } = await import('../../services/ai/geminiProvider');
  await geminiProvider.generateCompletion([{ role: 'user', content: 'x' }], { model: 'm' });
  return ctor.mock.calls[0][0] as { apiKey: string; httpOptions?: { baseUrl?: string } };
}

describe('GEMINI_BASE_URL test seam', () => {
  beforeEach(() => vi.unstubAllEnvs());
  afterEach(() => vi.unstubAllEnvs());
  test('development/test: the fake server URL is honoured', async () => {
    expect((await call('development', 'http://127.0.0.1:55590')).httpOptions).toEqual({ baseUrl: 'http://127.0.0.1:55590' });
  });
  test('production: IGNORED, the client talks to Google only', async () => {
    const o = await call('production', 'http://evil.example');
    expect(o.httpOptions).toBeUndefined();
    expect(o.apiKey).toBe('k');
  });
  test('unset or blank: default endpoint', async () => {
    expect((await call('development')).httpOptions).toBeUndefined();
    expect((await call('development', '   ')).httpOptions).toBeUndefined();
  });
});
