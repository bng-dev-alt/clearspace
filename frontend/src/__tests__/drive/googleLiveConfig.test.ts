import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { googleConfig, secretFormat } from '../../lib/google/config';
import { oauthLog } from '../../lib/google/server';

const REAL = {
  GOOGLE_OAUTH_CLIENT_ID: '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-' + 'a'.repeat(28),
  GOOGLE_SERVER_SECRET: 'g'.repeat(40), GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  GOOGLE_PICKER_API_KEY: 'AIza' + 'b'.repeat(35), GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012', APP_BASE_URL: 'http://127.0.0.1:3441',
} as unknown as NodeJS.ProcessEnv;

describe('RUN 02B regression: the MOCK client secret must never reach real Google', () => {
  it('classifies secrets by format only', () => {
    expect(secretFormat('GOCSPX-abc')).toBe('gocspx');
    expect(secretFormat('mock-1234')).toBe('mock');
    expect(secretFormat('whatever')).toBe('other');
  });
  it('real mode with a real-format secret is enabled and talks to Google', () => {
    const c = googleConfig(REAL);
    expect(c.enabled && !c.mock && c.endpoints.token).toBe('https://oauth2.googleapis.com/token');
  });
  it('a mock-format secret without the mock provider disables the integration (instead of an invalid_client at the first sign-in)', () => {
    const c = googleConfig({ ...REAL, GOOGLE_OAUTH_CLIENT_SECRET: 'mock-' + 'a'.repeat(32) });
    expect(c.enabled).toBe(false);
    expect(!c.enabled && c.reason).toMatch(/zkušební \(mock\) hodnota/);
  });
  it('the same mock secret is fine together with the loopback mock provider', () => {
    const c = googleConfig({ ...REAL, GOOGLE_OAUTH_CLIENT_SECRET: 'mock-' + 'a'.repeat(32), GOOGLE_API_MOCK_BASE: 'http://127.0.0.1:55590' });
    expect(c.enabled && c.mock).toBe(true);
  });
  it('the stack launcher never sources the accounts file (it holds the mock secret and overwrote the real one)', () => {
    const sh = readFileSync('scripts/collab-stack.sh', 'utf8');
    const app = sh.slice(sh.indexOf('  app)'), sh.indexOf('  mail)'));
    expect(app).not.toMatch(/^\s*\.\s+"?\$DIR\/collab-accounts\.env/m);
    expect(app).not.toMatch(/\bsource\b.*collab-accounts/);
    const live = readFileSync('scripts/google-live.sh', 'utf8');
    expect(live).not.toMatch(/^\s*\.\s+"\$DIR\/collab-accounts\.env"/m);
  });
});

describe('structured OAuth log is secret-free', () => {
  afterEach(() => vi.restoreAllMocks());
  it('writes one JSON line with whitelisted scalar fields and drops long (token-like) strings', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    oauthLog('exchange_failed', { code: 'invalid_client', httpStatus: 401, token: 'ya29.' + 'x'.repeat(120), driveGranted: false });
    const line = String(spy.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ evt: 'google', phase: 'exchange_failed', code: 'invalid_client', httpStatus: 401, driveGranted: false });
    expect(line).not.toContain('ya29');
  });
});

describe('RUN 02B finding: the dev server must not log the OAuth callback URL (it carries the authorization code)', () => {
  it('next.config ignores the callback route in the incoming-request log, and only that route', async () => {
    const mod = await import('../../../next.config');
    const ignore = (mod.default.logging as { incomingRequests: { ignore: RegExp[] } }).incomingRequests.ignore;
    const hit = (u: string) => ignore.some((r) => r.test(u));
    expect(hit('/api/google/oauth/callback?state=x&code=4/0AbC')).toBe(true);
    expect(hit('/api/google/oauth/start')).toBe(false);
    expect(hit('/settings')).toBe(false);
  });
});
