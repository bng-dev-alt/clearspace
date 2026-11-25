import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DRIVE_SCOPES, GMAIL_READONLY_SCOPE, GMAIL_SCOPES, gmailFeatureEnabled, googleConfig, SERVICE_SCOPES } from '../../lib/google/config';
import { buildAuthUrl, hasService } from '../../lib/google/oauth';
import { getAccessToken, getNarrowAccessToken, requireGmail, withGmailToken, HttpError } from '../../lib/google/server';
import { seal, tokenAad } from '../../lib/google/crypto';
import { serviceActive, type GoogleStatus } from '../../services/driveService';
import { describeActivity } from '../../lib/collab/activityText';

const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_SERVER_SECRET: 'g'.repeat(40),
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456', GOOGLE_CLOUD_PROJECT_NUMBER: '1234567',
  APP_BASE_URL: 'https://c.example' } as unknown as NodeJS.ProcessEnv;
const cfg = (() => { const c = googleConfig(ENV); if (!c.enabled) throw new Error(c.reason); return c; })();
const U = 'user-1';
const DRIVE = 'https://www.googleapis.com/auth/drive.file';
const row = (scopes: string[]) => ({
  user_id: U, status: 'active', scopes, token_version: 1,
  refresh_token_enc: seal(cfg.keys, '1//refresh', tokenAad(U, 'refresh')),
  access_token_enc: seal(cfg.keys, 'ya29.fresh', tokenAad(U, 'access')),
  access_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
});
function fakeDb(r: Record<string, unknown> | null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'google_credentials_get') return { data: r ? [r] : [], error: null };
    if (name === 'google_refresh_lease') return { data: true, error: null };
    if (name === 'google_refresh_store') return { data: true, error: null };
    if (name === 'google_connection_mark') return { data: null, error: null };
    return { data: null, error: { code: 'XX', message: 'unexpected' } };
  });
  return { db: { rpc } as unknown as SupabaseClient, calls };
}

