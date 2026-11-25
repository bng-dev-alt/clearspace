import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccessToken, HttpError } from '../../lib/google/server';
import { googleConfig } from '../../lib/google/config';
import { seal, open, tokenAad } from '../../lib/google/crypto';
import { GET as callback } from '../../app/api/google/oauth/callback/route';
import { NextRequest } from 'next/server';

const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_SERVER_SECRET: 'g'.repeat(40),
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456', GOOGLE_CLOUD_PROJECT_NUMBER: '1234567',
  APP_BASE_URL: 'https://c.example' } as unknown as NodeJS.ProcessEnv;
const cfg = (() => { const c = googleConfig(ENV); if (!c.enabled) throw new Error(c.reason); return c; })();
const U = 'user-1';

/** Minimal stand-in for the database RPCs (same contract as 20261126001200). */
function fakeDb(row: Record<string, unknown> | null) {
  const state = { row: row ? { ...row } : null, lease: false, calls: [] as string[] };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    state.calls.push(name);
    if (name === 'google_credentials_get') return { data: state.row ? [state.row] : [], error: null };
    if (name === 'google_refresh_lease') { if (state.lease) return { data: false, error: null }; state.lease = true; return { data: true, error: null }; }
    if (name === 'google_refresh_store') {
      Object.assign(state.row!, { access_token_enc: args.p_access_token_enc, access_expires_at: args.p_access_expires_at, token_version: (state.row!.token_version as number) + 1 });
      if (args.p_refresh_token_enc) state.row!.refresh_token_enc = args.p_refresh_token_enc;
      state.lease = false;
      return { data: true, error: null };
    }
    if (name === 'google_connection_mark') { state.row!.status = args.p_status; state.lease = false; return { data: null, error: null }; }
    return { data: null, error: { code: 'XX', message: 'unexpected' } };
  });
  return { db: { rpc } as unknown as SupabaseClient, state };
}
const row = (over: Record<string, unknown> = {}) => ({
  user_id: U, status: 'active', scopes: [], token_version: 1,
  refresh_token_enc: seal(cfg.keys, '1//refresh', tokenAad(U, 'refresh')),
  access_token_enc: seal(cfg.keys, 'ya29.fresh', tokenAad(U, 'access')),
  access_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), ...over,
});

describe('access token lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a fresh token is decrypted and used without calling Google', async () => {
    const { db } = fakeDb(row());
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect((await getAccessToken(db, cfg)).token).toBe('ya29.fresh');
    expect(f).not.toHaveBeenCalled();
  });
  it('expiring token: one refresh, stored encrypted, old refresh token kept when Google returns none', async () => {
    const { db, state } = fakeDb(row({ access_expires_at: new Date(Date.now() + 10_000).toISOString() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 }))));
    expect((await getAccessToken(db, cfg)).token).toBe('ya29.new');
    expect(open(cfg.keys, state.row!.access_token_enc as string, tokenAad(U, 'access'))).toBe('ya29.new');
    expect(open(cfg.keys, state.row!.refresh_token_enc as string, tokenAad(U, 'refresh'))).toBe('1//refresh');
    expect(String(state.row!.access_token_enc)).not.toContain('ya29');
  });
  it('a request that does not get the lease waits for the stored result instead of refreshing again', async () => {
    const { db, state } = fakeDb(row({ access_expires_at: new Date(0).toISOString() }));
    state.lease = true;   // someone else is refreshing
    setTimeout(() => { Object.assign(state.row!, { access_token_enc: seal(cfg.keys, 'ya29.other', tokenAad(U, 'access')), access_expires_at: new Date(Date.now() + 3600_000).toISOString(), token_version: 2 }); }, 300);
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    expect((await getAccessToken(db, cfg)).token).toBe('ya29.other');
    expect(f).not.toHaveBeenCalled();
  });
  it('invalid_grant marks the connection revoked and asks to reconnect (Czech)', async () => {
    const { db, state } = fakeDb(row({ access_expires_at: new Date(0).toISOString() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    const e = await getAccessToken(db, cfg).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect([e.status, e.code]).toEqual([409, 'revoked']);
    expect(e.message).toMatch(/Připojte účet prosím znovu/);
    expect(state.row!.status).toBe('revoked');
  });
  it('a temporary Google failure keeps the connection and releases the lease', async () => {
    const { db, state } = fakeDb(row({ access_expires_at: new Date(0).toISOString() }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const e = await getAccessToken(db, cfg).catch((x) => x);
    expect([e.status, e.code]).toEqual([503, 'unavailable']);
    expect(state.row!.status).toBe('active');
    expect(state.lease).toBe(false);
  });
  it('not connected / revoked are distinct, user-facing states', async () => {
    expect((await getAccessToken(fakeDb(null).db, cfg).catch((x) => x)).code).toBe('not_connected');
    expect((await getAccessToken(fakeDb(row({ status: 'revoked' })).db, cfg).catch((x) => x)).code).toBe('revoked');
  });
  it('a credential that no longer decrypts (key lost) is treated as revoked, never as a crash', async () => {
    const { db, state } = fakeDb(row({ access_expires_at: new Date(0).toISOString(), refresh_token_enc: seal(cfg.keys, 'x', tokenAad('someone-else', 'refresh')) }));
    expect((await getAccessToken(db, cfg).catch((x) => x)).code).toBe('revoked');
    expect(state.row!.status).toBe('revoked');
  });
});

describe('OAuth callback route (no session, no database, no Google call)', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });
  it('parks the answer in an HttpOnly path-scoped cookie and redirects only to APP_BASE_URL/oauth/google', async () => {
    Object.assign(process.env, ENV);
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    const res = await callback(new NextRequest(`https://c.example/api/google/oauth/callback?state=${'s'.repeat(43)}&code=4/abc&next=https://evil.example`));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://c.example/oauth/google');
    const ck = res.headers.get('set-cookie') ?? '';
    expect(ck).toMatch(/cs_google_oauth_result=/); expect(ck).toMatch(/HttpOnly/i); expect(ck).toMatch(/Path=\/api\/google\/oauth/); expect(ck).toMatch(/Secure/i);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(f).not.toHaveBeenCalled();
  });
  it('malformed state parks nothing usable', async () => {
    Object.assign(process.env, ENV);
    const res = await callback(new NextRequest('https://c.example/api/google/oauth/callback?state=x&code=y'));
    expect(decodeURIComponent(res.headers.get('set-cookie') ?? '')).toMatch(/cs_google_oauth_result=\{\}/);
  });
});
