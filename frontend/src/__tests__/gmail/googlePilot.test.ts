import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CALENDAR_READONLY_SCOPE, GMAIL_READONLY_SCOPE, googleConfig, serviceAllowedFor, serviceAllowedForAccount, serviceMode } from '../../lib/google/config';
import { getAccessToken, requireCalendar, requireGmail, HttpError } from '../../lib/google/server';
import { seal, tokenAad } from '../../lib/google/crypto';

/** RUN 06 pilot mode: Gmail / Calendar on only for listed ClearSpace users with a listed Google account. */
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_SERVER_SECRET: 'g'.repeat(40),
  GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456', GOOGLE_CLOUD_PROJECT_NUMBER: '1234567',
  APP_BASE_URL: 'https://c.example' };
const cfg = (() => { const c = googleConfig(ENV as unknown as NodeJS.ProcessEnv); if (!c.enabled) throw new Error(c.reason); return c; })();
const PILOT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const env = (o: Record<string, string>) => ({ ...ENV, ...o }) as unknown as NodeJS.ProcessEnv;
const P = { GOOGLE_PILOT_USER_IDS: ` ${PILOT.toUpperCase()} ,x`, GOOGLE_PILOT_ACCOUNTS: 'Demo.Presenter@example.com' };

function fakeDb(userId: string, email: string) {
  const r = { user_id: userId, status: 'active', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file', GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE], token_version: 1,
    refresh_token_enc: seal(cfg.keys, '1//refresh', tokenAad(userId, 'refresh')), access_token_enc: seal(cfg.keys, 'ya29.fresh', tokenAad(userId, 'access')),
    access_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
  const rpc = vi.fn(async (name: string) => name === 'google_credentials_get' ? { data: [r], error: null }
    : name === 'google_connection_status' ? { data: [{ google_email: email }], error: null } : { data: null, error: { code: 'XX' } });
  return { rpc } as unknown as SupabaseClient;
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as HttpError).code; } };

afterEach(() => vi.unstubAllEnvs());

describe('pilot mode', () => {
  it('modes: only exact "1" and "pilot"; everything else is off', () => {
    for (const v of ['', '0', 'true', 'Pilot ', 'pilots', 'on']) expect(serviceMode('gmail', env({ GMAIL_INTEGRATION_ENABLED: v }))).toBe('off');
    expect(serviceMode('gmail', env({ GMAIL_INTEGRATION_ENABLED: ' pilot ' }))).toBe('pilot');
    expect(serviceMode('calendar', env({ CALENDAR_INTEGRATION_ENABLED: '1' }))).toBe('on');
    expect(serviceMode('calendar', env({ GMAIL_INTEGRATION_ENABLED: '1' }))).toBe('off');     // independent switches
  });

  it('pilot allows only a listed user with a listed account; empty lists fail closed', () => {
    const e = env({ GMAIL_INTEGRATION_ENABLED: 'pilot', ...P });
    expect(serviceAllowedFor('gmail', PILOT, e)).toBe(true);
    expect(serviceAllowedFor('gmail', OTHER, e)).toBe(false);
    expect(serviceAllowedFor('calendar', PILOT, e)).toBe(false);                       // Calendar still off
    expect(serviceAllowedForAccount('gmail', PILOT, 'demo.presenter@EXAMPLE.com', e)).toBe(true);
    expect(serviceAllowedForAccount('gmail', PILOT, 'someone.else@example.com', e)).toBe(false);
    expect(serviceAllowedForAccount('gmail', PILOT, undefined, e)).toBe(false);
    expect(serviceAllowedFor('gmail', PILOT, env({ GMAIL_INTEGRATION_ENABLED: 'pilot', GOOGLE_PILOT_USER_IDS: PILOT }))).toBe(false);   // no accounts
    expect(serviceAllowedFor('gmail', PILOT, env({ GMAIL_INTEGRATION_ENABLED: 'pilot', GOOGLE_PILOT_ACCOUNTS: 'a@example.com' }))).toBe(false);
    expect(serviceAllowedFor('drive', OTHER, e)).toBe(true);                           // Drive is not gated by the pilot
    expect(serviceAllowedForAccount('gmail', OTHER, 'x@example.com', env({ GMAIL_INTEGRATION_ENABLED: '1' }))).toBe(true);   // '1' unchanged
  });

  it('routes: pilot passes the switch; the token is refused for a non-pilot user or account (same code as off)', async () => {
    for (const [k, v] of Object.entries({ ...ENV, ...P, GMAIL_INTEGRATION_ENABLED: 'pilot', CALENDAR_INTEGRATION_ENABLED: 'pilot' })) vi.stubEnv(k, v);
    expect(requireGmail().enabled).toBe(true);
    expect(requireCalendar().enabled).toBe(true);
    expect(await code(getAccessToken(fakeDb(PILOT, 'demo.presenter@example.com'), cfg, { service: 'gmail' }))).toBe('ok');
    expect(await code(getAccessToken(fakeDb(PILOT, 'demo.presenter@example.com'), cfg, { service: 'calendar' }))).toBe('ok');
    expect(await code(getAccessToken(fakeDb(OTHER, 'demo.presenter@example.com'), cfg, { service: 'gmail' }))).toBe('gmail_disabled');
    expect(await code(getAccessToken(fakeDb(PILOT, 'private.person@example.com'), cfg, { service: 'calendar' }))).toBe('calendar_disabled');
    expect(await code(getAccessToken(fakeDb(OTHER, 'x@example.com'), cfg, { service: 'drive' }))).toBe('ok');
    vi.stubEnv('GMAIL_INTEGRATION_ENABLED', '0');
    expect(() => requireGmail()).toThrow(/Gmail/);
  });
});
