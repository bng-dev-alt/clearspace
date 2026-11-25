import { describe, it, expect, vi, afterEach } from 'vitest';
import { keyFromBase64, seal, open, isStale, pkcePair, s256, tokenAad, sha256hex } from '../../lib/google/crypto';
import { googleConfig, DRIVE_SCOPES } from '../../lib/google/config';
import { buildAuthUrl, parseIdToken, hasDriveScope, exchangeCode, refreshAccessToken, GoogleOAuthError } from '../../lib/google/oauth';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const ring = { current: keyFromBase64(K1) };
const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-123.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'sec',
  GOOGLE_SERVER_SECRET: 'g'.repeat(40), GOOGLE_TOKEN_ENCRYPTION_KEY: K1, GOOGLE_PICKER_API_KEY: 'AIzaTestKey_123456',
  GOOGLE_CLOUD_PROJECT_NUMBER: '123456789012', APP_BASE_URL: 'https://clearspace.example',
} as unknown as NodeJS.ProcessEnv;
const cfg = () => { const c = googleConfig(ENV); if (!c.enabled) throw new Error(c.reason); return c; };

describe('token encryption (AES-256-GCM envelopes)', () => {
  it('round-trips and never contains the plaintext', () => {
    const env = seal(ring, '1//refresh-secret', tokenAad('u1', 'refresh'));
    expect(env).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(env).not.toContain('refresh-secret');
    expect(open(ring, env, tokenAad('u1', 'refresh'))).toBe('1//refresh-secret');
  });
  it('a ciphertext copied to another user or purpose does not decrypt (AAD binding)', () => {
    const env = seal(ring, 'tok', tokenAad('u1', 'refresh'));
    expect(() => open(ring, env, tokenAad('u2', 'refresh'))).toThrow();
    expect(() => open(ring, env, tokenAad('u1', 'access'))).toThrow();
  });
  it('tampering is detected', () => {
    const env = seal(ring, 'tok', 'aad');
    const parts = env.split('.');
    parts[3] = Buffer.from('xxxx').toString('base64url');
    expect(() => open(ring, parts.join('.'), 'aad')).toThrow();
  });
  it('random IV: the same value seals differently', () => {
    expect(seal(ring, 'same', 'a')).not.toBe(seal(ring, 'same', 'a'));
  });
  it('rotation: values sealed with the previous key still open, new ones use the current key', () => {
    const old = seal(ring, 'tok', 'a');
    const rotated = { current: keyFromBase64(K2), previous: keyFromBase64(K1) };
    expect(open(rotated, old, 'a')).toBe('tok');
    expect(isStale(rotated, old)).toBe(true);
    expect(isStale(rotated, seal(rotated, 'tok', 'a'))).toBe(false);
    expect(() => open({ current: keyFromBase64(K2) }, old, 'a')).toThrow(/unknown key/);
  });
  it('rejects keys that are not 32 bytes', () => {
    expect(() => keyFromBase64(Buffer.alloc(16).toString('base64'))).toThrow();
    expect(() => keyFromBase64(undefined)).toThrow();
  });
  it('PKCE S256 matches the RFC 7636 test vector', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const p = pkcePair();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(p.challenge).toBe(s256(p.verifier));
  });
  it('sha256hex is the stored form of state and nonce', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('configuration (fail closed)', () => {
  it('enabled with complete config; redirect URI only from APP_BASE_URL; real Google endpoints', () => {
    const c = cfg();
    expect(c.redirectUri).toBe('https://clearspace.example/api/google/oauth/callback');
    expect(c.endpoints.token).toBe('https://oauth2.googleapis.com/token');
    expect(c.endpoints.pickerScript).toBe('https://apis.google.com/js/api.js');
    expect(c.mock).toBe(false);
  });
  it('requests exactly openid, email and drive.file -- no Gmail, Calendar or broad Drive scope', () => {
    expect(DRIVE_SCOPES).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/drive.file']);
  });
  it.each([
    ['GOOGLE_OAUTH_CLIENT_SECRET', ''],
    ['GOOGLE_SERVER_SECRET', 'short'],
    ['GOOGLE_TOKEN_ENCRYPTION_KEY', 'not-a-key'],
    ['GOOGLE_CLOUD_PROJECT_NUMBER', 'my-project-id'],
    ['GOOGLE_PICKER_API_KEY', ''],
    ['APP_BASE_URL', 'ftp://x'],
  ])('disabled when %s is invalid', (k, v) => {
    expect(googleConfig({ ...ENV, [k]: v }).enabled).toBe(false);
  });
  it('the e-mail server secret cannot double as the Google one', () => {
    expect(googleConfig({ ...ENV, EMAIL_SERVER_SECRET: 'g'.repeat(40) }).enabled).toBe(false);
  });
  it('the mock provider is honoured only on loopback and never in production', () => {
    const local = googleConfig({ ...ENV, APP_BASE_URL: 'http://127.0.0.1:3441', GOOGLE_API_MOCK_BASE: 'http://127.0.0.1:55590' });
    expect(local.enabled && local.mock && local.endpoints.token).toBe('http://127.0.0.1:55590/token');
    expect(googleConfig({ ...ENV, GOOGLE_API_MOCK_BASE: 'http://evil.example:80' }).enabled).toBe(false);
    expect(googleConfig({ ...ENV, VERCEL_ENV: 'production', GOOGLE_API_MOCK_BASE: 'http://127.0.0.1:55590' }).enabled).toBe(false);
  });
});

describe('OAuth protocol', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('authorization URL: code + PKCE S256 + offline + consent + incremental, no secret', () => {
    const u = new URL(buildAuthUrl(cfg(), { state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), scopes: DRIVE_SCOPES }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', redirect_uri: 'https://clearspace.example/api/google/oauth/callback' });
    expect(q.scope).toBe('openid email https://www.googleapis.com/auth/drive.file');
    expect(u.toString()).not.toContain('sec');
  });
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
  const good = { iss: 'https://accounts.google.com', aud: 'client-123.apps.googleusercontent.com', sub: '1234567890', email: 'a@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
  it('id_token: issuer, audience, expiry, verified e-mail are checked; sub is the identity', () => {
    expect(parseIdToken(cfg(), jwt(good))).toEqual({ sub: '1234567890', email: 'a@example.test' });
    for (const bad of [{ iss: 'https://evil.example' }, { aud: 'other-client' }, { exp: 1 }, { email_verified: false }, { sub: '../x' }]) {
      expect(() => parseIdToken(cfg(), jwt({ ...good, ...bad }))).toThrow(GoogleOAuthError);
    }
    expect(() => parseIdToken(cfg(), undefined)).toThrow(/missing_id_token/);
  });
  it('granular consent: Drive must actually be granted', () => {
    expect(hasDriveScope(['openid', 'email'])).toBe(false);
    expect(hasDriveScope(DRIVE_SCOPES)).toBe(true);
  });
  it('code exchange sends verifier + secret and maps tokens; errors carry only the OAuth code', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3599, refresh_token: '1//r', scope: DRIVE_SCOPES.join(' '), id_token: 'i' })));
    vi.stubGlobal('fetch', fetchMock);
    const t = await exchangeCode(cfg(), 'code-1', 'verifier-1');
    expect(t).toMatchObject({ accessToken: 'ya29.x', refreshToken: '1//r', expiresIn: 3599 });
    const body = new URLSearchParams((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('grant_type')).toBe('authorization_code');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token 1//r revoked' }), { status: 400 })));
    const e = await refreshAccessToken(cfg(), '1//r').catch((x) => x);
    expect(e).toBeInstanceOf(GoogleOAuthError);
    expect(e.code).toBe('invalid_grant');
    expect(String(e.message)).not.toContain('1//r');
  });
  it('refresh without a new refresh token keeps it undefined (stored one is kept); oversized / network failures map safely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'ya29.y', expires_in: 3600 }))));
    expect((await refreshAccessToken(cfg(), 'r')).refreshToken).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(70 * 1024))));
    expect((await refreshAccessToken(cfg(), 'r').catch((x) => x)).code).toBe('response_too_large');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await refreshAccessToken(cfg(), 'r').catch((x) => x)).code).toBe('unavailable');
  });
});
