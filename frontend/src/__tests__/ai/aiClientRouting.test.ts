import { describe, expect, test, vi, beforeEach } from 'vitest';

// Stávající AI funkce volají aiClient.fetchAi('/api/ai/...'); firewall drží /api/ai zavřené, proto klient posílá na owner-only /api/intelligence/...
vi.mock('../../lib/supabase', () => ({ hasSupabaseConfig: true, supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } } }));
vi.mock('../../services/ai/aiAnalyticsService', () => ({ aiAnalyticsService: { logRequest: vi.fn(async () => undefined) } }));
import { aiClient } from '../../services/ai/aiClient';

describe('aiClient.fetchAi routing', () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { calls.push(u); return new Response(JSON.stringify({ ok: 1 }), { status: 200 }); }));
  });
  test.each(['analyze-resource', 'capacity-planning', 'chat', 'daily-brief', 'generate-backlog', 'generate-project', 'generate-sprint', 'improve', 'project-manager', 'risk-analysis', 'voice-action'])('/api/ai/%s -> /api/intelligence/%s', async (n) => {
    await aiClient.fetchAi(`/api/ai/${n}`, 'x', {});
    expect(calls).toEqual([`/api/intelligence/${n}`]);
  });
  test('an already-owner path is left alone', async () => {
    await aiClient.fetchAi('/api/intelligence/chat', 'x', {});
    expect(calls).toEqual(['/api/intelligence/chat']);
  });
});
