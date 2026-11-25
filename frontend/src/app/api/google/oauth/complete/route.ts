import { NextRequest, NextResponse } from 'next/server';
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, OAUTH_RESULT_COOKIE } from '../../../../../lib/google/config';
import { open, seal, sha256hex, tokenAad } from '../../../../../lib/google/crypto';
import { exchangeCode, GoogleOAuthError, hasDriveScope, parseIdToken, revokeToken } from '../../../../../lib/google/oauth';
import { caller, errorResponse, NO_STORE, requireGoogle } from '../../../../../lib/google/server';

type Outcome = 'connected' | 'denied' | 'scope_denied' | 'expired' | 'conflict' | 'error';

/**
 * POST /api/google/oauth/complete -- finishes connecting a Google account, under the user's ClearSpace session.
 * The transaction must match three bindings: the signed-in user who began it, this browser's HttpOnly nonce cookie,
 * and the single-use, 10-minute state. The code is exchanged server-side with the PKCE verifier and the client
 * secret; tokens are encrypted before they reach the database. Nothing from Google's response is logged or returned.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db, userId } = await caller(req);
    const nonce = req.cookies.get(OAUTH_COOKIE)?.value ?? '';
    let result: { state?: string; code?: string; error?: string } = {};
    try { result = JSON.parse(req.cookies.get(OAUTH_RESULT_COOKIE)?.value ?? '{}'); } catch { /* malformed */ }
    const reply = (outcome: Outcome, returnTo = '/settings') => {
      const res = NextResponse.json({ outcome, returnTo }, { headers: NO_STORE });
      res.cookies.set(OAUTH_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
      res.cookies.set(OAUTH_RESULT_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
      return res;
    };
    const state = typeof result.state === 'string' ? result.state : '';
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(state) || !/^[A-Za-z0-9_-]{40,64}$/.test(nonce)) return reply('expired');

    const stateHash = sha256hex(state);
    const { data, error } = await db.rpc('google_oauth_consume', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash, p_binding_sha256: sha256hex(nonce) });
    const row = (Array.isArray(data) ? data[0] : data) as { user_id: string; code_verifier_enc: string; return_to: string } | undefined;
    if (error || !row || row.user_id !== userId) return reply('expired');
    if (result.error) return reply(result.error === 'access_denied' ? 'denied' : 'error', row.return_to);
    if (typeof result.code !== 'string' || !result.code) return reply('error', row.return_to);

    try {
      const t = await exchangeCode(cfg, result.code, open(cfg.keys, row.code_verifier_enc, tokenAad(state, 'pkce')));
      if (!hasDriveScope(t.scopes)) {
        // the user unticked Drive on Google's consent screen: keep nothing, give the grant back
        await revokeToken(cfg, t.refreshToken ?? t.accessToken);
        await db.rpc('google_oauth_audit_denied', { p_server_secret: cfg.serverSecret, p_state_sha256: stateHash });
        return reply('scope_denied', row.return_to);
      }
      const id = parseIdToken(cfg, t.idToken);
      const { error: saveErr } = await db.rpc('google_oauth_complete', {
        p_server_secret: cfg.serverSecret,
        p_state_sha256: stateHash,
        p_sub: id.sub,
        p_email: id.email,
        p_scopes: t.scopes,
        p_refresh_token_enc: t.refreshToken ? seal(cfg.keys, t.refreshToken, tokenAad(userId, 'refresh')) : null,
        p_access_token_enc: seal(cfg.keys, t.accessToken, tokenAad(userId, 'access')),
        p_access_expires_at: new Date(Date.now() + t.expiresIn * 1000).toISOString(),
      });
      if (saveErr) {
        // Same Google account already connected to another ClearSpace account: do NOT revoke -- a revocation at
        // Google ends the app's whole grant for that Google account, i.e. also the other (legitimate) connection.
        if (saveErr.code === '23505') return reply('conflict', row.return_to);
        await revokeToken(cfg, t.refreshToken ?? t.accessToken);   // nothing stored: no orphaned live grant
        return reply('error', row.return_to);
      }
      return reply('connected', row.return_to);
    } catch (err) {
      console.warn('[google-oauth-complete] failed:', err instanceof GoogleOAuthError ? err.code : (err as Error)?.name);
      return reply('error', row.return_to);
    }
  } catch (err) {
    return errorResponse(err, 'google-oauth-complete');
  }
}
