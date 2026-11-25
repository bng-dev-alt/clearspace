import { DRIVE_FILE_SCOPE, type GoogleConfig } from './config';

/**
 * Google OAuth 2.0 for web server applications (authorization code + PKCE S256 + client secret), RUN 02.
 * Three documented HTTPS endpoints, called server-side with fetch, bounded by timeouts and response caps.
 * Nothing returned from here is ever logged: errors carry only an OAuth error CODE.
 */
export class GoogleOAuthError extends Error {
  constructor(public readonly code: string, public readonly status = 0) { super(`google oauth: ${code}`); this.name = 'GoogleOAuthError'; }
}

export function buildAuthUrl(cfg: GoogleConfig, p: { state: string; codeChallenge: string; scopes: string[]; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: p.scopes.join(' '),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',            // refresh token for server-side metadata refresh
    prompt: 'consent',                 // always return a refresh token (reconnect after revocation)
    include_granted_scopes: 'true',    // incremental authorization (Gmail / Calendar later add their own scopes)
  });
  if (p.loginHint) q.set('login_hint', p.loginHint);
  return `${cfg.endpoints.auth}?${q.toString()}`;
}

export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) { await reader.cancel().catch(() => {}); throw new GoogleOAuthError('response_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new GoogleOAuthError('unavailable');
  }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(await readCapped(res, 64 * 1024)) as Record<string, unknown>; } catch { /* non-JSON */ }
  if (!res.ok) {
    const code = typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : (res.status >= 500 ? 'unavailable' : 'oauth_error');
    throw new GoogleOAuthError(code, res.status);
  }
  return body;
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scopes: string[];
  idToken?: string;
}

function toTokens(b: Record<string, unknown>): TokenResponse {
  if (typeof b.access_token !== 'string' || !b.access_token) throw new GoogleOAuthError('invalid_response');
  const expiresIn = Number(b.expires_in);
  return {
    accessToken: b.access_token,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86_400) : 3600,
    refreshToken: typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : undefined,
    scopes: typeof b.scope === 'string' ? b.scope.split(/\s+/).filter(Boolean) : [],
    idToken: typeof b.id_token === 'string' ? b.id_token : undefined,
  };
}

export async function exchangeCode(cfg: GoogleConfig, code: string, codeVerifier: string): Promise<TokenResponse> {
  return toTokens(await postForm(cfg.endpoints.token, {
    grant_type: 'authorization_code', code, code_verifier: codeVerifier,
    client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri,
  }));
}

export async function refreshAccessToken(cfg: GoogleConfig, refreshToken: string): Promise<TokenResponse> {
  return toTokens(await postForm(cfg.endpoints.token, {
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret,
  }));
}

/** Best effort (disconnect / unwanted grant): revoking a refresh token also ends its access tokens. */
export async function revokeToken(cfg: GoogleConfig, token: string): Promise<boolean> {
  try { await postForm(cfg.endpoints.revoke, { token }); return true; } catch { return false; }
}

/**
 * Claims of an id_token received DIRECTLY from Google's token endpoint over TLS (server-to-server): per Google's
 * OpenID Connect guide its signature need not be re-verified, but issuer, audience and expiry are still checked.
 * `sub` is the stable account id; the e-mail is shown to the user only.
 */
export function parseIdToken(cfg: GoogleConfig, idToken: string | undefined, now = Date.now()): { sub: string; email: string } {
  const part = idToken?.split('.')[1];
  if (!part) throw new GoogleOAuthError('missing_id_token');
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { throw new GoogleOAuthError('invalid_id_token'); }
  const iss = c.iss;
  const aud = c.aud;
  const exp = Number(c.exp);
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') throw new GoogleOAuthError('invalid_id_token');
  if (aud !== cfg.clientId) throw new GoogleOAuthError('invalid_id_token');
  if (!Number.isFinite(exp) || exp * 1000 < now - 60_000) throw new GoogleOAuthError('invalid_id_token');
  if (typeof c.sub !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.sub)) throw new GoogleOAuthError('invalid_id_token');
  if (typeof c.email !== 'string' || c.email_verified === false || c.email.length > 320) throw new GoogleOAuthError('invalid_id_token');
  return { sub: c.sub, email: c.email };
}

/** Granular consent: the user may untick Drive on Google's screen; the token response says what was granted. */
export function hasDriveScope(scopes: string[]): boolean {
  return scopes.includes(DRIVE_FILE_SCOPE);
}