describe('scopes: least privilege per service, incremental', () => {
  it('Gmail asks only identity + gmail.readonly (never modify/send/compose/full mail); Drive unchanged', () => {
    expect(GMAIL_SCOPES).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect(DRIVE_SCOPES).toEqual(['openid', 'email', DRIVE]);
    expect(GMAIL_SCOPES.join(' ')).not.toMatch(/gmail\.(modify|send|compose|insert|metadata)|mail\.google\.com|drive/);
    expect(SERVICE_SCOPES.gmail).toBe(GMAIL_SCOPES);
  });
  it('auth URL: incremental (include_granted_scopes), PKCE, offline, the same account pre-selected', () => {
    const u = new URL(buildAuthUrl(cfg, { state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), scopes: GMAIL_SCOPES, loginHint: 'anna.mock@example.test' }));
    expect(u.searchParams.get('include_granted_scopes')).toBe('true');
    expect(u.searchParams.get('scope')).toBe(`openid email ${GMAIL_READONLY_SCOPE}`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('login_hint')).toBe('anna.mock@example.test');
    expect(u.searchParams.get('redirect_uri')).toBe('https://c.example/api/google/oauth/callback');
  });
  it('Gmail feature switch: OFF unless exactly "1"; independent of the Drive configuration; mock base includes Gmail only on loopback', () => {
    expect(gmailFeatureEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(gmailFeatureEnabled({ GMAIL_INTEGRATION_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(gmailFeatureEnabled({ GMAIL_INTEGRATION_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(cfg.endpoints.gmail).toBe('https://gmail.googleapis.com/gmail/v1');
    const m = googleConfig({ ...ENV, GOOGLE_API_MOCK_BASE: 'http://127.0.0.1:55591' } as NodeJS.ProcessEnv);
    expect(m.enabled && m.endpoints.gmail).toBe('http://127.0.0.1:55591/gmail/v1');
    expect(googleConfig({ ...ENV, GOOGLE_API_MOCK_BASE: 'http://gmail.evil.example' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });
  it('per-service state is tracked separately (one grant, two services)', () => {
    expect(hasService([DRIVE], 'gmail')).toBe(false);
    expect(hasService([DRIVE, GMAIL_READONLY_SCOPE], 'gmail')).toBe(true);
    const st = (services?: { drive: boolean; gmail: boolean }, status: 'active' | 'revoked' = 'active'): GoogleStatus => ({ configured: true, connection: { email: 'a@x', scopes: [], status, connectedAt: '', services } });
    expect(serviceActive(st({ drive: true, gmail: false }), 'gmail')).toBe(false);
    expect(serviceActive(st({ drive: false, gmail: true }), 'drive')).toBe(false);
    expect(serviceActive(st(undefined), 'drive')).toBe(true);           // older server: Drive only
    expect(serviceActive(st({ drive: true, gmail: true }, 'revoked'), 'gmail')).toBe(false);
  });
});

describe('tokens are used only for the service the user enabled', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('Drive-only grant: a Gmail route is refused BEFORE any Google call (and vice versa)', async () => {
    const f = vi.fn(); vi.stubGlobal('fetch', f);
    await expect(getAccessToken(fakeDb(row(['openid', DRIVE])).db, cfg, { service: 'gmail' })).rejects.toMatchObject({ status: 409, code: 'gmail_not_granted' });
    await expect(getAccessToken(fakeDb(row(['openid', GMAIL_READONLY_SCOPE])).db, cfg, { service: 'drive' })).rejects.toMatchObject({ status: 409, code: 'drive_not_granted' });
    expect((await getAccessToken(fakeDb(row(['openid', DRIVE, GMAIL_READONLY_SCOPE])).db, cfg, { service: 'gmail' })).token).toBe('ya29.fresh');
    await expect(getAccessToken(fakeDb(null).db, cfg, { service: 'gmail' })).rejects.toMatchObject({ code: 'not_connected' });
    expect(f).not.toHaveBeenCalled();
  });
  it('browser Picker token is DOWNSCOPED to Drive; refused when Google answers with Gmail anyway', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.narrow', expires_in: 3600, scope: `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE}` })));
    vi.stubGlobal('fetch', f);
    const { db } = fakeDb(row(['openid', DRIVE, GMAIL_READONLY_SCOPE]));
    expect((await getNarrowAccessToken(db, cfg, DRIVE_SCOPES)).token).toBe('ya29.narrow');
    const body = new URLSearchParams(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('scope')).toBe(DRIVE_SCOPES.join(' '));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.wide', expires_in: 3600, scope: `openid ${DRIVE} ${GMAIL_READONLY_SCOPE}` }))));
    await expect(getNarrowAccessToken(db, cfg, DRIVE_SCOPES)).rejects.toMatchObject({ status: 503, code: 'narrow_token_refused' });
  });
  it('narrow token: revoked grant marks the connection revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    const { db, calls } = fakeDb(row(['openid', DRIVE, GMAIL_READONLY_SCOPE]));
    await expect(getNarrowAccessToken(db, cfg, DRIVE_SCOPES)).rejects.toMatchObject({ code: 'revoked' });
    expect(calls.find((c) => c.name === 'google_connection_mark')?.args.p_status).toBe('revoked');
  });
  it('withGmailToken: exactly one forced refresh when Google says the token is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.new', expires_in: 3600 }))));
    const { db } = fakeDb(row(['openid', GMAIL_READONLY_SCOPE]));
    const call = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'auth' }).mockResolvedValueOnce({ ok: true, value: 1 });
    expect(await withGmailToken(db, cfg, 1, call)).toEqual({ ok: true, value: 1 });
    expect(call.mock.calls.map((c) => c[0])).toEqual(['ya29.fresh', 'ya29.new']);
  });
  it('requireGmail: the feature switch alone turns every Gmail route off', () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, String(v));
    vi.stubEnv('GMAIL_INTEGRATION_ENABLED', '');
    expect(() => requireGmail()).toThrow(HttpError);
    try { requireGmail(); } catch (e) { expect((e as HttpError).code).toBe('gmail_disabled'); }
    vi.stubEnv('GMAIL_INTEGRATION_ENABLED', '1');
    expect(requireGmail().enabled).toBe(true);
  });
});

describe('activity: e-mail events carry no subject', () => {
  const log = (action_type: string, details: Record<string, unknown>) => ({ id: 'e', actionType: action_type, details, actorName: 'Alice', createdAt: '' }) as never;
  it('Czech texts for message/thread, project/task; nothing private', () => {
    expect(describeActivity(log('email_linked', { kind: 'thread', link_id: 'x' })).text).toBe('připojil(a) k projektu e-mailovou konverzaci z Gmailu');
    expect(describeActivity(log('email_linked', { kind: 'message', title: 'Smlouva' })).text).toBe('připojil(a) e-mail z Gmailu k úkolu „Smlouva"');
    expect(describeActivity(log('email_unlinked', { kind: 'message' })).text).toBe('odebral(a) z projektu e-mail z Gmailu');
    expect(describeActivity(log('email_linked', { kind: 'thread' })).kind).toBe('file');
  });
});
