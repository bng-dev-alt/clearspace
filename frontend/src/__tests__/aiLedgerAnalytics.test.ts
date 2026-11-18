import { describe, test, expect, beforeEach, vi } from 'vitest';

/** R6 observability: AI usage statistics come from the server ledger (ai_requests), not from localStorage, and no prompt content is stored in the browser. */
const h = vi.hoisted(() => ({ rows: [] as unknown[], error: null as null | { code: string }, query: {} as Record<string, unknown> }));

vi.mock('../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    from: (table: string) => {
      h.query = { table };
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => { h.query.cols = cols; return b; };
      b.gte = (c: string, v: string) => { h.query.gte = [c, v]; return b; };
      b.order = () => b;
      b.limit = (n: number) => { h.query.limit = n; return Promise.resolve({ data: h.error ? null : h.rows, error: h.error }); };
      return b;
    },
  },
}));

import { aiAnalyticsService } from '../services/ai/aiAnalyticsService';

const store: Record<string, string> = {};
beforeEach(() => {
  h.error = null;
  for (const k of Object.keys(store)) delete store[k];
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), localStorage: globalThis.localStorage });
});

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const row = (over: Record<string, unknown>) => ({ id: 'x', created_at: iso(1000), feature: 'chat', status: 'succeeded', model: 'gemini-3.5-flash', prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, error_code: null, duration_ms: 800, ...over });

describe('AI usage from the server ledger', () => {
  test('reads only the 30-day window, only the ledger columns, newest first in the query', async () => {
    h.rows = [];
    await aiAnalyticsService.syncLedger();
    expect(h.query).toMatchObject({ table: 'ai_requests', limit: 500 });
    expect(String(h.query.cols)).not.toMatch(/prompt\b|content|payload/i); // no content columns exist or are requested
    const since = Date.parse((h.query.gte as string[])[1]);
    expect(now - since).toBeGreaterThan(29 * 86_400_000);
    expect(now - since).toBeLessThan(31 * 86_400_000);
  });

  test('maps rows to the dashboard shape; unfinished reservations are not requests; oldest first', async () => {
    h.rows = [
      row({ id: 'new', created_at: iso(1000), feature: 'project-brief' }),
      row({ id: 'res', created_at: iso(2000), status: 'reserved', total_tokens: null }),
      row({ id: 'bad', created_at: iso(3000), status: 'failed', error_code: 'ai_timeout', total_tokens: null, prompt_tokens: null, completion_tokens: null }),
      row({ id: 'old', created_at: iso(4000) }),
    ];
    expect(await aiAnalyticsService.syncLedger()).toBe(true);
    const logs = aiAnalyticsService.getRawLogs();
    expect(logs.map((l) => l.id)).toEqual(['old', 'bad', 'new']);
    expect(logs[1]).toMatchObject({ success: false, error: 'ai_timeout', totalTokens: 0 });
    expect(logs[2]).toMatchObject({ feature: 'project-brief', success: true, totalTokens: 1500, responseTime: 800 });
    expect(logs[2].estimatedCostCzk).toBeGreaterThan(0);
    expect(aiAnalyticsService.isLedgerBacked()).toBe(true);
  });

  test('dashboard statistics are computed from the ledger', async () => {
    h.rows = [row({ id: 'a' }), row({ id: 'b', feature: 'improve', total_tokens: 500, prompt_tokens: 300, completion_tokens: 200 })];
    await aiAnalyticsService.syncLedger();
    const s = await aiAnalyticsService.getStats();
    expect(s.todayRequests).toBe(2);
    expect(s.todayTokens).toBe(2000);
    const fb = await aiAnalyticsService.getFeatureBreakdown();
    expect(fb.map((f) => f.featureName).sort()).toEqual(['chat', 'improve']);
  });

  test('a ledger error falls back to the local record instead of breaking the page', async () => {
    h.rows = [row({ id: 'a' })];
    await aiAnalyticsService.syncLedger();
    h.error = { code: '42P01' };
    expect(await aiAnalyticsService.syncLedger()).toBe(false);
    expect(aiAnalyticsService.isLedgerBacked()).toBe(false);
    expect(aiAnalyticsService.getRawLogs()).toEqual([]);
  });

  test('privacy: logging a request stores NOTHING in the browser and never keeps prompt or response content', async () => {
    h.rows = [];
    await aiAnalyticsService.syncLedger();
    const out = await aiAnalyticsService.logRequest({
      timestamp: now, feature: 'chat', provider: 'google', model: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2, responseTime: 5, success: true,
      requestPayload: { secret: 'TAJNÝ PROMPT' }, responsePayload: { secret: 'TAJNÁ ODPOVĚĎ' },
    });
    expect(out.requestPayload).toBeUndefined();
    expect(out.responsePayload).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(0);
  });

  test('a ledger-backed view cannot be wiped from the browser', async () => {
    h.rows = [row({ id: 'a' })];
    await aiAnalyticsService.syncLedger();
    await aiAnalyticsService.clearLogs();
    expect(aiAnalyticsService.getRawLogs()).toHaveLength(1);
  });
});
