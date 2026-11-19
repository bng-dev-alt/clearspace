import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { aiAccessAllowed, aiOwnerIds } from '../../lib/ai/owner';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('owner allowlist (pure)', () => {
  test('fail closed: nothing configured -> nobody', () => {
    expect(aiAccessAllowed(OWNER, {})).toBe(false);
    expect(aiAccessAllowed(OWNER, { AI_OWNER_USER_IDS: '' })).toBe(false);
  });
  test('only the listed UUIDs (case-insensitive, whitespace tolerated); garbage entries are ignored, never widen access', () => {
    const env = { AI_OWNER_USER_IDS: ` ${OWNER.toUpperCase()} , not-a-uuid, * , ` };
    expect([...aiOwnerIds(env)]).toEqual([OWNER]);
    expect(aiAccessAllowed(OWNER, env)).toBe(true);
    expect(aiAccessAllowed(OTHER, env)).toBe(false);
  });
  test('only invalid entries = still closed (a typo cannot open the AI)', () => {
    expect(aiAccessAllowed(OTHER, { AI_OWNER_USER_IDS: '*,all,owner@example.com' })).toBe(false);
  });
  test('the allowlist wins over the local allow-all flag', () => {
    expect(aiAccessAllowed(OTHER, { AI_OWNER_USER_IDS: OWNER, AI_ALLOW_ALL_AUTHENTICATED: '1' })).toBe(false);
  });
  test('allow-all is a local/test opt-in and is ignored on a Vercel production deployment', () => {
    expect(aiAccessAllowed(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1' })).toBe(true);
    expect(aiAccessAllowed(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: '1', VERCEL_ENV: 'production' })).toBe(false);
    expect(aiAccessAllowed(OTHER, { AI_ALLOW_ALL_AUTHENTICATED: 'true' })).toBe(false);
  });
});

// authenticate(): the gate is enforced server-side after the JWT is verified; `gate:false` is only for the access question.
const h = vi.hoisted(() => ({ userId: '' as string, authError: false, touched: [] as string[] }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc: (n: string) => { h.touched.push(`rpc:${n}`); return Promise.resolve({ data: null, error: { code: 'x' } }); }, from: (t: string) => { h.touched.push(`from:${t}`); throw new Error('db touched'); }, storage: { from: () => { h.touched.push('storage'); throw new Error('storage touched'); } }, auth: { getUser: async () => (h.authError ? { data: { user: null }, error: { message: 'bad' } } : { data: { user: { id: h.userId } }, error: null }) } }),
}));
import { authenticate } from '../../lib/ai/gateway';

const req = (token: string | null) => new NextRequest('http://localhost/api/intelligence/x', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
const TOKEN = 'a'.repeat(40);

describe('authenticate() enforces the owner gate server-side', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon'); vi.stubEnv('NEXT_PUBLIC_FORCE_DEMO', '');
    vi.stubEnv('AI_ALLOW_ALL_AUTHENTICATED', ''); vi.stubEnv('AI_OWNER_USER_IDS', OWNER); h.authError = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  test('owner passes', async () => { h.userId = OWNER; expect((await authenticate(req(TOKEN))).user.id).toBe(OWNER); });
  test('another valid account: 403 ai_owner_only (the project membership does not matter)', async () => {
    h.userId = OTHER;
    await expect(authenticate(req(TOKEN))).rejects.toMatchObject({ code: 'ai_owner_only', status: 403 });
  });
  test('anonymous (no token) and an invalid token: 401, never reaching the gate', async () => {
    await expect(authenticate(req(null))).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    h.authError = true;
    await expect(authenticate(req(TOKEN))).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
  });
  test('nothing configured: even the owner is refused (fail closed)', async () => {
    vi.stubEnv('AI_OWNER_USER_IDS', ''); h.userId = OWNER;
    await expect(authenticate(req(TOKEN))).rejects.toMatchObject({ code: 'ai_owner_only' });
  });
  test('gate:false (the access question) lets a non-owner ask, but still needs a valid login', async () => {
    h.userId = OTHER; expect((await authenticate(req(TOKEN), { gate: false })).user.id).toBe(OTHER);
    await expect(authenticate(req(null), { gate: false })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

import { POST as transcribe } from '../../app/api/intelligence/meetings/transcribe/route';
import { POST as sync } from '../../app/api/intelligence/meetings/sync/route';
import { POST as purge } from '../../app/api/intelligence/meetings/purge/route';
import { POST as sweep } from '../../app/api/intelligence/meetings/sweep/route';
import { POST as analyze } from '../../app/api/intelligence/meetings/analyze/route';
import { POST as brief } from '../../app/api/intelligence/project-brief/route';
import { POST as chat } from '../../app/api/intelligence/chat/route';
import { POST as legacyChat } from '../../app/api/ai/chat/route';
import { POST as access } from '../../app/api/intelligence/access/route';

const post = (route: (r: NextRequest) => Promise<Response>, token: string | null) =>
  route(new NextRequest('http://localhost/api/x', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ projectId: 'p', meetingId: '33333333-3333-4333-8333-333333333333', messages: [{ role: 'user', content: 'x' }] }) }));

describe('every owner route: a non-owner is refused BEFORE any database, storage, quota or provider access', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon'); vi.stubEnv('NEXT_PUBLIC_FORCE_DEMO', '');
    vi.stubEnv('AI_ALLOW_ALL_AUTHENTICATED', ''); vi.stubEnv('AI_OWNER_USER_IDS', OWNER); vi.stubEnv('STT_ENABLED', '1'); vi.stubEnv('SONIOX_API_KEY', 'k'); vi.stubEnv('GEMINI_API_KEY', 'k');
    h.authError = false; h.touched.length = 0;
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const routes = { transcribe, sync, purge, sweep, analyze, brief, chat, legacyChat };
  for (const [name, route] of Object.entries(routes)) {
    test(`${name}: other account -> 403 ai_owner_only, anonymous -> 401, nothing touched, no provider fetch`, async () => {
      const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
      h.userId = OTHER;
      const r = await post(route, TOKEN);
      expect(r.status).toBe(403); expect((await r.json()).code).toBe('ai_owner_only');
      expect((await post(route, null)).status).toBe(401);
      expect(h.touched).toEqual([]); expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
  test('with the owner id the gate lets the request through to the normal checks (no longer ai_owner_only)', async () => {
    h.userId = OWNER;
    const r = await post(sweep, TOKEN);
    expect((await r.json().catch(() => ({}))).code).not.toBe('ai_owner_only');
  });
  test('the access question: owner true, other false, anonymous 401, and it reveals nothing else', async () => {
    h.userId = OWNER; expect(await (await post(access, TOKEN)).json()).toEqual({ aiOwner: true, stt: true });
    h.userId = OTHER; expect(await (await post(access, TOKEN)).json()).toEqual({ aiOwner: false, stt: false });
    expect((await post(access, null)).status).toBe(401);
    vi.stubEnv('STT_ENABLED', ''); h.userId = OWNER; expect(await (await post(access, TOKEN)).json()).toEqual({ aiOwner: true, stt: false });
  });
});
